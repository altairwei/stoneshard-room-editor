// Draw a room the way the GAME draws it -- with one deliberate exception.
//
// What decides the picture, and where the editor gets it from:
//   position/scale/frame/tint  the room JSON
//   sprite, origin, trim       sprites.json (texture-page rects, straight from data.win)
//   draw order                 two views, picked by the 顺序 button (applyZOrder):
//                              "game" (default) simulates the runtime: instances whose
//                              Create/Step assign `depth` (o_barrier's -y+18,
//                              c_nightlight's -y+startdepth, baked decals…) sort by
//                              that depth, everything else sits at its layer depth,
//                              and same-depth ties break by creation order
//                              (game_objects), like the runtime. "static" is UTMT's
//                              rule: layer depth, then position in the layer's
//                              instance array -- an audit view of the raw data, NOT
//                              what the game shows wherever vanilla lists drifted.
//   the exception              selected instances always render on top: a placement
//                              tool must never hide the thing you are aiming (a window
//                              light tucked behind its house is exactly where you need
//                              to see it). Deselect and it falls back to its true
//                              occlusion, so the canvas still teaches the game truth.
//   drawn at all               object `visible` (or a Create override) AND layer
//                              is_visible. Hidden things are still shown, faded, when
//                              the "hidden" overlay is on -- they are half the room
//                              (collision stamps, markers, controllers).
//
// Not modelled (flagged in the inspector instead of faked): custom Draw events, runtime
// spawns, depth changed outside Create.
import { Container, Graphics, Sprite, Text } from "pixi.js";
import type { AssetDb, Frame } from "./assets";
import { CELL, LayerType, allInstances, gmColor, type Room, type RoomInstance, type RoomLayer } from "./core/room.ts";
import { t } from "./i18n/index.ts";

export type NodeKind = "drawn" | "hidden" | "collision" | "marker";

// o_barrier_marker is visible=true with a real sprite (sprite0: a uniform green
// square), but it exists to annotate fade walls and sits under their -y art -- in
// game you never see it, and the same depth rules buried it on the canvas. Show it
// in the hidden overlay band (faded, visible by default, resize handles kept) with
// its real sprite, not a stand-in. NOT the marker band: the markers toggle is off
// by default, which would hide it exactly like before.
export const MARKER_OVERLAY_OBJECTS = new Set(["o_barrier_marker"]);

export interface InstanceNode {
  kind: NodeKind;
  layerIndex: number;
  instIndex: number;
  layer: RoomLayer;
  inst: RoomInstance;
  depth: number;
  depthWhy: string;
  visibleWhy: string;
  customDraw: boolean;
  view: Container;
}

export interface RoomScene {
  root: Container;
  nodes: InstanceNode[];
  gridLayer: Graphics;
  boundsLayer: Graphics;
  // z bookkeeping for applyZOrder: the grid sits above the topmost flat fill and
  // below the backmost art; creation order is the runtime's same-depth tie-break.
  maxFillZ: number;
  baseArtZ: number;
  creationOrder: Map<number, number>; // instance_id -> index in game_objects
}

// The two draw-order views (see the header comment). "game" is the truth the runtime
// will draw; "static" is UTMT's data view for auditing the raw layer arrays.
export type ZMode = "game" | "static";

// above every overlay band (1e8+…), below the bounds layer (2e8+1): selected art must
// stay visible no matter what the scene's true occlusion is
const LIFT_Z = 1.5e8;

// Assign every node's z for one view mode, and re-seat the grid inside the art stack.
// "game": -runtime depth, ties by creation order. "static": -layer depth, ties by
// position in the layer array. The tie fraction stays in (0,1), so it can never
// outrank a 1-unit depth gap. Lifted (selected) drawn nodes jump above everything --
// overlays included -- so the thing being placed or moved can never be hidden.
export function applyZOrder(scene: RoomScene, mode: ZMode, lift: ReadonlySet<number>) {
  const cTotal = scene.creationOrder.size;
  let minArt = scene.baseArtZ;
  for (const n of scene.nodes) {
    if (n.kind !== "drawn") {
      // overlay bands: always visible as what they are, so they never need the lift
      n.view.zIndex = 1e8 + (n.kind === "hidden" ? 0 : n.kind === "collision" ? 1 : 2);
      continue;
    }
    const tie =
      mode === "game"
        ? ((scene.creationOrder.get(n.inst.instance_id) ?? 0) + 1) / (cTotal + 1)
        : (n.instIndex + 1) / ((n.layer.layer_data.instances as RoomInstance[]).length + 1);
    const lifted = lift.has(n.inst.instance_id);
    n.view.zIndex = (lifted ? LIFT_Z : mode === "game" ? -n.depth : -n.layer.layer_depth) + tie;
    if (!lifted) minArt = Math.min(minArt, n.view.zIndex);
  }
  scene.gridLayer.zIndex = Math.min(scene.maxFillZ + 0.5, minArt - 0.5);
}

// o_hut_wall (s_handmadeCollision) self-destructs after stamping o_controller.newgrid;
// it draws as a flat stamp instead of its invisible sprite.
// o_projectileBarrier is the same kind of grid stamper (wallgrid) but renders with its
// vanilla sprite s_torchishka2 -- matching what UTMT shows, per user requirement.
const COLLISION_SPRITES = new Set(["s_handmadeCollision"]);

function resolveDepth(db: AssetDb, obj: string, inst: RoomInstance, layer: RoomLayer): [number, string] {
  const d = db.createOf(obj)?.depth;
  if (d && !d.conditional) {
    if (d.mode === "y") {
      const off = d.offset ?? 0;
      const src = d.perFrame ? t("{from} 的 Step 每帧重写", { from: d.from }) : t("{from} 的 Create", { from: d.from });
      const via = d.offsetVar ? t("，偏移来自 {offsetVar} 的缺省值，房间 CC 可改", { offsetVar: d.offsetVar }) : "";
      return [-inst.y + off, t("-y {sign} {abs}（{src}{via}）", { sign: off >= 0 ? "+" : "-", abs: Math.abs(off), src, via })];
    }
    if (d.mode === "const") return [d.value!, t("{value}（{from} 的 Create）", { value: d.value, from: d.from })];
    return [layer.layer_depth, t("图层深度；{from} 的 Create 设为 {expr}（未求值）", { from: d.from, expr: d.expr })];
  }
  if (d?.conditional) return [layer.layer_depth, t("图层深度；{from} 的 Create 有条件地改 depth", { from: d.from })];
  return [layer.layer_depth, t("图层深度（{layer}）", { layer: layer.layer_name })];
}

function resolveVisible(db: AssetDb, obj: string, layer: RoomLayer): [boolean, string] {
  const def = db.objects[obj];
  const v = db.createOf(obj)?.visible;
  let vis = def?.visible ?? true;
  let why = t("对象标志 visible={vis}", { vis: String(vis) });
  if (v && !v.conditional) {
    vis = v.value;
    why = t("{from} 的 Create 设 visible={value}", { from: v.from, value: String(v.value) });
  }
  const draw = db.createOf(obj)?.draw;
  if (vis && draw && (draw.mode === "hl" || draw.mode === "none")) {
    // doors, ladders, the furnace: their picture is baked into the walls; at rest they
    // draw nothing, only a hover highlight
    vis = false;
    why += draw.mode === "hl" ? t("；{from} 的 Draw 只画悬停高亮", { from: draw.from }) : t("；{from} 的 Draw 什么也不画", { from: draw.from });
  }
  if (!layer.is_visible) return [false, t("{why}；图层 {layer} 游戏内隐藏", { why, layer: layer.layer_name })];
  return [vis, why];
}

export async function spriteView(db: AssetDb, spriteName: string, imageIndex: number): Promise<Container | null> {
  const def = db.sprites[spriteName];
  const ft = await db.frameTexture(spriteName, imageIndex);
  if (!def || !ft) return null;
  const f = ft.frame as number[];
  const s = new Sprite(ft.tex);
  // frame is stored trimmed: it sits at (tgtX, tgtY) inside the full w x h box whose
  // origin is (ox, oy). tgt size can differ from src size on scaled pages.
  s.position.set(f[5] - def.ox, f[6] - def.oy);
  s.width = f[7];
  s.height = f[8];
  const c = new Container();
  c.addChild(s);
  return c;
}

export function markerView(label: string): Container {
  const view = new Container();
  view.addChild(
    new Graphics()
      .poly([0, -5, 5, 0, 0, 5, -5, 0])
      .fill({ color: 0x40c0ff, alpha: 0.8 })
      .stroke({ color: 0x0a2030, width: 1, pixelLine: true }),
  );
  const t = new Text({ text: label, style: { fontSize: 9, fill: 0xbfe6ff, fontFamily: "Consolas, monospace" } });
  t.position.set(7, -6);
  t.resolution = 4;
  view.addChild(t);
  return view;
}

export async function buildScene(db: AssetDb, room: Room, opts?: { zmode?: ZMode }): Promise<RoomScene> {
  const root = new Container();
  root.sortableChildren = true;
  const nodes: InstanceNode[] = [];
  // creation order breaks same-depth draw ties in "game" mode (later = on top); the
  // room's game_objects list is that order, layer arrays are not.
  const creationOrder = new Map<number, number>();
  {
    // game_objects is the source of truth for creation order (MSL imports it
    // positionally). Rooms that came in via a diff replay may not have one --
    // derive creation order from the layer arrays in that case, which is what
    // AddRoomJson ends up with for a GMS1-style file anyway.
    if (room.game_objects?.length) room.game_objects.forEach((g, i) => creationOrder.set(g.instance_id, i));
    else for (const e of allInstances(room)) creationOrder.set(e.inst.instance_id, creationOrder.size);
  }
  // the grid is a background, not an overlay: it must sit above the room's flat colour
  // fills (the void around interiors -- those are opaque, so below them it would be
  // invisible) but below every sprite, tile and instance, so it never covers game art.
  // A conflicting z (a fill in front of art) resolves to under everything. Instance
  // art z depends on the view mode, so applyZOrder re-seats the grid on every pass;
  // here we only track the mode-independent parts (fills and non-instance art).
  let maxFillZ = -1e9;
  let baseArtZ = 1e9;

  // preload every page the room touches, so the scene appears in one go
  const frames: Frame[] = [];
  for (const L of room.layers)
    for (const inst of (L.layer_type === LayerType.Instances ? L.layer_data.instances : []) as RoomInstance[]) {
      const spr = inst.object_definition && db.objects[inst.object_definition]?.sprite;
      if (spr && db.sprites[spr]) frames.push(...db.sprites[spr].frames);
    }
  await db.preload(frames);

  for (let li = 0; li < room.layers.length; li++) {
    const layer = room.layers[li];

    if (layer.layer_type === LayerType.Background) {
      const d = layer.layer_data;
      if (layer.is_visible && d.visible) {
        const { rgb, alpha } = gmColor(d.color);
        if (d.sprite) {
          const v = await spriteView(db, d.sprite, d.first_frame);
          if (v) {
            v.position.set(layer.x_offset, layer.y_offset);
            v.zIndex = -layer.layer_depth;
            baseArtZ = Math.min(baseArtZ, v.zIndex);
            root.addChild(v);
          }
        } else {
          // a sprite-less background layer is a flat fill of its colour
          const g = new Graphics().rect(0, 0, room.width, room.height).fill({ color: rgb, alpha });
          g.zIndex = -layer.layer_depth;
          maxFillZ = Math.max(maxFillZ, g.zIndex);
          root.addChild(g);
        }
      }
      continue;
    }

    if (layer.layer_type === LayerType.Assets) {
      for (const a of layer.layer_data.sprites ?? []) {
        if (!a.sprite) continue;
        const v = await spriteView(db, a.sprite, a.frame_index);
        if (!v) continue;
        v.position.set(a.x, a.y);
        v.scale.set(a.scale_x, a.scale_y);
        v.rotation = (-a.rotation * Math.PI) / 180;
        const { rgb, alpha } = gmColor(a.color);
        (v.children[0] as Sprite).tint = rgb;
        v.alpha = alpha;
        v.zIndex = -layer.layer_depth;
        v.visible = layer.is_visible;
        baseArtZ = Math.min(baseArtZ, v.zIndex);
        root.addChild(v);
      }
      continue;
    }

    if (layer.layer_type !== LayerType.Instances) continue;

    const insts = layer.layer_data.instances as RoomInstance[];
    for (let ii = 0; ii < insts.length; ii++) {
      const inst = insts[ii];
      const obj = inst.object_definition ?? "";
      const def = db.objects[obj];
      let [depth, depthWhy] = resolveDepth(db, obj, inst, layer);
      const [vis, visibleWhy] = resolveVisible(db, obj, layer);
      const draw = db.createOf(obj)?.draw;
      if (draw?.mode === "baked") {
        depth = draw.depth!;
        depthWhy = t("{depth}（scr_bgRenderAdd 烙进背景 surface，{from}）", { depth: draw.depth, from: draw.from });
      }
      const spriteName = def?.sprite;

      let kind: NodeKind = "marker";
      let view: Container | null = null;
      if (MARKER_OVERLAY_OBJECTS.has(obj)) {
        kind = "hidden";
        view = spriteName ? await spriteView(db, spriteName, inst.image_index) : markerView(obj.replace(/^o_/, ""));
      } else if (spriteName && COLLISION_SPRITES.has(spriteName)) {
        kind = "collision";
        view = new Container();
        view.addChild(
          new Graphics()
            .rect(0, 0, CELL, CELL)
            .fill({ color: 0xff3040, alpha: 0.38 })
            // inner stroke: a scaled middle stroke would inflate getBounds by
            // scale/2 px per side, lying about the stamp's true 26px footprint
            // (pixi v8 alignment: 1 = inner, 0 = outer -- measured, not documented)
            .stroke({ color: 0xff5060, width: 1, alpha: 0.9, pixelLine: true, alignment: 1 }),
        );
      } else if (spriteName) {
        view = await spriteView(db, spriteName, inst.image_index);
        if (view) kind = vis ? "drawn" : "hidden";
      }
      if (!view) {
        kind = "marker";
        view = markerView(obj.replace(/^o_/, ""));
      }
      // a sprite view of an invisible object belongs to the hidden band: visible=false
      // means "the game skips its Draw", so it is an overlay, not part of the picture.
      // (o_barrier's `-y+18` facts must not drag these into the art band.)
      if (kind === "drawn" && !vis) kind = "hidden";

      view.position.set(inst.x, inst.y);
      if (kind !== "marker") {
        view.scale.set(inst.scale_x, inst.scale_y);
        view.rotation = (-inst.rotation * Math.PI) / 180;
      }
      if (kind === "drawn" || kind === "hidden") {
        const { rgb, alpha } = gmColor(inst.color);
        (view.children[0] as Sprite).tint = rgb;
        view.alpha = alpha;
      }
      // z is assigned by applyZOrder at the end of the build (and re-assigned live
      // on every view-mode / selection change, without rebuilding the scene)
      const node: InstanceNode = {
        kind, layerIndex: li, instIndex: ii, layer, inst, depth, depthWhy, visibleWhy,
        customDraw: draw?.mode === "custom" || !!draw?.extra, view,
      };
      nodes.push(node);
      root.addChild(view);
    }
  }

  const gridLayer = new Graphics();
  root.addChild(gridLayer); // applyZOrder seats it above the fills, below the art
  const boundsLayer = new Graphics();
  boundsLayer.zIndex = 2e8 + 1;
  root.addChild(boundsLayer);

  const scene: RoomScene = { root, nodes, gridLayer, boundsLayer, maxFillZ, baseArtZ, creationOrder };
  applyZOrder(scene, opts?.zmode ?? "game", new Set());
  return scene;
}

// the grid is editor chrome, not game data: its colours come from the caller's UI
// theme (defaults = the dark theme, which render mode always uses). The labels need
// no outline halo: applyZOrder seats the grid below every sprite, so they only ever
// appear over the uniform sheet or the room's flat fill layers.
export function drawGrid(g: Graphics, room: Room, zoom: number, labels = false, line = 0xffffff, major = 0xffe08a) {
  g.clear();
  g.removeChildren().forEach((c) => c.destroy());
  for (let x = 0; x <= room.width; x += CELL) g.moveTo(x, 0).lineTo(x, room.height);
  for (let y = 0; y <= room.height; y += CELL) g.moveTo(0, y).lineTo(room.width, y);
  g.stroke({ color: line, width: 1 / zoom, alpha: 0.12 });
  if (!labels) return;
  // cell numbers every 5 cells, the same numbering `svre grid` prints
  const style = { fontSize: 10, fill: major, fontFamily: "Consolas, monospace" };
  const cells = (n: number) => Math.ceil(n / CELL);
  for (let gx = 0; gx < cells(room.width); gx += 5)
    for (let gy = 0; gy < cells(room.height); gy += 5) {
      const t = new Text({ text: `${gx},${gy}`, style });
      t.resolution = 3;
      t.scale.set(1 / zoom);
      t.position.set(gx * CELL + 2 / zoom, gy * CELL + 1 / zoom);
      t.alpha = 0.85;
      g.addChild(t);
    }
  for (let gx = 0; gx < cells(room.width); gx += 5) g.moveTo(gx * CELL, 0).lineTo(gx * CELL, room.height);
  for (let gy = 0; gy < cells(room.height); gy += 5) g.moveTo(0, gy * CELL).lineTo(room.width, gy * CELL);
  g.stroke({ color: major, width: 1 / zoom, alpha: 0.35 });
}

export function drawBounds(g: Graphics, room: Room, zoom: number, color = 0xffd479) {
  g.clear();
  g.rect(0, 0, room.width, room.height).stroke({ color, width: 1.5 / zoom, alpha: 0.7 });
}
