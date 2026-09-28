// The MSL room JSON -- exactly what ExportRoom.csx writes and Msl.AddRoomJson reads.
//
// ⚠ AddRoomJson reads this POSITIONALLY (RoomUtils.cs: ReadNum/ReadString pull the next
// value and ignore the property name). Key order is part of the format, not cosmetics:
// never add, drop or reorder keys. The types below list keys in file order.
//
// This module (like everything under core/) is plain TypeScript with no DOM and no Node
// imports: the dev server, the browser and the tests all run the same code.

export interface RoomInstance {
  x: number;
  y: number;
  object_definition: string | null;
  instance_id: number;
  creation_code: string | null;
  scale_x: number;
  scale_y: number;
  color: number;
  rotation: number;
  pre_create_code: string | null;
  image_speed: number;
  image_index: number;
}

export const INSTANCE_KEYS: (keyof RoomInstance)[] = [
  "x", "y", "object_definition", "instance_id", "creation_code", "scale_x", "scale_y",
  "color", "rotation", "pre_create_code", "image_speed", "image_index",
];

export const LayerType = {
  Path: 0,
  Background: 1,
  Instances: 2,
  Assets: 3,
  Tiles: 4,
} as const;

export interface RoomLayer {
  layer_name: string | null;
  layer_id: number;
  layer_type: number;
  layer_depth: number;
  x_offset: number;
  y_offset: number;
  h_speed: number;
  v_speed: number;
  is_visible: boolean;
  layer_data: any; // background data | { instances: RoomInstance[] } | assets | tiles
}

export interface Room {
  name: string;
  caption: string | null;
  width: number;
  height: number;
  views: any[];
  game_objects: RoomInstance[];
  layers: RoomLayer[];
  [k: string]: unknown;
}

export const CELL = 26;

export interface FileStyle {
  crlf: boolean;
  finalNewline: boolean;
}

export const styleOf = (text: string): FileStyle => ({ crlf: text.includes("\r\n"), finalNewline: /\n$/.test(text) });

// JSON.stringify(_, null, 2) matches the exporters' layout byte for byte (checked against
// every room file we have); only the line ending and the final newline vary per file.
export function serializeRoom(room: Room, style: FileStyle): string {
  let s = JSON.stringify(room, null, 2);
  if (style.crlf) s = s.split("\n").join("\r\n");
  if (style.finalNewline) s += style.crlf ? "\r\n" : "\n";
  return s;
}

export const cloneRoom = (r: Room): Room => JSON.parse(JSON.stringify(r));

export function instancesOf(room: Room, layerIndex: number): RoomInstance[] {
  const L = room.layers[layerIndex];
  return L?.layer_type === LayerType.Instances ? L.layer_data.instances : [];
}

export function layerIndexByName(room: Room, name: string): number {
  return room.layers.findIndex((L) => L.layer_name === name);
}

export function* allInstances(room: Room): Generator<{ layer: number; index: number; inst: RoomInstance }> {
  for (let li = 0; li < room.layers.length; li++) {
    const list = instancesOf(room, li);
    for (let i = 0; i < list.length; i++) yield { layer: li, index: i, inst: list[i] };
  }
}

export function findInstance(room: Room, id: number): { layer: number; index: number; inst: RoomInstance } | null {
  for (const e of allInstances(room)) if (e.inst.instance_id === id) return e;
  return null;
}

// GameMaker colours are 0xAABBGGRR.
export function gmColor(c: number): { rgb: number; alpha: number } {
  const u = c >>> 0;
  const r = u & 0xff, g = (u >>> 8) & 0xff, b = (u >>> 16) & 0xff;
  return { rgb: (r << 16) | (g << 8) | b, alpha: (u >>> 24) / 255 };
}
