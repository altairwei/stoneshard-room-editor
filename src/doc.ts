// The open room as an editable document: the parsed JSON, the byte style it came in,
// and an undo stack of commands.
//
// Two invariants every command keeps:
//
//  1. Saving an unedited room reproduces the file byte for byte. JSON.stringify(_, null, 2)
//     already matches the exporters' layout (checked against every room we have); what
//     varies is the line ending and whether there is a final newline, so those are
//     remembered at load and replayed at save.
//
//  2. The top-level `game_objects` list mirrors the layer instances, keyed by instance_id.
//     MSL ignores it for GMS2 games (RoomUtils.cs ReadGameObjects: `!IsGameMaker2()`), so
//     it is cosmetic -- but every exporter writes it in sync and a stale copy would make
//     the file lie. Commands touch layer instances; `mirror()` carries the change across.
//
// Key order is never touched: AddRoomJson reads positionally (see room.ts).
import { LayerType, type Room, type RoomInstance } from "./room";

export interface FileStyle {
  crlf: boolean;
  finalNewline: boolean;
}

export interface Command {
  label: string;
  do(doc: RoomDoc): void;
  undo(doc: RoomDoc): void;
}

type Pos = { x: number; y: number };
export type InstPatch = Partial<Omit<RoomInstance, "instance_id">>;

export class RoomDoc {
  room: Room;
  style: FileStyle;
  baseHash: string;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private savedAt = 0; // undoStack length at last save; -1 = unreachable
  onChange: (cmd: Command | null) => void = () => {};

  constructor(text: string, hash: string) {
    this.room = JSON.parse(text);
    this.style = { crlf: text.includes("\r\n"), finalNewline: /\n$/.test(text) };
    this.baseHash = hash;
  }

  serialize(): string {
    let s = JSON.stringify(this.room, null, 2);
    if (this.style.crlf) s = s.split("\n").join("\r\n");
    if (this.style.finalNewline) s += this.style.crlf ? "\r\n" : "\n";
    return s;
  }

  get dirty() {
    return this.undoStack.length !== this.savedAt;
  }
  markSaved(hash: string) {
    this.baseHash = hash;
    this.savedAt = this.undoStack.length;
  }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack.at(-1)?.label; }
  get redoLabel() { return this.redoStack.at(-1)?.label; }

  run(cmd: Command) {
    cmd.do(this);
    this.undoStack.push(cmd);
    if (this.savedAt > this.undoStack.length - 1) this.savedAt = -1; // the saved state was on the discarded redo branch
    this.redoStack = [];
    this.onChange(cmd);
  }
  undo() {
    const cmd = this.undoStack.pop();
    if (!cmd) return;
    cmd.undo(this);
    this.redoStack.push(cmd);
    this.onChange(cmd);
  }
  redo() {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.do(this);
    this.undoStack.push(cmd);
    this.onChange(cmd);
  }

  // ---- structure helpers ----

  instances(layerIndex: number): RoomInstance[] {
    const L = this.room.layers[layerIndex];
    return L?.layer_type === LayerType.Instances ? L.layer_data.instances : [];
  }

  locate(inst: RoomInstance): { layer: number; index: number } | null {
    for (let li = 0; li < this.room.layers.length; li++) {
      const i = this.instances(li).indexOf(inst);
      if (i >= 0) return { layer: li, index: i };
    }
    return null;
  }

  // copy a layer instance's fields onto its game_objects twin (same instance_id)
  mirror(inst: RoomInstance) {
    const twin = this.room.game_objects.find((g) => g.instance_id === inst.instance_id);
    if (twin && twin !== inst) Object.assign(twin, inst);
  }

  // monotonic: ids handed out are never reused, even after undo, so a batch of new
  // instances built before any of them is inserted still gets distinct ids.
  // (MSL renumbers on import anyway -- RoomUtils.cs throws the JSON id away -- but the
  // file's own game_objects mirror is keyed by it.)
  private idCursor = 0;
  nextInstanceId(): number {
    if (!this.idCursor) {
      for (const g of this.room.game_objects) this.idCursor = Math.max(this.idCursor, g.instance_id);
      for (let li = 0; li < this.room.layers.length; li++) for (const i of this.instances(li)) this.idCursor = Math.max(this.idCursor, i.instance_id);
    }
    return ++this.idCursor;
  }
}

// ---------------- commands ----------------

export function moveCmd(insts: RoomInstance[], dx: number, dy: number, label = "移动"): Command {
  const before: Pos[] = insts.map((i) => ({ x: i.x, y: i.y }));
  return {
    label: `${label} ${insts.length} 个实例`,
    do(doc) {
      insts.forEach((i, k) => { i.x = before[k].x + dx; i.y = before[k].y + dy; doc.mirror(i); });
    },
    undo(doc) {
      insts.forEach((i, k) => { i.x = before[k].x; i.y = before[k].y; doc.mirror(i); });
    },
  };
}

export function patchCmd(insts: RoomInstance[], patch: InstPatch, label = "修改属性"): Command {
  const before = insts.map((i) => {
    const old: Record<string, unknown> = {};
    for (const k of Object.keys(patch)) old[k] = (i as any)[k];
    return old;
  });
  return {
    label,
    do(doc) { insts.forEach((i) => { Object.assign(i, patch); doc.mirror(i); }); },
    undo(doc) { insts.forEach((i, k) => { Object.assign(i, before[k]); doc.mirror(i); }); },
  };
}

interface Placed { layer: number; index: number; inst: RoomInstance; goIndex: number }

export function addCmd(entries: { layer: number; inst: RoomInstance }[], label = "添加"): Command {
  let placed: Placed[] = [];
  return {
    label: `${label} ${entries.length} 个实例`,
    do(doc) {
      placed = entries.map(({ layer, inst }) => {
        const list = doc.instances(layer);
        list.push(inst);
        doc.room.game_objects.push({ ...inst });
        return { layer, index: list.length - 1, inst, goIndex: doc.room.game_objects.length - 1 };
      });
    },
    undo(doc) {
      for (const p of [...placed].reverse()) {
        doc.instances(p.layer).splice(p.index, 1);
        doc.room.game_objects.splice(p.goIndex, 1);
      }
    },
  };
}

export function deleteCmd(insts: RoomInstance[]): Command {
  let removed: (Placed & { twin: RoomInstance | null })[] = [];
  return {
    label: `删除 ${insts.length} 个实例`,
    do(doc) {
      removed = [];
      for (const inst of insts) {
        const at = doc.locate(inst);
        if (!at) continue;
        doc.instances(at.layer).splice(at.index, 1);
        const goIndex = doc.room.game_objects.findIndex((g) => g.instance_id === inst.instance_id);
        const twin = goIndex >= 0 ? doc.room.game_objects.splice(goIndex, 1)[0] : null;
        removed.push({ layer: at.layer, index: at.index, inst, goIndex, twin });
      }
    },
    undo(doc) {
      // reinsert in reverse removal order so every recorded index is valid again
      for (const r of [...removed].reverse()) {
        doc.instances(r.layer).splice(r.index, 0, r.inst);
        if (r.twin && r.goIndex >= 0) doc.room.game_objects.splice(r.goIndex, 0, r.twin);
      }
    },
  };
}

export function relayerCmd(insts: RoomInstance[], toLayer: number): Command {
  let moved: { from: number; index: number; inst: RoomInstance }[] = [];
  return {
    label: `移到图层 ${insts.length} 个实例`,
    do(doc) {
      moved = [];
      for (const inst of insts) {
        const at = doc.locate(inst);
        if (!at || at.layer === toLayer) continue;
        doc.instances(at.layer).splice(at.index, 1);
        doc.instances(toLayer).push(inst);
        moved.push({ from: at.layer, index: at.index, inst });
      }
    },
    undo(doc) {
      for (const m of [...moved].reverse()) {
        const list = doc.instances(toLayer);
        list.splice(list.indexOf(m.inst), 1);
        doc.instances(m.from).splice(m.index, 0, m.inst);
      }
    },
  };
}

export function newInstance(doc: RoomDoc, object: string, x: number, y: number): RoomInstance {
  // field order = file order (positional reader!)
  return {
    x, y,
    object_definition: object,
    instance_id: doc.nextInstanceId(),
    creation_code: null,
    scale_x: 1,
    scale_y: 1,
    color: 4294967295,
    rotation: 0,
    pre_create_code: null,
    image_speed: 1,
    image_index: 0,
  };
}

// deep copy that keeps the key order of the source
export function cloneInstance(doc: RoomDoc, src: RoomInstance, dx: number, dy: number): RoomInstance {
  const c = JSON.parse(JSON.stringify(src)) as RoomInstance;
  c.x += dx;
  c.y += dy;
  c.instance_id = doc.nextInstanceId();
  return c;
}
