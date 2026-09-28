// diff(base, target) -> ops such that replaying them over `base` gives `target` exactly
// (same keys, same order, same game_objects order). Used to import a room that was made
// some other way (a generator script, a hand edit, another tool) as a project, and to
// turn an out-of-band change to a compiled room file into a visible "external" entry.
//
// Matching is by instance_id. Supported differences: room/layer scalar fields, deleted,
// added, changed and re-layered instances, and instance order within a layer. Layer
// structure (adding/removing/reordering layers) is not an op yet; diff() refuses rather
// than guess. Callers must check with verifyDiff() -- it is cheap and it is the proof.
import { applyAll, type Op } from "./ops.ts";
import { INSTANCE_KEYS, LayerType, cloneRoom, type Room, type RoomInstance } from "./room.ts";

const SKIP_ROOM = new Set(["layers", "game_objects"]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class DiffError extends Error {}

export function diffRooms(base: Room, target: Room): Op[] {
  const ops: Op[] = [];

  // room scalars (views/backgrounds/tiles too: whole-value compare, refuse if changed)
  const bk = Object.keys(base), tk = Object.keys(target);
  if (!same(bk, tk)) throw new DiffError("room keys differ -- not the same file format");
  const roomSet: Record<string, unknown> = {};
  for (const k of bk) {
    if (SKIP_ROOM.has(k) || same((base as any)[k], (target as any)[k])) continue;
    if (typeof (base as any)[k] === "object" && (base as any)[k] !== null) throw new DiffError(`room.${k} differs; structured room fields are not an op yet`);
    roomSet[k] = (target as any)[k];
  }
  if (Object.keys(roomSet).length) ops.push({ op: "room", set: roomSet });

  // layers must line up one to one
  if (base.layers.length !== target.layers.length) throw new DiffError(`layer count differs (${base.layers.length} -> ${target.layers.length})`);
  base.layers.forEach((L, i) => {
    const T = target.layers[i];
    if (L.layer_type !== T.layer_type || L.layer_id !== T.layer_id) throw new DiffError(`layer #${i} is a different layer (${L.layer_name} -> ${T.layer_name})`);
    const set: Record<string, unknown> = {};
    for (const k of Object.keys(L)) if (k !== "layer_data" && !same((L as any)[k], (T as any)[k])) set[k] = (T as any)[k];
    if (Object.keys(set).length) ops.push({ op: "layer", layer: L.layer_name!, set });
    if (L.layer_type !== LayerType.Instances && !same(L.layer_data, T.layer_data)) throw new DiffError(`non-instance layer "${L.layer_name}" content differs; not an op yet`);
  });
  const layerName = (li: number) => target.layers[li].layer_name!;

  // where every instance lives, in both
  type Loc = { layer: number; inst: RoomInstance };
  const index = (r: Room) => {
    const m = new Map<number, Loc>();
    r.layers.forEach((L, li) => { if (L.layer_type === LayerType.Instances) for (const inst of L.layer_data.instances) m.set(inst.instance_id, { layer: li, inst }); });
    return m;
  };
  const B = index(base), T = index(target);

  for (const [id, b] of B) if (!T.has(id)) ops.push({ op: "delete", id, expect: { object_definition: b.inst.object_definition, x: b.inst.x, y: b.inst.y } });

  for (const [id, t] of T) {
    const b = B.get(id);
    if (!b) continue;
    const set: Record<string, unknown> = {};
    for (const k of INSTANCE_KEYS) if (k !== "instance_id" && !same((b.inst as any)[k], (t.inst as any)[k])) set[k] = (t.inst as any)[k];
    if (Object.keys(set).length) {
      const expect: Record<string, unknown> = { object_definition: b.inst.object_definition };
      for (const k of Object.keys(set)) expect[k] = (b.inst as any)[k];
      ops.push({ op: "set", id, set, expect });
    }
  }

  // adds, in the target's game_objects order (that is the order they were appended there)
  const goOrder = target.game_objects.map((g) => g.instance_id);
  const added = goOrder.filter((id) => T.has(id) && !B.has(id));
  const orphanAdds = [...T.keys()].filter((id) => !B.has(id) && !goOrder.includes(id));
  for (const id of [...added, ...orphanAdds]) {
    const t = T.get(id)!;
    ops.push({ op: "add", layer: layerName(t.layer), inst: { ...t.inst } });
  }

  // relayers of kept instances
  for (const [id, t] of T) {
    const b = B.get(id);
    if (b && b.layer !== t.layer) ops.push({ op: "relayer", id, layer: layerName(t.layer), expect: { layer: base.layers[b.layer].layer_name! } });
  }

  // replay what we have, then fix any remaining order differences with anchored moves
  const trial = cloneRoom(base);
  applyAll(trial, ops);
  target.layers.forEach((L, li) => {
    if (L.layer_type !== LayerType.Instances) return;
    const want = (L.layer_data.instances as RoomInstance[]).map((i) => i.instance_id);
    const have = () => (trial.layers[li].layer_data.instances as RoomInstance[]).map((i) => i.instance_id);
    // walk from the end: place each id before its target successor
    for (let k = want.length - 1; k >= 0; k--) {
      const h = have();
      const next = want[k + 1] ?? null;
      const cur = h.indexOf(want[k]);
      const ok = next === null ? cur === h.length - 1 : h[cur + 1] === next;
      if (ok) continue;
      const op: Op = { op: "relayer", id: want[k], layer: layerName(li), before: next, expect: { layer: layerName(li) } };
      applyAll(trial, [op]);
      ops.push(op);
    }
  });
  if (!same(trial.game_objects.map((g) => g.instance_id), goOrder))
    throw new DiffError("game_objects order cannot be reproduced by appends; not supported yet");
  return ops;
}

export function verifyDiff(base: Room, target: Room, ops: Op[]): boolean {
  const r = cloneRoom(base);
  applyAll(r, ops);
  return JSON.stringify(r) === JSON.stringify(target);
}
