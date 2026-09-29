// The one place a room document lives. The browser and `svre` (agents) are both clients:
// they send ops, the store validates and logs them, persists the project file, and tells
// every client what changed. Nothing else writes a project or a compiled room file.
//
// On disk, per room, inside the mod:
//   rooms/<name>.room.json       the project (base + log + notes); written on every change
//   rooms/<name>.compiled.json   the compiled snapshot; written only by compile()/adopt/import
//   <Mod>.Rooms.g.cs             GENERATED: every snapshot as a const + RegisterAll();
//                                self-healed from the snapshots (see server/roomsgen.ts)
//
// "dirty" = the log has moved past the last compile. "drift" = the compiled snapshot on
// disk is not what we last compiled (a generator ran, someone hand-edited it): the store
// never overwrites it silently; adoptExternal() turns the difference into a logged entry.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, gridText, lint, walkGrid, type Knowledge } from "../src/core/analysis.ts";
import { diffRooms, verifyDiff } from "../src/core/diff.ts";
import { applyAll, maxInstanceId, normalize, OpError, touchedIds, type Op } from "../src/core/ops.ts";
import {
  canonical, compile, headRev, parseProject, PROJECT_FORMAT, serializeProject,
  type Entry, type Note, type Project, type ReplayProblem,
} from "../src/core/project.ts";
import { cloneRoom, CELL, LayerType, serializeRoom, styleOf, type Room, type RoomInstance } from "../src/core/room.ts";
import { manifestPath } from "./modassets.ts";
import { roomsCsPath, syncRoomsCs } from "./roomsgen.ts";
import type { SvreConfig } from "./api.ts";

const sha1 = (s: string | Buffer) => crypto.createHash("sha1").update(s).digest("hex");
const now = () => new Date().toISOString();

export class HttpError extends Error {
  status: number;
  extra?: unknown;
  constructor(status: number, message: string, extra?: unknown) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

interface Doc {
  name: string;
  project: Project;
  projectHash: string; // sha1 of the project file as we last wrote or read it
  base: Room;
  baseChanged: boolean;
  room: Room; // base + log
  problems: ReplayProblem[];
  redo: Map<string, Entry[]>; // per author
  selection: Map<string, { ids: number[]; at: string }>; // per author
}

export type Emit = (event: Record<string, unknown>) => void;

export class Store {
  private docs = new Map<string, Doc>();
  private know: Knowledge | null = null;
  private vanillaIndex: Record<string, string> | null = null;

  private cfg: SvreConfig;
  private emit: Emit;
  constructor(cfg: SvreConfig, emit: Emit) {
    this.cfg = cfg;
    this.emit = emit;
  }

  // ---------------- paths ----------------

  get roomsDir() { return path.join(this.cfg.modDir, "rooms"); }
  get codesDir() { return path.join(this.cfg.modDir, "Codes"); }
  projectPath(name: string) { return path.join(this.roomsDir, `${name}.room.json`); }
  compiledPath(name: string) { return path.join(this.roomsDir, `${name}.compiled.json`); }
  // legacy room artifacts (generator era, other modders' mods): import candidates only
  codesPath(name: string) { return path.join(this.codesDir, `${name}.gml`); }
  vanillaPath(name: string) { return path.join(this.cfg.assetsDir, "rooms", `${name}.json`); }

  // ---------------- knowledge (for rules) ----------------

  knowledge(): Knowledge {
    if (!this.know) {
      const objects = JSON.parse(fs.readFileSync(path.join(this.cfg.assetsDir, "objects.json"), "utf8"));
      const codeText = (name: string) => {
        for (const p of [path.join(this.codesDir, `${name}.gml`), path.join(this.cfg.sourceDir, `${name}.gml`)])
          if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
        return null;
      };
      this.know = { objects, modObjects: new Set<string>(), codeText };
    }
    // mod object names come from the manifest the editor owns (assets.json -> generated
    // C#), not from parsing the mod's C#. Tiny file, re-read per call: agents edit it
    // between calls, and lint/grid/query must see the current truth.
    const modObjects = new Set<string>();
    const mf = manifestPath(this.cfg.modDir);
    if (fs.existsSync(mf)) {
      try {
        for (const n of Object.keys(JSON.parse(fs.readFileSync(mf, "utf8")).objects ?? {})) modObjects.add(n);
      } catch { /* a broken manifest is reported by /api/mod-assets warnings */ }
    }
    this.know.modObjects = modObjects;
    return this.know;
  }

  // ---------------- listing ----------------

  listRooms() {
    const names = new Set<string>();
    if (fs.existsSync(this.roomsDir)) for (const f of fs.readdirSync(this.roomsDir)) if (f.endsWith(".room.json")) names.add(f.slice(0, -".room.json".length));
    for (const f of fs.readdirSync(this.codesDir)) if (f.endsWith(".gml") && isRoomFile(path.join(this.codesDir, f))) names.add(f.slice(0, -4));
    const owners = generatorsOf(this.cfg.modDir);
    return [...names].sort().map((name) => {
      const hasProject = fs.existsSync(this.projectPath(name));
      let dirty = false, drift = false;
      if (hasProject) {
        const d = this.open(name);
        dirty = this.isDirty(d);
        drift = this.isDrift(d);
      }
      return { name, hasProject, hasCompiled: fs.existsSync(this.compiledPath(name)) || fs.existsSync(this.codesPath(name)), dirty, drift, generatedBy: owners.get(`${name}.gml`) ?? [] };
    });
  }

  searchVanilla(q: string, limit = 40) {
    const rooms: { name: string; w: number; h: number; instances: number }[] = JSON.parse(fs.readFileSync(path.join(this.cfg.assetsDir, "rooms.json"), "utf8"));
    const s = q.toLowerCase();
    return rooms.filter((r) => r.name.toLowerCase().includes(s)).slice(0, limit);
  }

  // ---------------- open / persist ----------------

  private loadBase(p: Project): { base: Room; changed: boolean } {
    const file = "vanilla" in p.base ? this.vanillaPath(p.base.vanilla) : path.join(this.cfg.modDir, p.base.file);
    if (!fs.existsSync(file)) throw new HttpError(500, `base room not found: ${file} (run \`npm run extract:rooms\`?)`);
    const base = JSON.parse(fs.readFileSync(file, "utf8")) as Room;
    return { base, changed: sha1(canonical(base)) !== p.base.sha };
  }

  open(name: string): Doc {
    const file = this.projectPath(name);
    if (!fs.existsSync(file)) throw new HttpError(404, `no project for ${name}; import it first (svre import ${name})`);
    const text = fs.readFileSync(file, "utf8");
    const h = sha1(text);
    const cur = this.docs.get(name);
    if (cur && cur.projectHash === h) return cur;
    // first open, or the file changed under us (git checkout, another server): (re)load
    const project = parseProject(text);
    const { base, changed } = this.loadBase(project);
    const { room, problems } = compile(base, project);
    const doc: Doc = { name, project, projectHash: h, base, baseChanged: changed, room, problems, redo: cur?.redo ?? new Map(), selection: cur?.selection ?? new Map() };
    this.docs.set(name, doc);
    if (cur) this.emit({ type: "reloaded", room: name, rev: headRev(project) });
    return doc;
  }

  private persist(d: Doc) {
    fs.mkdirSync(this.roomsDir, { recursive: true });
    const text = serializeProject(d.project);
    const file = this.projectPath(d.name);
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    d.projectHash = sha1(text);
  }

  isDirty(d: Doc) {
    return !d.project.compiled || d.project.compiled.rev !== headRev(d.project) || serializeRoom(d.room, d.project.style) !== this.readCompiled(d.name);
  }

  isDrift(d: Doc) {
    const onDisk = this.readCompiled(d.name);
    return !!d.project.compiled && onDisk !== null && sha1(onDisk) !== d.project.compiled.hash;
  }

  private readCompiled(name: string): string | null {
    const f = this.compiledPath(name);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  }

  // Regenerate <Mod>.Rooms.g.cs from every compiled snapshot. All-or-nothing: a snapshot
  // whose hash no longer matches its project's compiled marker was tampered with outside
  // (drift) -- embedding it silently would launder the tampering into the build, so the
  // whole regeneration is skipped until someone compiles or adopts that room.
  syncRoomsCs(): { synced: boolean; rooms: string[]; skipped: string[] } {
    const rooms: { name: string; text: string }[] = [];
    const skipped: string[] = [];
    if (fs.existsSync(this.roomsDir))
      for (const f of fs.readdirSync(this.roomsDir).sort()) {
        if (!f.endsWith(".compiled.json")) continue;
        const name = f.slice(0, -".compiled.json".length);
        if (!fs.existsSync(this.projectPath(name))) continue;
        const d = this.open(name);
        if (!d.project.compiled) continue;
        const text = fs.readFileSync(this.compiledPath(name), "utf8");
        if (sha1(text) !== d.project.compiled.hash) { skipped.push(name); continue; }
        rooms.push({ name, text });
      }
    if (skipped.length) return { synced: false, rooms: rooms.map((r) => r.name), skipped };
    return { ...syncRoomsCs(this.cfg.modDir, rooms), skipped };
  }

  snapshot(name: string) {
    const d = this.open(name);
    const undoneRevs = new Set(d.project.log.filter((e) => e.undoOf !== undefined).map((e) => e.undoOf));
    const undoable = new Set<string>();
    for (const e of d.project.log) if (e.undoOf === undefined && !undoneRevs.has(e.rev)) undoable.add(e.by);
    return {
      name,
      rev: headRev(d.project),
      compiledRev: d.project.compiled?.rev ?? null,
      dirty: this.isDirty(d),
      drift: this.isDrift(d),
      base: d.project.base,
      baseChanged: d.baseChanged,
      problems: d.problems,
      notes: d.project.notes,
      log: d.project.log.map(summarize),
      selection: Object.fromEntries(d.selection),
      undoable: [...undoable],
      redoable: [...d.redo].filter(([, s]) => s.length).map(([by]) => by),
      room: d.room,
    };
  }

  // ---------------- changes ----------------

  apply(name: string, req: { by?: string; label?: string; note?: string; ops?: Op[] }) {
    const d = this.open(name);
    const by = (req.by ?? "").trim();
    if (!by) throw new HttpError(400, "`by` is required: who is making this change (human / agent name)");
    if (!Array.isArray(req.ops) || req.ops.length === 0) throw new HttpError(400, "`ops` must be a non-empty array");
    const room = cloneRoom(d.room);
    let nextId = Math.max(d.project.nextId, maxInstanceId(d.base) + 1, maxInstanceId(d.room) + 1);
    const logged: Op[] = [];
    try {
      for (const raw of req.ops) {
        const op = normalize(room, raw, () => nextId++);
        applyAll(room, [op]);
        logged.push(op);
      }
    } catch (e) {
      if (e instanceof OpError) throw new HttpError(409, e.message, { code: e.code, opIndex: logged.length });
      throw e;
    }
    const entry: Entry = { rev: d.project.nextRev++, by, at: now(), label: req.label?.trim() || defaultLabel(logged), ...(req.note ? { note: req.note } : {}), ops: logged };
    d.project.nextId = nextId;
    d.project.log.push(entry);
    d.room = room;
    d.redo.set(by, []);
    this.persist(d);
    this.emit({ type: "change", room: name, entry: summarize(entry) });
    // the normalized ops go back so the authoring client can replay them locally
    // (ids `add` got, expects `normalize` pinned) instead of refetching the whole room
    return { rev: entry.rev, ids: logged.flatMap(touchedIds), ops: logged, findings: this.lintOf(d) };
  }

  undo(name: string, by: string) {
    const d = this.open(name);
    const log = d.project.log;
    let idx = -1;
    for (let i = log.length - 1; i >= 0; i--) if (log[i].by === by && !isUndone(log, log[i].rev)) { idx = i; break; }
    if (idx < 0) throw new HttpError(409, `nothing of ${by}'s to undo`);
    const target = log[idx];
    let result: { rev: number | null; popped: boolean };
    if (idx === log.length - 1 && target.undoOf === undefined) {
      // still the tail: take it off the log entirely (keeps solo undo from littering history)
      log.pop();
      d.room = compile(d.base, d.project).room;
      result = { rev: null, popped: true };
    } else {
      // someone changed things after it: undo by appending the inverse, never by rewriting history
      const room = cloneRoom(d.room);
      let inverse: Op[];
      try {
        // the inverse as of the moment `target` was applied (its expects pin that state),
        // then applied to now: if later changes moved the same things, the expects fail
        const then = cloneRoom(d.base);
        for (const e of log.slice(0, idx)) applyAll(then, e.ops);
        inverse = applyAll(then, target.ops);
        applyAll(room, inverse);
      } catch (e) {
        throw new HttpError(409, `cannot undo rev ${target.rev}: later changes touched the same instances (${(e as Error).message})`);
      }
      const entry: Entry = { rev: d.project.nextRev++, by, at: now(), label: `撤销：${target.label}`, ops: inverse, undoOf: target.rev };
      log.push(entry);
      d.room = room;
      result = { rev: entry.rev, popped: false };
    }
    const stack = d.redo.get(by) ?? [];
    stack.push(target);
    d.redo.set(by, stack);
    this.persist(d);
    this.emit({ type: "undo", room: name, by, undone: target.rev, rev: result.rev });
    return { undone: target.rev, ...result };
  }

  redo(name: string, by: string) {
    const d = this.open(name);
    const stack = d.redo.get(by) ?? [];
    const entry = stack.pop();
    if (!entry) throw new HttpError(409, `nothing of ${by}'s to redo`);
    const room = cloneRoom(d.room);
    try {
      applyAll(room, entry.ops);
    } catch (e) {
      stack.push(entry);
      throw new HttpError(409, `cannot redo "${entry.label}": ${(e as Error).message}`);
    }
    const again: Entry = { ...entry, rev: d.project.nextRev++, at: now() };
    delete again.undoOf;
    d.project.log.push(again);
    d.room = room;
    this.persist(d);
    this.emit({ type: "change", room: name, entry: summarize(again) });
    return { rev: again.rev };
  }

  changes(name: string, since: number) {
    const d = this.open(name);
    const entries = d.project.log.filter((e) => e.rev > since);
    const present = new Set(d.project.log.map((e) => e.rev));
    const undone: number[] = [];
    for (let r = since + 1; r < d.project.nextRev; r++) if (!present.has(r)) undone.push(r);
    return { head: headRev(d.project), nextRev: d.project.nextRev, entries, undone };
  }

  // ---------------- compile / drift ----------------

  compileRoom(name: string, force = false) {
    const d = this.open(name);
    if (d.problems.length) throw new HttpError(409, `the log does not replay cleanly on the base (${d.problems.length} problem(s)); fix them first`, d.problems);
    if (this.isDrift(d) && !force)
      throw new HttpError(409, `rooms/${name}.compiled.json changed outside the editor since the last compile; adopt it first (svre adopt ${name}) or pass force`);
    const text = serializeRoom(d.room, d.project.style);
    const file = this.compiledPath(name);
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    d.project.compiled = { rev: headRev(d.project), hash: sha1(text) };
    this.persist(d);
    const cs = this.syncRoomsCs();
    this.emit({ type: "compiled", room: name, rev: d.project.compiled.rev });
    return { file: path.relative(this.cfg.modDir, file).replace(/\\/g, "/"), roomsCs: path.basename(roomsCsPath(this.cfg.modDir)), roomsCsSynced: cs.synced, roomsCsSkipped: cs.skipped, rev: d.project.compiled.rev, findings: this.lintOf(d) };
  }

  adoptExternal(name: string, by = "external") {
    const d = this.open(name);
    const disk = this.readCompiled(name);
    if (disk === null) throw new HttpError(404, `rooms/${name}.compiled.json does not exist`);
    const target = JSON.parse(disk) as Room;
    let ops: Op[];
    try {
      ops = diffRooms(d.room, target);
    } catch (e) {
      throw new HttpError(409, `cannot express the external change as ops: ${(e as Error).message}`);
    }
    if (!verifyDiff(d.room, target, ops)) throw new HttpError(500, "diff did not reproduce the file; refusing");
    if (ops.length) {
      const entry: Entry = { rev: d.project.nextRev++, by, at: now(), label: `编辑器外的改动（${ops.length} 个操作）`, ops };
      d.project.log.push(entry);
      d.room = target;
      this.emit({ type: "change", room: name, entry: summarize(entry) });
    }
    d.project.compiled = { rev: headRev(d.project), hash: sha1(disk) };
    this.persist(d);
    this.syncRoomsCs();
    return { ops: ops.length, rev: headRev(d.project) };
  }

  // ---------------- import / create ----------------

  // Turn an existing compiled room (made by a generator, by hand, ...) into a project whose
  // log reproduces it byte for byte. The source is a legacy Codes/<name>.gml room artifact;
  // the project's own compiled snapshot becomes rooms/<name>.compiled.json from then on.
  // The base is found from the instance ids it still carries -- GameMaker instance ids are
  // global in a data file.
  importRoom(name: string, opts: { base?: string; by?: string }) {
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new HttpError(400, `${name} is not a valid C# identifier (it becomes a const in <Mod>.Rooms.g.cs)`);
    if (fs.existsSync(this.projectPath(name))) throw new HttpError(409, `${name} already has a project`);
    const text = fs.existsSync(this.codesPath(name)) ? fs.readFileSync(this.codesPath(name), "utf8") : null;
    if (text === null) throw new HttpError(404, `Codes/${name}.gml does not exist (import turns a legacy compiled artifact into a project; for a vanilla base use create)`);
    const target = JSON.parse(text) as Room;
    const baseName = opts.base ?? this.guessBase(target);
    if (!baseName) throw new HttpError(409, "could not tell which vanilla room this came from; pass base");
    const base = JSON.parse(fs.readFileSync(this.vanillaPath(baseName), "utf8")) as Room;
    let ops: Op[];
    try {
      ops = diffRooms(base, target);
    } catch (e) {
      throw new HttpError(409, `cannot import: ${(e as Error).message}`);
    }
    if (!verifyDiff(base, target, ops)) throw new HttpError(500, "diff did not reproduce the file; refusing to import");
    const project: Project = {
      format: PROJECT_FORMAT, output: name, base: { vanilla: baseName, sha: sha1(canonical(base)) }, style: styleOf(text),
      nextRev: 2, nextId: Math.max(maxInstanceId(base), maxInstanceId(target)) + 1, compiled: null, notes: [],
      log: [{ rev: 1, by: opts.by ?? "import", at: now(), label: `导入：从 ${baseName} 到现有的 Codes/${name}.gml`, ops }],
    };
    const d: Doc = { name, project, projectHash: "", base, baseChanged: false, room: compile(base, project, true).room, problems: [], redo: new Map(), selection: new Map() };
    if (serializeRoom(d.room, project.style) !== text) throw new HttpError(500, "import does not compile back to the same bytes; refusing");
    project.compiled = { rev: 1, hash: sha1(text) };
    const file = this.compiledPath(name);
    fs.mkdirSync(this.roomsDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, text);
    fs.renameSync(`${file}.tmp`, file);
    this.docs.set(name, d);
    this.persist(d);
    this.syncRoomsCs();
    this.emit({ type: "created", room: name });
    return { name, base: baseName, ops: ops.length };
  }

  guessBase(room: Room): string | null {
    if (!this.vanillaIndex) this.vanillaIndex = JSON.parse(fs.readFileSync(path.join(this.cfg.assetsDir, "rooms", "_index.json"), "utf8"));
    const votes = new Map<string, number>();
    for (const L of room.layers) if (L.layer_type === LayerType.Instances) for (const i of L.layer_data.instances as RoomInstance[]) {
      const r = this.vanillaIndex![String(i.instance_id)];
      if (r) votes.set(r, (votes.get(r) ?? 0) + 1);
    }
    return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }

  // A new room on a vanilla base. keep = "all" copies it; "controllers" keeps only what
  // every room needs to work (camera, controllers, starters/doors are yours to place).
  createRoom(name: string, opts: { base: string; keep?: "all" | "controllers"; by?: string }) {
    if (!/^r_[A-Za-z0-9_]+$/.test(name)) throw new HttpError(400, "room names look like r_something");
    if (fs.existsSync(this.projectPath(name)) || fs.existsSync(this.codesPath(name)) || fs.existsSync(this.compiledPath(name))) throw new HttpError(409, `${name} already exists`);
    if (!fs.existsSync(this.vanillaPath(opts.base))) throw new HttpError(404, `no vanilla room ${opts.base}`);
    const base = JSON.parse(fs.readFileSync(this.vanillaPath(opts.base), "utf8")) as Room;
    const ops: Op[] = [{ op: "room", set: { name }, expect: { name: base.name } }];
    if (opts.keep === "controllers") {
      const keepLayers = /controller|camera/i;
      for (const L of base.layers) {
        if (L.layer_type !== LayerType.Instances || keepLayers.test(L.layer_name ?? "")) continue;
        for (const i of L.layer_data.instances as RoomInstance[]) ops.push({ op: "delete", id: i.instance_id, expect: { object_definition: i.object_definition, x: i.x, y: i.y } });
      }
    }
    const project: Project = {
      format: PROJECT_FORMAT, output: name, base: { vanilla: opts.base, sha: sha1(canonical(base)) }, style: { crlf: false, finalNewline: true },
      nextRev: 2, nextId: maxInstanceId(base) + 1, compiled: null, notes: [],
      log: [{ rev: 1, by: opts.by ?? "human", at: now(), label: opts.keep === "controllers" ? `新建：${opts.base} 的骨架（只留控制器）` : `新建：复制 ${opts.base}`, ops }],
    };
    const d: Doc = { name, project, projectHash: "", base, baseChanged: false, room: compile(base, project, true).room, problems: [], redo: new Map(), selection: new Map() };
    this.docs.set(name, d);
    this.persist(d);
    this.emit({ type: "created", room: name });
    return { name };
  }

  // ---------------- notes / selection ----------------

  addNote(name: string, n: { by: string; x: number; y: number; text: string }) {
    const d = this.open(name);
    if (!n.by || !n.text) throw new HttpError(400, "note needs by and text");
    const note: Note = { id: crypto.randomBytes(4).toString("hex"), by: n.by, at: now(), x: Math.round(n.x), y: Math.round(n.y), text: n.text };
    d.project.notes.push(note);
    this.persist(d);
    this.emit({ type: "notes", room: name, by: n.by });
    return note;
  }

  removeNote(name: string, id: string) {
    const d = this.open(name);
    const note = d.project.notes.find((n) => n.id === id);
    if (!note) throw new HttpError(404, `no note ${id}`);
    d.project.notes = d.project.notes.filter((n) => n.id !== id);
    this.persist(d);
    this.emit({ type: "notes", room: name, by: note.by });
    return { removed: id };
  }

  setSelection(name: string, by: string, ids: number[]) {
    const d = this.open(name);
    d.selection.set(by, { ids, at: now() });
    this.emit({ type: "selection", room: name, by, ids });
    return { by, ids };
  }

  selectionOf(name: string) {
    const d = this.open(name);
    return Object.fromEntries(
      [...d.selection].map(([by, s]) => [by, { ...s, instances: s.ids.map((id) => instanceBrief(d.room, id)).filter(Boolean) }]),
    );
  }

  // ---------------- queries ----------------

  lintOf(d: Doc) { return lint(this.knowledge(), d.room); }
  describe(name: string) {
    const d = this.open(name);
    return { ...describe(this.knowledge(), d.room), rev: headRev(d.project), dirty: this.isDirty(d), drift: this.isDrift(d), base: d.project.base, baseChanged: d.baseChanged, problems: d.problems, notes: d.project.notes };
  }
  grid(name: string, region?: string) {
    const d = this.open(name);
    const k = this.knowledge();
    const g = walkGrid(k, d.room);
    let r: { x0: number; y0: number; x1: number; y1: number } | undefined;
    if (region) {
      const [x0, y0, x1, y1] = region.split(",").map(Number);
      if ([x0, y0, x1, y1].some((v) => !Number.isFinite(v))) throw new HttpError(400, "region = x0,y0,x1,y1 in cells");
      r = { x0, y0, x1, y1 };
    }
    return gridText(k, d.room, g, r);
  }
  query(name: string, q: { id?: string; object?: string; layer?: string; rect?: string; cell?: string; limit?: string }) {
    const d = this.open(name);
    const rect = q.rect?.split(",").map(Number);
    const cell = q.cell?.split(",").map(Number);
    const out: unknown[] = [];
    d.room.layers.forEach((L) => {
      if (L.layer_type !== LayerType.Instances) return;
      if (q.layer && L.layer_name !== q.layer) return;
      for (const i of L.layer_data.instances as RoomInstance[]) {
        if (q.id && String(i.instance_id) !== q.id) continue;
        if (q.object && !(i.object_definition ?? "").includes(q.object)) continue;
        if (rect && !(i.x >= rect[0] && i.y >= rect[1] && i.x < rect[2] && i.y < rect[3])) continue;
        if (cell && !(Math.floor(i.x / CELL) === cell[0] && Math.floor(i.y / CELL) === cell[1])) continue;
        out.push({ layer: L.layer_name, ...i, cell: [Math.floor(i.x / CELL), Math.floor(i.y / CELL)] });
      }
    });
    return out.slice(0, Number(q.limit ?? 500));
  }
}

// ---------------- helpers ----------------

function isUndone(log: Entry[], rev: number) {
  return log.some((e) => e.undoOf === rev);
}

function summarize(e: Entry) {
  return { rev: e.rev, by: e.by, at: e.at, label: e.label, note: e.note, undoOf: e.undoOf, ops: e.ops.length, ids: [...new Set(e.ops.flatMap(touchedIds))] };
}

function defaultLabel(ops: Op[]): string {
  const kinds: Record<string, number> = {};
  for (const o of ops) kinds[o.op] = (kinds[o.op] ?? 0) + 1;
  const zh: Record<string, string> = { add: "添加", delete: "删除", set: "修改", relayer: "换图层", room: "改房间属性", layer: "改图层属性" };
  return Object.entries(kinds).map(([k, n]) => `${zh[k] ?? k} ${n}`).join("，");
}

function instanceBrief(room: Room, id: number) {
  for (const L of room.layers)
    if (L.layer_type === LayerType.Instances)
      for (const i of L.layer_data.instances as RoomInstance[])
        if (i.instance_id === id) return { id, object: i.object_definition, x: i.x, y: i.y, layer: L.layer_name };
  return null;
}

export function isRoomFile(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    return /^\s*\{\s*"name"\s*:/.test(buf.subarray(0, n).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// generator scripts under <modDir>/tools that name a room file are taken to own it
export function generatorsOf(modDir: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const toolsDir = path.join(modDir, "tools");
  if (!fs.existsSync(toolsDir)) return owners;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(full); continue; }
      if (!/\.(py|mjs|js|ts|csx)$/.test(e.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(/r_[A-Za-z0-9_]+(?:\.gml)?/g)) {
        const f = m[0].endsWith(".gml") ? m[0] : `${m[0]}.gml`;
        const rel = path.relative(modDir, full).replace(/\\/g, "/");
        const list = owners.get(f) ?? [];
        if (!list.includes(rel)) list.push(rel);
        owners.set(f, list);
      }
    }
  };
  walk(toolsDir);
  return owners;
}
