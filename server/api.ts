// Dev-server middleware: the HTTP face of the Store (server/store.ts), shared by the
// browser and the `svre` CLI. Events (who changed what) go out on Vite's websocket as
// the custom event "svre:event"; the CLI polls /changes instead.
//
//   GET  /api/rooms                         every room: project? compiled? dirty? drift?
//   GET  /api/vanilla?q=                    search vanilla rooms (bases)
//   GET  /api/vanilla-doc/<room>            a vanilla cache room for read-only viewing (no project)
//   POST /api/import      {name, base?, by?} project from an existing Codes/<name>.gml
//   POST /api/create      {name, base, keep?, by?}  new room on a vanilla base
//   GET  /api/doc/<room>                    full state: room JSON, log summary, notes, selections
//   POST /api/doc/<room>/apply   {by, label?, note?, ops}
//   POST /api/doc/<room>/undo    {by}        /redo {by}
//   GET  /api/doc/<room>/changes?since=N
//   POST /api/doc/<room>/compile {force?}    write rooms/<room>.compiled.json + regenerate <Mod>.Rooms.g.cs
//   POST /api/doc/<room>/adopt   {by?}       log an outside edit of rooms/<room>.compiled.json
//   GET  /api/doc/<room>/describe | lint | grid?region= | query?id=&object=&layer=&rect=&cell=
//   POST /api/doc/<room>/notes   {by, x, y, text} | {remove}
//   GET|POST /api/doc/<room>/selection  {by, ids}
//   GET  /assets/<path>                     the extracted asset cache (vanilla, from data.win)
//   GET  /api/mod-assets                    the mod's own sprites/objects (Sprites/*.png + assets.json)
//   POST /api/mod-assets/sync               rescan + rewrite <Mod>.Assets.g.cs if it disagrees
//   GET  /mod-assets/pages/<i>.png          one mod sprite frame (pseudo pages, see modassets.ts)
import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { generatedCsPath, loadManifest, pngSizeBuffer, saveManifest, scanModAssets, type ModAssets, type VanillaNames } from "./modassets.ts";
import { HttpError, Store } from "./store.ts";

export interface SvreConfig {
  modDir: string;
  assetsDir: string;
  sourceDir: string;
  vanillaWin: string;
  utmtCli: string;
}

export function loadConfig(root: string): SvreConfig {
  const base = JSON.parse(fs.readFileSync(path.join(root, "svre.config.json"), "utf8"));
  const localFile = path.join(root, "svre.config.local.json");
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {};
  const cfg = { ...base, ...local };
  // relative config paths resolve against the repo root, so renaming the editor
  // folder (or launching the electron shell from another cwd) never breaks them
  for (const key of ["modDir", "assetsDir", "sourceDir", "vanillaWin", "utmtCli"] as const)
    if (cfg[key] && !path.isAbsolute(cfg[key])) cfg[key] = path.resolve(root, cfg[key]);
  // tests point a second server at a scratch copy of a mod, never at the real one
  if (process.env.SVRE_MOD_DIR) cfg.modDir = process.env.SVRE_MOD_DIR;
  return cfg;
}

const MIME: Record<string, string> = { ".png": "image/png", ".json": "application/json", ".webp": "image/webp" };

function send(res: any, status: number, body: unknown, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new HttpError(400, "body is not JSON")); }
    });
    req.on("error", reject);
  });
}

export interface SvreApi {
  cfg: SvreConfig;
  handler: Connect.NextHandleFunction;
  // store events (who changed what); vite wires this to its ws, the standalone
  // server to its SSE channel
  setEmit: (cb: (e: Record<string, unknown>) => void) => void;
}

export function createApi(root: string): SvreApi {
  const cfg = loadConfig(root);
  let emit: (e: Record<string, unknown>) => void = () => {};
  const store = new Store(cfg, (e) => emit({ ...e, at: new Date().toISOString() }));
  // vanilla name pools, for manifest validation (object sprites/parents may be vanilla)
  const vanillaNames: VanillaNames = {
    objects: new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(cfg.assetsDir, "objects.json"), "utf8")))),
    sprites: new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(cfg.assetsDir, "sprites.json"), "utf8")))),
  };
  // the page index a client got from /api/mod-assets must stay valid for the session,
  // so pages are served from the last scan the client could have seen
  let modScan: ModAssets = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
  // <Mod>.Rooms.g.cs self-heals from the compiled snapshots at startup (and on every
  // compile/import/adopt from inside store.ts); a drifted snapshot blocks the regen
  // instead of being laundered into the build
  const csHeal = store.syncRoomsCs();
  if (csHeal.skipped.length) console.warn(`Rooms.g.cs NOT regenerated: drifted snapshots: ${csHeal.skipped.join(", ")}`);
  else if (csHeal.synced) console.log(`Rooms.g.cs regenerated (${csHeal.rooms.length} rooms)`);

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const [rawPath, qs] = (req.url ?? "").split("?");
    const url = decodeURIComponent(rawPath);
    const q = Object.fromEntries(new URLSearchParams(qs ?? ""));
    const method = req.method ?? "GET";
    try {
      if (url === "/api/config") return send(res, 200, cfg);
      if (url === "/api/rooms") return send(res, 200, store.listRooms());
      if (url === "/api/vanilla") return send(res, 200, store.searchVanilla(q.q ?? ""));
      const vd = /^\/api\/vanilla-doc\/([A-Za-z0-9_]+)$/.exec(url);
      if (vd && method === "GET") return send(res, 200, store.vanillaDoc(vd[1]));
      if (url === "/api/mod-assets") {
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        return send(res, 200, { sprites: modScan.sprites, objects: modScan.objects, pages: modScan.pages.length, warnings: modScan.warnings, synced: modScan.synced });
      }
      if (url === "/api/mod-assets/sync" && method === "POST") {
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        return send(res, 200, { file: path.basename(generatedCsPath(cfg.modDir)), warnings: modScan.warnings, synced: modScan.synced });
      }
      // the artist flow: draw PNG(s) -> register sprite+object -> place. Writes
      // Sprites/*.png, extends assets.json, then the usual scan self-heals the .g.cs
      if (url === "/api/mod-assets/import-sprite" && method === "POST") {
        const b = await readJson(req);
        // fresh scan first: validation must see the disk as it is, not the last GET's state
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        const ident = /^[A-Za-z_]\w*$/;
        const sprite = String(b.sprite ?? "");
        const object = String(b.object ?? "");
        if (!ident.test(sprite)) throw new HttpError(400, `sprite 名不合法（字母/数字/下划线，字母或下划线开头）：${sprite || "(空)"}`);
        if (!ident.test(object)) throw new HttpError(400, `对象名不合法：${object || "(空)"}`);
        if (vanillaNames.sprites.has(sprite)) throw new HttpError(409, `sprite ${sprite} 与原版重名，换个名字`);
        if (vanillaNames.objects.has(object)) throw new HttpError(409, `对象 ${object} 与原版重名，换个名字`);
        if (modScan.sprites[sprite]) throw new HttpError(409, `Sprites/ 里已有 ${sprite}（换图直接替换文件；加帧放 ${sprite}_N.png 后 sync）`);
        if (modScan.objects[object]) throw new HttpError(409, `assets.json 已注册对象 ${object}`);
        const frames: { buf: Buffer; w: number; h: number }[] = [];
        for (const f of Array.isArray(b.frames) ? b.frames : []) {
          const buf = Buffer.from(String((f as { data?: unknown } | null)?.data ?? ""), "base64");
          const size = pngSizeBuffer(buf);
          if (!size) throw new HttpError(400, "有文件不是合法的 PNG");
          frames.push({ buf, ...size });
        }
        if (!frames.length) throw new HttpError(400, "至少要选一帧 PNG");
        if (!frames.every((f) => f.w === frames[0].w && f.h === frames[0].h)) throw new HttpError(400, "多帧的尺寸必须一致");
        const { manifest } = loadManifest(cfg.modDir);
        const parent = b.parent ? String(b.parent) : undefined;
        if (parent && !vanillaNames.objects.has(parent) && !manifest.objects[parent])
          throw new HttpError(400, `parent ${parent} 不在原版对象表里`);
        const origin = b.origin !== undefined ? [Number(b.origin[0]), Number(b.origin[1])] as [number, number] : undefined;
        if (origin && (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1]))) throw new HttpError(400, "origin 必须是两个数字");
        const note = b.note ? String(b.note) : undefined;

        const dir = path.join(cfg.modDir, "Sprites");
        fs.mkdirSync(dir, { recursive: true });
        const files: string[] = [];
        frames.forEach((f, i) => {
          const name = frames.length === 1 ? `${sprite}.png` : `${sprite}_${i}.png`;
          fs.writeFileSync(path.join(dir, name), f.buf);
          files.push(name);
        });
        if (origin) manifest.sprites[sprite] = { origin };
        manifest.objects[object] = { sprite, ...(parent ? { parent } : {}), visible: b.visible === undefined ? true : !!b.visible, ...(note ? { note } : {}) };
        saveManifest(cfg.modDir, manifest);
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        emit({ type: "assets", by: String(b.by ?? "human"), sprite, object });
        return send(res, 200, { ok: true, files, warnings: modScan.warnings, synced: modScan.synced });
      }
      const pm = /^\/mod-assets\/pages\/(\d+)\.png$/.exec(url);
      if (pm) {
        const file = modScan.pages[Number(pm[1])];
        if (!file || !fs.existsSync(file)) return send(res, 404, "no such mod sprite page", "text/plain");
        res.setHeader("Cache-Control", "no-store"); // mod art changes while developing
        return send(res, 200, fs.readFileSync(file), "image/png");
      }
      if (url === "/api/import" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, store.importRoom(b.name, { base: b.base, by: b.by }));
      }
      if (url === "/api/create" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, store.createRoom(b.name, { base: b.base, keep: b.keep, by: b.by }));
      }

      const m = /^\/api\/doc\/([A-Za-z0-9_]+)(?:\/([a-z]+))?$/.exec(url);
      if (m) {
        const [, room, action] = m;
        if (!action && method === "GET") return send(res, 200, store.snapshot(room));
        const body = method === "POST" ? await readJson(req) : {};
        switch (action) {
          case "apply": return send(res, 200, store.apply(room, body));
          case "undo": return send(res, 200, store.undo(room, body.by));
          case "redo": return send(res, 200, store.redo(room, body.by));
          case "changes": return send(res, 200, store.changes(room, Number(q.since ?? 0)));
          case "compile":
            // compiling a room means the next pack reads it; make sure the generated
            // asset registrations are current too (self-heals when assets.json changed)
            modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
            return send(res, 200, store.compileRoom(room, !!body.force));
          case "adopt": return send(res, 200, store.adoptExternal(room, body.by));
          case "describe": return send(res, 200, store.describe(room));
          case "lint": return send(res, 200, store.describe(room).findings);
          case "grid": return send(res, 200, store.grid(room, q.region), "text/plain; charset=utf-8");
          case "query": return send(res, 200, store.query(room, q));
          case "notes":
            if (method !== "POST") return send(res, 200, store.snapshot(room).notes);
            return send(res, 200, body.remove ? store.removeNote(room, body.remove) : store.addNote(room, body));
          case "selection":
            if (method === "POST") return send(res, 200, store.setSelection(room, body.by, body.ids ?? []));
            return send(res, 200, store.selectionOf(room));
        }
        return send(res, 404, { error: `unknown action ${action}` });
      }

      if (url.startsWith("/assets/")) {
        const rel = path.normalize(url.slice("/assets/".length));
        const full = path.join(cfg.assetsDir, rel);
        if (!full.startsWith(path.normalize(cfg.assetsDir)) || !fs.existsSync(full))
          return send(res, 404, "asset not found -- run the extract step (README)", "text/plain");
        res.setHeader("Cache-Control", "max-age=86400");
        return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] ?? "application/octet-stream");
      }
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, detail: e.extra });
      console.error(e);
      return send(res, 500, { error: (e as Error).message });
    }
    next();
  };

  return { cfg, handler, setEmit: (cb) => { emit = cb; } };
}

export function svreApi(root: string): Plugin {
  const { handler, setEmit } = createApi(root);
  return {
    name: "svre-api",
    configureServer(server) {
      setEmit((e) => server.ws.send("svre:event", e));
      server.middlewares.use(handler);
    },
  };
}
