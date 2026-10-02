// What a room means in game terms, computed from its data: the walking grid, where the
// doors lead, and the rules a room has to satisfy. Shared by the canvas overlays, the
// `svre grid/describe/lint` commands and the server's post-apply checks -- a human and an
// agent are held to exactly the same rules.
import { CELL, LayerType, type Room, type RoomInstance } from "./room.ts";

export interface ObjInfo { parent?: string; sprite?: string }

export interface Knowledge {
  objects: Record<string, ObjInfo>; // vanilla objects (objects.json)
  modObjects: Set<string>; // objects the mod registers with Msl.AddObject
  codeText: (name: string) => string | null; // creation code body, or null if the name resolves nowhere
}

export function descends(k: Knowledge, name: string | null, root: string): boolean {
  for (let n: string | undefined = name ?? undefined, guard = 0; n && guard < 40; n = k.objects[n]?.parent, guard++) if (n === root) return true;
  return false;
}

export const isCollisionStamp = (o: string | null) => o === "o_hut_wall";
export const isStarter = (k: Knowledge, o: string | null) => descends(k, o, "o_position_starter");
export const isTransition = (k: Knowledge, o: string | null) => descends(k, o, "o_transitions_door");
export const isFurniture = (k: Knowledge, o: string | null) => descends(k, o, "o_stuff");

const cellOf = (v: number) => Math.floor(v / CELL);

// ---------------- walking grid ----------------

export interface Grid {
  w: number;
  h: number;
  blocked: Uint8Array; // o_hut_wall stamps: o_hut_wall_Alarm_0 writes xscale x yscale cells from (x div 26, y div 26)
  reach: Uint8Array; // 4-connected flood fill from every starter over unblocked cells
  starters: { id: number; gx: number; gy: number }[];
}

export function walkGrid(k: Knowledge, room: Room): Grid {
  const w = Math.ceil(room.width / CELL), h = Math.ceil(room.height / CELL);
  const blocked = new Uint8Array(w * h), reach = new Uint8Array(w * h);
  const starters: Grid["starters"] = [];
  for (const L of room.layers) {
    if (L.layer_type !== LayerType.Instances) continue;
    for (const i of L.layer_data.instances as RoomInstance[]) {
      if (isCollisionStamp(i.object_definition)) {
        const gx = cellOf(i.x), gy = cellOf(i.y);
        for (let dy = 0; dy < Math.round(i.scale_y); dy++)
          for (let dx = 0; dx < Math.round(i.scale_x); dx++) {
            const x = gx + dx, y = gy + dy;
            if (x >= 0 && y >= 0 && x < w && y < h) blocked[y * w + x] = 1;
          }
      } else if (isStarter(k, i.object_definition)) {
        starters.push({ id: i.instance_id, gx: cellOf(i.x), gy: cellOf(i.y) });
      }
    }
  }
  const stack: number[] = [];
  for (const s of starters) {
    if (s.gx < 0 || s.gy < 0 || s.gx >= w || s.gy >= h) continue;
    const c = s.gy * w + s.gx;
    if (!blocked[c] && !reach[c]) { reach[c] = 1; stack.push(c); }
  }
  while (stack.length) {
    const c = stack.pop()!;
    const x = c % w, y = (c - x) / w;
    for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!blocked[n] && !reach[n]) { reach[n] = 1; stack.push(n); }
    }
  }
  return { w, h, blocked, reach, starters };
}

// Text map for agents. One char per 26px cell:
//   #  collision stamp      .  walkable (reachable from a starter)      (space) not reachable
//   S  starter   D  door / ladder / transition   F  furniture (o_stuff family)
export function gridText(k: Knowledge, room: Room, g: Grid, region?: { x0: number; y0: number; x1: number; y1: number }): string {
  const marks = new Map<number, string>();
  for (const L of room.layers) {
    if (L.layer_type !== LayerType.Instances) continue;
    for (const i of L.layer_data.instances as RoomInstance[]) {
      const gx = cellOf(i.x), gy = cellOf(i.y);
      if (gx < 0 || gy < 0 || gx >= g.w || gy >= g.h) continue;
      const c = gy * g.w + gx;
      if (isStarter(k, i.object_definition)) marks.set(c, "S");
      else if (isTransition(k, i.object_definition)) marks.set(c, "D");
      else if (isFurniture(k, i.object_definition) && !marks.has(c)) marks.set(c, "F");
    }
  }
  let r = region;
  if (!r) {
    // default: the part of the room that has something in it, plus a one-cell margin
    let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
    for (let c = 0; c < g.w * g.h; c++) {
      if (!g.blocked[c] && !g.reach[c] && !marks.has(c)) continue;
      const x = c % g.w, y = (c - x) / g.w;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    r = x1 < 0 ? { x0: 0, y0: 0, x1: g.w - 1, y1: g.h - 1 } : { x0: Math.max(0, x0 - 1), y0: Math.max(0, y0 - 1), x1: Math.min(g.w - 1, x1 + 1), y1: Math.min(g.h - 1, y1 + 1) };
  }
  const pad = String(r.y1).length;
  const tens = " ".repeat(pad + 1) + Array.from({ length: r.x1 - r.x0 + 1 }, (_, i) => ((r!.x0 + i) % 10 === 0 ? String(Math.floor((r!.x0 + i) / 10) % 10) : " ")).join("");
  const ones = " ".repeat(pad + 1) + Array.from({ length: r.x1 - r.x0 + 1 }, (_, i) => String((r!.x0 + i) % 10)).join("");
  const rows = [tens, ones];
  for (let y = r.y0; y <= r.y1; y++) {
    let line = String(y).padStart(pad) + " ";
    for (let x = r.x0; x <= r.x1; x++) {
      const c = y * g.w + x;
      line += marks.get(c) ?? (g.blocked[c] ? "#" : g.reach[c] ? "." : " ");
    }
    rows.push(line.replace(/\s+$/, ""));
  }
  return rows.join("\n");
}

// ---------------- links ----------------

export interface Link {
  id: number;
  object: string;
  x: number;
  y: number;
  cell: [number, number];
  creation_code: string | null;
  position_tag?: string;
  target?: string;
  start_depth?: string;
}

function parseCC(text: string | null): Pick<Link, "position_tag" | "target" | "start_depth"> {
  if (!text) return {};
  const out: Pick<Link, "position_tag" | "target" | "start_depth"> = {};
  const tag = /position_tag\s*=\s*("[^"]*"|[^;\n]+)/.exec(text);
  if (tag) out.position_tag = tag[1].trim().replace(/^"|"$/g, "");
  const target = /\btarget\s*=\s*([^;\n]+)/.exec(text);
  if (target) out.target = target[1].trim();
  const sd = /\bstart_depth\s*=\s*([^;\n]+)/.exec(text);
  if (sd) out.start_depth = sd[1].trim();
  return out;
}

export function links(k: Knowledge, room: Room): { doors: Link[]; starters: Link[] } {
  const doors: Link[] = [], starters: Link[] = [];
  for (const L of room.layers) {
    if (L.layer_type !== LayerType.Instances) continue;
    for (const i of L.layer_data.instances as RoomInstance[]) {
      const o = i.object_definition;
      const door = isTransition(k, o), st = isStarter(k, o);
      if (!door && !st) continue;
      const link: Link = {
        id: i.instance_id, object: o!, x: i.x, y: i.y, cell: [cellOf(i.x), cellOf(i.y)],
        creation_code: i.creation_code, ...parseCC(i.creation_code ? k.codeText(i.creation_code) : null),
      };
      (door ? doors : starters).push(link);
    }
  }
  return { doors, starters };
}

// ---------------- rules ----------------

export interface Finding {
  rule: string;
  level: "error" | "warn" | "info";
  message: string;
  ids?: number[];
  cells?: [number, number][];
}

export function lint(k: Knowledge, room: Room, g = walkGrid(k, room)): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<number, number>();
  const unknown = new Map<string, number[]>(), mod = new Map<string, number[]>(), missing = new Map<string, number[]>();
  for (const L of room.layers) {
    if (L.layer_type !== LayerType.Instances) continue;
    for (const i of L.layer_data.instances as RoomInstance[]) {
      seen.set(i.instance_id, (seen.get(i.instance_id) ?? 0) + 1);
      const o = i.object_definition ?? "";
      const bucket = k.objects[o] ? null : k.modObjects.has(o) ? mod : unknown;
      if (bucket) bucket.set(o, [...(bucket.get(o) ?? []), i.instance_id]);
      for (const c of [i.creation_code, i.pre_create_code])
        if (c && k.codeText(c) === null) missing.set(c, [...(missing.get(c) ?? []), i.instance_id]);
    }
  }
  for (const [o, ids] of unknown)
    out.push({ rule: "unknown-object", level: "error", ids, message: `${o} is neither a vanilla object nor one the mod AddObject()s: AddRoomJson silently drops these ${ids.length} instance(s)` });
  for (const [o, ids] of mod)
    out.push({ rule: "mod-object", level: "info", ids, message: `${o} is a mod object: its Msl.AddObject must run before this room's AddRoomJson, or the instance is silently dropped` });
  for (const [c, ids] of missing)
    out.push({ rule: "missing-code", level: "error", ids, message: `creation code "${c}" resolves to nothing (no ${c}.gml anywhere under the mod's Codes/, and no vanilla ${c}.gml in the decompiled source dump): MSL stores null and the instance's Create never runs` });
  for (const [id, n] of seen) if (n > 1) out.push({ rule: "duplicate-id", level: "error", ids: [id], message: `instance_id ${id} appears ${n} times` });

  if (g.starters.length === 0) out.push({ rule: "no-starter", level: "warn", message: "no o_position_starter: the player has nowhere to arrive" });
  for (const s of g.starters)
    if (g.blocked[s.gy * g.w + s.gx]) out.push({ rule: "starter-blocked", level: "error", ids: [s.id], cells: [[s.gx, s.gy]], message: `starter ${s.id} stands on a collision cell (${s.gx},${s.gy})` });

  // interiors (static camera) must be closed: walkable area touching the room edge = a hole in a wall
  const interior = room.layers.some((L) => L.layer_type === LayerType.Instances && (L.layer_data.instances as RoomInstance[]).some((i) => i.object_definition === "oCameraStatic"));
  if (interior) {
    const edge: [number, number][] = [];
    for (let x = 0; x < g.w; x++) for (const y of [0, g.h - 1]) if (g.reach[y * g.w + x]) edge.push([x, y]);
    for (let y = 0; y < g.h; y++) for (const x of [0, g.w - 1]) if (g.reach[y * g.w + x]) edge.push([x, y]);
    if (edge.length)
      out.push({ rule: "leak", level: "error", cells: edge.slice(0, 20), message: `the walkable area reaches the room edge at ${edge.length} cell(s): a wall has a hole (see \`svre grid\`)` });
  }

  const { doors } = links(k, room);
  for (const d of doors)
    if (d.creation_code && d.target === undefined && d.position_tag === undefined)
      out.push({ rule: "door-unlinked", level: "warn", ids: [d.id], message: `${d.object} ${d.id} has creation code ${d.creation_code} but it sets neither target nor position_tag` });
  return out;
}

export function describe(k: Knowledge, room: Room) {
  const g = walkGrid(k, room);
  const counts: Record<string, number> = {};
  const layers = room.layers.map((L) => {
    const n = L.layer_type === LayerType.Instances ? L.layer_data.instances.length : undefined;
    if (L.layer_type === LayerType.Instances) for (const i of L.layer_data.instances as RoomInstance[]) counts[i.object_definition ?? "?"] = (counts[i.object_definition ?? "?"] ?? 0) + 1;
    return { name: L.layer_name, type: L.layer_type, depth: L.layer_depth, visibleInGame: L.is_visible, instances: n };
  });
  let walkable = 0, blocked = 0;
  for (let c = 0; c < g.w * g.h; c++) { walkable += g.reach[c]; blocked += g.blocked[c]; }
  return {
    name: room.name,
    size: { width: room.width, height: room.height, cells: [g.w, g.h] },
    layers,
    objects: Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([object, n]) => ({ object, n })),
    ...links(k, room),
    walk: { walkableCells: walkable, collisionCells: blocked },
    findings: lint(k, room, g),
  };
}
