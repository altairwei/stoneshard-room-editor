// The edit vocabulary. Humans (through the UI) and agents (through `svre apply`) change
// a room ONLY by these ops; the project log is a list of them, and a room file is its
// base replayed through them.
//
// Instances are addressed by instance_id. MSL throws that id away on import (RoomUtils.cs
// renumbers from GeneralInfo.LastObj), so inside a room JSON it is free to serve as a
// stable identity: base instances keep the id they have in the vanilla export, new ones
// get a fresh id when their `add` is first logged.
//
// `expect` is optimistic concurrency: the op only applies if the target still looks like
// that. Every logged op carries one (normalize() fills it from the state it was authored
// against), so a stale agent edit is refused instead of landing on something a human has
// since moved, and replaying the log on a newer vanilla base reports exactly which ops no
// longer fit.
//
// Two invariants every op keeps: key order is never changed (AddRoomJson reads
// positionally), and the top-level game_objects list mirrors the layer instances by id
// (MSL ignores it for GMS2, but the file should not lie).
//
// `relayer` doubles as the reorder op: with layer = the instance's own layer and a
// `before` anchor it just moves the instance inside its layer's array. Array order is
// creation order in-game, and creation order breaks same-depth draw ties (later = on
// top), so this is how "bring forward / send backward" is expressed.
import { INSTANCE_KEYS, LayerType, findInstance, layerIndexByName, type Room, type RoomInstance } from "./room.ts";

export type InstFields = Partial<Omit<RoomInstance, "instance_id">>;

export type Op =
  | { op: "add"; layer: string; inst: RoomInstance; before?: number | null; goBefore?: number | null }
  | { op: "delete"; id: number; expect?: Partial<RoomInstance> }
  | { op: "set"; id: number; set: InstFields; expect?: Partial<RoomInstance> }
  | { op: "relayer"; id: number; layer: string; before?: number | null; expect?: { layer: string } }
  | { op: "room"; set: Record<string, unknown>; expect?: Record<string, unknown> }
  | { op: "layer"; layer: string; set: Record<string, unknown>; expect?: Record<string, unknown> };

export class OpError extends Error {
  code: "expect" | "missing" | "invalid";
  constructor(code: "expect" | "missing" | "invalid", message: string) {
    super(message);
    this.code = code;
  }
}

const INSTANCE_DEFAULTS: Omit<RoomInstance, "x" | "y" | "object_definition" | "instance_id"> = {
  creation_code: null,
  scale_x: 1,
  scale_y: 1,
  color: 4294967295,
  rotation: 0,
  pre_create_code: null,
  image_speed: 1,
  image_index: 0,
};

const NUMERIC: (keyof RoomInstance)[] = ["x", "y", "scale_x", "scale_y", "color", "rotation", "image_speed", "image_index"];
const NULLABLE_STR: (keyof RoomInstance)[] = ["object_definition", "creation_code", "pre_create_code"];
const INTEGER: (keyof RoomInstance)[] = ["x", "y", "color", "image_index"];

function checkField(k: string, v: unknown) {
  if (!INSTANCE_KEYS.includes(k as keyof RoomInstance)) throw new OpError("invalid", `unknown instance field "${k}"`);
  if (k === "instance_id") throw new OpError("invalid", "instance_id cannot be set; it is the instance's identity");
  if (NUMERIC.includes(k as keyof RoomInstance)) {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new OpError("invalid", `${k} must be a number`);
    if (INTEGER.includes(k as keyof RoomInstance) && !Number.isInteger(v)) throw new OpError("invalid", `${k} must be an integer`);
  }
  if (NULLABLE_STR.includes(k as keyof RoomInstance) && v !== null && typeof v !== "string")
    throw new OpError("invalid", `${k} must be a string or null`);
}

// build an instance in the exporter's key order from whatever subset the author gave
export function makeInstance(fields: Partial<RoomInstance> & { object_definition: string; x: number; y: number }, id: number): RoomInstance {
  for (const [k, v] of Object.entries(fields)) if (k !== "instance_id") checkField(k, v);
  const full: any = { ...INSTANCE_DEFAULTS, ...fields, instance_id: id };
  const out: any = {};
  for (const k of INSTANCE_KEYS) out[k] = full[k];
  return out as RoomInstance;
}

function need(room: Room, id: number) {
  const at = findInstance(room, id);
  if (!at) throw new OpError("missing", `no instance with id ${id}`);
  return at;
}

function checkExpect(what: string, actual: Record<string, unknown>, expect: Record<string, unknown> | undefined) {
  if (!expect) return;
  for (const [k, v] of Object.entries(expect)) {
    if (actual[k] !== v)
      throw new OpError("expect", `${what}: expected ${k}=${JSON.stringify(v)}, found ${JSON.stringify(actual[k])}`);
  }
}

function needLayer(room: Room, name: string, instancesOnly = true): number {
  const li = layerIndexByName(room, name);
  if (li < 0) throw new OpError("missing", `no layer named "${name}"`);
  if (instancesOnly && room.layers[li].layer_type !== LayerType.Instances) throw new OpError("invalid", `layer "${name}" is not an instance layer`);
  return li;
}

const twinIndex = (room: Room, id: number) => room.game_objects.findIndex((g) => g.instance_id === id);

function insertBefore<T>(list: T[], item: T, beforeIdx: number) {
  if (beforeIdx < 0) list.push(item);
  else list.splice(beforeIdx, 0, item);
}

// Apply one op in place; returns the op that undoes it (itself fully specified).
export function applyOp(room: Room, op: Op): Op {
  switch (op.op) {
    case "add": {
      const li = needLayer(room, op.layer);
      if (findInstance(room, op.inst.instance_id)) throw new OpError("invalid", `instance id ${op.inst.instance_id} already exists`);
      const inst = makeInstance(op.inst as any, op.inst.instance_id);
      const list = room.layers[li].layer_data.instances as RoomInstance[];
      const bi = op.before != null ? list.findIndex((i) => i.instance_id === op.before) : -1;
      if (op.before != null && bi < 0) throw new OpError("missing", `add: anchor id ${op.before} is not in layer "${op.layer}"`);
      insertBefore(list, inst, bi);
      const gi = op.goBefore != null ? twinIndex(room, op.goBefore) : -1;
      insertBefore(room.game_objects, { ...inst }, gi);
      return { op: "delete", id: inst.instance_id, expect: { ...inst } };
    }

    case "delete": {
      const at = need(room, op.id);
      checkExpect(`delete ${op.id}`, at.inst as any, op.expect);
      const list = room.layers[at.layer].layer_data.instances as RoomInstance[];
      const next = list[at.index + 1]?.instance_id ?? null;
      list.splice(at.index, 1);
      const gi = twinIndex(room, op.id);
      const goNext = gi >= 0 ? room.game_objects[gi + 1]?.instance_id ?? null : null;
      if (gi >= 0) room.game_objects.splice(gi, 1);
      return { op: "add", layer: room.layers[at.layer].layer_name!, inst: { ...at.inst }, before: next, goBefore: goNext };
    }

    case "set": {
      const at = need(room, op.id);
      checkExpect(`set ${op.id}`, at.inst as any, op.expect);
      const before: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.set)) {
        checkField(k, v);
        before[k] = (at.inst as any)[k];
      }
      Object.assign(at.inst, op.set);
      const gi = twinIndex(room, op.id);
      if (gi >= 0) Object.assign(room.game_objects[gi], op.set);
      return { op: "set", id: op.id, set: before as InstFields, expect: { ...op.set } as Partial<RoomInstance> };
    }

    case "relayer": {
      const at = need(room, op.id);
      const fromName = room.layers[at.layer].layer_name!;
      checkExpect(`relayer ${op.id}`, { layer: fromName }, op.expect);
      const to = needLayer(room, op.layer);
      const fromList = room.layers[at.layer].layer_data.instances as RoomInstance[];
      const toList = room.layers[to].layer_data.instances as RoomInstance[];
      if (op.before != null) {
        if (op.before === op.id) throw new OpError("invalid", `relayer ${op.id}: an instance cannot be its own anchor`);
        if (!toList.some((i) => i.instance_id === op.before)) throw new OpError("missing", `relayer: anchor id ${op.before} is not in layer "${op.layer}"`);
      }
      const next = fromList[at.index + 1]?.instance_id ?? null;
      fromList.splice(at.index, 1);
      const bi = op.before != null ? toList.findIndex((i) => i.instance_id === op.before) : -1;
      insertBefore(toList, at.inst, bi);
      return { op: "relayer", id: op.id, layer: fromName, before: next, expect: { layer: op.layer } };
    }

    case "room": {
      const before: Record<string, unknown> = {};
      checkExpect("room", room as any, op.expect);
      for (const [k, v] of Object.entries(op.set)) {
        if (!(k in room) || k === "layers" || k === "game_objects" || k === "views" || k === "backgrounds" || k === "tiles")
          throw new OpError("invalid", `room field "${k}" cannot be set by a room op`);
        const cur = (room as any)[k];
        if (cur !== null && v !== null && typeof cur !== typeof v) throw new OpError("invalid", `room.${k} must stay a ${typeof cur}`);
        before[k] = cur;
      }
      Object.assign(room, op.set);
      return { op: "room", set: before, expect: { ...op.set } };
    }

    case "layer": {
      const li = needLayer(room, op.layer, false);
      const L = room.layers[li] as any;
      checkExpect(`layer ${op.layer}`, L, op.expect);
      const before: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(op.set)) {
        if (!(k in L) || k === "layer_data" || k === "layer_type") throw new OpError("invalid", `layer field "${k}" cannot be set`);
        if (L[k] !== null && v !== null && typeof L[k] !== typeof v) throw new OpError("invalid", `layer.${k} must stay a ${typeof L[k]}`);
        before[k] = L[k];
      }
      Object.assign(L, op.set);
      const newName = (op.set.layer_name as string | undefined) ?? op.layer;
      return { op: "layer", layer: newName, set: before, expect: { ...op.set } };
    }
  }
  throw new OpError("invalid", `unknown op ${(op as any).op}`);
}

// Apply a batch atomically: on the first failure the room is rolled back and the error rethrown.
export function applyAll(room: Room, ops: Op[]): Op[] {
  const inverses: Op[] = [];
  try {
    for (const op of ops) inverses.push(applyOp(room, op));
  } catch (e) {
    for (const inv of inverses.reverse()) applyOp(room, inv);
    throw e;
  }
  return inverses.reverse(); // undo order
}

// Make an authored op fully specified before it is logged: allocate ids for new
// instances, fill defaults, and pin `expect` to the state it was authored against.
export function normalize(room: Room, op: Op, allocId: () => number): Op {
  switch (op.op) {
    case "add": {
      const raw = op.inst as any;
      if (!raw || typeof raw.object_definition !== "string") throw new OpError("invalid", "add: inst.object_definition is required");
      if (typeof raw.x !== "number" || typeof raw.y !== "number") throw new OpError("invalid", "add: inst.x and inst.y are required");
      const id = typeof raw.instance_id === "number" && !findInstance(room, raw.instance_id) ? raw.instance_id : allocId();
      return { ...op, inst: makeInstance(raw, id) };
    }
    case "delete": {
      const at = need(room, op.id);
      return { ...op, expect: op.expect ?? { object_definition: at.inst.object_definition, x: at.inst.x, y: at.inst.y } };
    }
    case "set": {
      const at = need(room, op.id);
      if (op.expect) return op;
      const expect: Record<string, unknown> = { object_definition: at.inst.object_definition };
      for (const k of Object.keys(op.set)) expect[k] = (at.inst as any)[k];
      return { ...op, expect: expect as Partial<RoomInstance> };
    }
    case "relayer": {
      const at = need(room, op.id);
      return { ...op, expect: op.expect ?? { layer: room.layers[at.layer].layer_name! } };
    }
    case "room": {
      if (op.expect) return op;
      const expect: Record<string, unknown> = {};
      for (const k of Object.keys(op.set)) expect[k] = (room as any)[k];
      return { ...op, expect };
    }
    case "layer": {
      if (op.expect) return op;
      const li = needLayer(room, op.layer, false);
      const expect: Record<string, unknown> = {};
      for (const k of Object.keys(op.set)) expect[k] = (room.layers[li] as any)[k];
      return { ...op, expect };
    }
  }
  return op;
}

export function maxInstanceId(room: Room): number {
  let m = 0;
  for (const g of room.game_objects) m = Math.max(m, g.instance_id);
  for (const L of room.layers) if (L.layer_type === LayerType.Instances) for (const i of L.layer_data.instances) m = Math.max(m, i.instance_id);
  return m;
}

// instance ids an op touches (for highlighting "what did this change do")
export function touchedIds(op: Op): number[] {
  switch (op.op) {
    case "add": return [op.inst.instance_id];
    case "delete": case "set": case "relayer": return [op.id];
    default: return [];
  }
}
