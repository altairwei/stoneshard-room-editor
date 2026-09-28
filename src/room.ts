// The MSL room JSON -- exactly what ExportRoom.csx writes and Msl.AddRoomJson reads.
//
// ⚠ AddRoomJson reads this POSITIONALLY (RoomUtils.cs: ReadNum/ReadString pull the next
// value and ignore the property name). Key order is part of the format, not cosmetics:
// never add, drop or reorder keys. The types below list keys in file order.

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

export const enum LayerType {
  Path = 0,
  Background = 1,
  Instances = 2,
  Assets = 3,
  Tiles = 4,
}

export interface BackgroundData {
  visible: boolean;
  foreground: boolean;
  sprite: string | null;
  tiled_horizontally: boolean;
  tiled_vertically: boolean;
  stretch: boolean;
  color: number;
  first_frame: number;
  animation_speed: number;
  animation_speed_type: number;
}

export interface AssetSprite {
  name: string | null;
  sprite: string | null;
  x: number;
  y: number;
  scale_x: number;
  scale_y: number;
  color: number;
  animation_speed: number;
  animation_speed_type: number;
  frame_index: number;
  rotation: number;
}

export interface AssetsData {
  legacy_tiles: unknown[];
  sprites: AssetSprite[];
  sequences: unknown[];
  nine_slices: unknown[];
}

export interface RoomLayer {
  layer_name: string | null;
  layer_id: number;
  layer_type: LayerType;
  layer_depth: number;
  x_offset: number;
  y_offset: number;
  h_speed: number;
  v_speed: number;
  is_visible: boolean;
  layer_data: any; // BackgroundData | { instances: RoomInstance[] } | AssetsData | tiles
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

export function parseRoom(text: string): Room {
  return JSON.parse(text) as Room;
}

// GameMaker colours are 0xAABBGGRR.
export function gmColor(c: number): { rgb: number; alpha: number } {
  const u = c >>> 0;
  const r = u & 0xff, g = (u >>> 8) & 0xff, b = (u >>> 16) & 0xff;
  return { rgb: (r << 16) | (g << 8) | b, alpha: (u >>> 24) / 255 };
}
