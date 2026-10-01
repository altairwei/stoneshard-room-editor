// The browser half of the shared document. The dev server (server/store.ts) owns every
// room project; this client renders its state and turns gestures into ops posted to
// /api/doc/<name>/apply. The same ops, rules and undo history serve the human here and
// agents over the `svre` CLI.
//
// Sync protocol:
//   own edits   POST apply -> replay the normalized ops the server returns onto the local
//               room copy (so allocated ids match) -> rebuild the scene. Serialized through
//               a queue so local replay order == server log order.
//   others'     "svre:event" over the Vite websocket (change/undo/notes/reloaded by anyone
//               else, selection by anyone else) -> refetch the snapshot, rebuild, toast.
//   conflicts   a 409 from apply means the room moved under us: refetch, toast, drop the edit.
import "./style.css";
import { Application, Container, Graphics, Text } from "pixi.js";
import { AssetDb } from "./assets";
import { CELL, LayerType, findInstance, type Room, type RoomInstance } from "./core/room.ts";
import { applyAll, type Op } from "./core/ops.ts";
import type { Note, ReplayProblem } from "./core/project.ts";
import { applyZOrder, buildScene, drawBounds, drawGrid, markerView, spriteView, type InstanceNode, type RoomScene, type ZMode } from "./render";
import { FAMILIES, searchObjects, thumbHtml, type Family } from "./palette";
import { ICONS, hydrateIcons } from "./icons.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

const BY = "human"; // this client's author identity in the log

// ---------------- server shapes ----------------

interface RoomEntry { name: string; hasProject: boolean; hasCompiled: boolean; dirty: boolean; drift: boolean; generatedBy: string[] }
interface LogSummary { rev: number; by: string; at: string; label: string; note?: string; undoOf?: number; ops: number; ids: number[] }
interface Finding { level: string; message: string }
interface DocSnapshot {
  name: string; rev: number; compiledRev: number | null; dirty: boolean; drift: boolean;
  base: unknown; baseChanged: boolean; problems: ReplayProblem[]; notes: Note[];
  log: LogSummary[]; selection: Record<string, { ids: number[]; at: string }>;
  undoable: string[]; redoable: string[]; room: Room;
}

class ApiError extends Error {
  status: number;
  detail: unknown;
  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* grid is text */ }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? text ?? res.statusText, data?.detail);
  return data ?? text;
}

// ---------------- client state ----------------

const db = new AssetDb();
const app = new Application();
const world = new Container(); // pan/zoom lives here
const ghostLayer = new Container(); // placement preview, in world space
const notesLayer = new Container(); // note pins, in world space
const overlay = new Graphics(); // screen-space outlines and marquee
const artboard = new Graphics(); // pasteboard sheet under the room (world space, index 0)

let rooms: RoomEntry[] = [];
let doc: DocSnapshot | null = null;
let scene: RoomScene | null = null;
let nodeById = new Map<number, InstanceNode>();
let zoom = 1;
let hovered: number | null = null; // instance id
const selection = new Set<number>(); // instance ids
const remoteSel = new Map<string, number[]>(); // other authors' selections
let flash = new Map<number, number>(); // id -> highlight-until timestamp (history click)
let activeLayer = -1;
const layerOff = new Set<number>();
type Tool =
  | { kind: "select" }
  | { kind: "hand" }
  | { kind: "note" }
  | { kind: "place"; object: string } // palette pick, single clicks
  | { kind: "collision" } // drag out an o_hut_wall rectangle (vanilla idiom: 78% are scaled rects)
  | { kind: "barrier" } // paint/erase o_projectileBarrier cells like a bucket/eraser
  | { kind: "zone"; object: string } // drag out a scaled plain-box object (trigger, camera, surface…)
  | { kind: "marker"; object: string }; // click to drop a functional marker (starter, light…)
let tool: Tool = { kind: "select" };
let lastPlaced: string | null = null; // the P key re-arms the last palette pick
let zoneObject = "oCameraStatic";
let markerObject = "o_position_starter";
let zoneObjectsCache: Promise<string[]> | null = null;
let markerObjectsCache: string[] | null = null;
// o_hut_wall is THE walk-grid collision stamp: the only room object that writes
// o_controller.newgrid; sprite s_handmadeCollision 26×26 at origin (0,0). Vanilla
// places it as scaled rectangles (78% of 28361 instances), so the C tool drags rects.
const COLLISION_PAINT = "o_hut_wall";
// o_projectileBarrier is the same kind of self-destructing grid stamper for the
// wallgrid (blocks projectiles; Alarm_0 stamps value 2 over its footprint); vanilla
// keeps them on a "Projectiles" layer, half of them 1×1 cells.
const BARRIER_PAINT = "o_projectileBarrier";
// paint tools write one of these two objects; everything user-facing picks the label
const paintLabel = (object: string) => (object === BARRIER_PAINT ? "屏障" : "碰撞");
const hiddenInsts = new Set<number>(); // per-instance editor-local hide (the eyes in the 图层 tab)
let dragRowId: number | null = null; // instance row mid-drag in the 图层 tab

// Edge auto-scroll while dragging a row: HTML5 drags suppress the wheel and give no
// native edge scrolling, so a row could only move within one viewport. While a drag is
// active a rAF loop scrolls the tab's section proportionally to how deep the pointer
// sits in the top/bottom edge band. The 150ms dwell keeps a quick drop AT the edge
// from scrolling first (e2e's drag_to hovers only briefly before mouseup).
let dragScrollY = -1; // last dragover clientY during a row drag
let dragScrollSince = 0; // when the pointer entered the edge band (0 = outside)
let dragScrollRaf = 0;
function dragScrollTick(section: HTMLElement) {
  if (dragRowId === null) { dragScrollRaf = 0; dragScrollY = -1; dragScrollSince = 0; return; }
  const r = section.getBoundingClientRect();
  const EDGE = 28, MAX = 12;
  let v = 0;
  if (dragScrollY >= 0) {
    if (dragScrollY < r.top + EDGE) v = -MAX * (1 - Math.max(0, dragScrollY - r.top) / EDGE);
    else if (dragScrollY > r.bottom - EDGE) v = MAX * (1 - Math.max(0, r.bottom - dragScrollY) / EDGE);
  }
  const now = performance.now();
  if (v === 0) dragScrollSince = 0;
  else {
    if (!dragScrollSince) dragScrollSince = now;
    if (now - dragScrollSince > 150) section.scrollTop += v;
  }
  dragScrollRaf = requestAnimationFrame(() => dragScrollTick(section));
}
function armDragScroll(section: HTMLElement | null) {
  if (!section || dragScrollRaf) return;
  dragScrollY = -1;
  dragScrollRaf = requestAnimationFrame(() => dragScrollTick(section));
}
let clipboard: { layerName: string | null; inst: RoomInstance }[] = [];
let cursorWorld = { x: 0, y: 0 };
let spaceHeld = false;
let altHeld = false;
let family: Family = FAMILIES[0];
let lintFindings: Finding[] = [];
let lastSeenRev = 0; // history badge counts entries past this
let renderMode = false;

// Coverage rectangles (collision stamps, wall/trigger/surface boxes) are solid-colour
// sprites; drag-resize handles are offered only for those, so game art never stretches.
// Decided from the pixels, not a name list: new vanilla coverage objects qualify on
// their own, and multi-colour art (chests, cave walls, floor bakes) never does.
const plainBoxCache = new Map<string, Promise<boolean>>();
function plainBoxSprite(sprite: string): Promise<boolean> {
  let p = plainBoxCache.get(sprite);
  if (!p) {
    p = (async () => {
      const ft = await db.frameTexture(sprite, 0);
      if (!ft) return false;
      const [, sx, sy, sw, sh] = ft.frame as number[];
      const c = document.createElement("canvas");
      c.width = Math.max(1, sw);
      c.height = Math.max(1, sh);
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(ft.tex.source.resource as CanvasImageSource, -sx, -sy);
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let opaque = 0;
      const colors = new Set<string>();
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] <= 8) continue;
        opaque++;
        colors.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
        if (colors.size > 4) return false;
      }
      return opaque / (data.length / 4) >= 0.98;
    })();
    plainBoxCache.set(sprite, p);
  }
  return p;
}
const resizeGate = new Map<number, boolean>(); // instance id -> drag-resize allowed
async function computeResizeGate(n: InstanceNode): Promise<boolean> {
  const id = n.inst.instance_id;
  const hit = resizeGate.get(id);
  if (hit !== undefined) return hit;
  let ok = false;
  try {
    if (n.kind !== "marker" && Math.abs(n.inst.rotation) < 0.001) {
      const spr = db.objects[n.inst.object_definition ?? ""]?.sprite;
      ok = !!spr && (await plainBoxSprite(spr));
    }
  } catch {
    ok = false;
  }
  resizeGate.set(id, ok);
  return ok;
}

const toggles = {
  snap: $<HTMLInputElement>("t-snap"),
  hidden: $<HTMLInputElement>("t-hidden"),
  collision: $<HTMLInputElement>("t-collision"),
  markers: $<HTMLInputElement>("t-markers"),
  grid: $<HTMLInputElement>("t-grid"),
  notes: $<HTMLInputElement>("t-notes"),
};

const room = () => doc!.room;
const snapOn = () => toggles.snap.checked && !altHeld;
const snapPoint = (v: number) => (snapOn() ? Math.floor(v / CELL) * CELL : Math.round(v));
const instsOf = (ids: Iterable<number>) =>
  [...ids].map((id) => findInstance(room(), id)).filter((a): a is NonNullable<typeof a> => !!a);

// ---------------- toasts ----------------

function toast(text: string, ms = 4200) {
  if (renderMode) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------- canvas draw order (游戏 / 静态) ----------------
//
// The canvas defaults to "game": runtime depth simulation, the occlusion you will
// actually get. "static" is UTMT's data view (layer depth + array position), kept for
// auditing the raw lists. Selected DRAWN instances lift above everything so the thing
// being aimed can never be hidden; deselecting drops them back to the true order.
let zMode: ZMode = (() => {
  try {
    return localStorage.getItem("svre.zmode") === "static" ? "static" : "game";
  } catch {
    return "game"; // private mode: no persisted preference
  }
})();
let zSig = ""; // mode | scene generation | sorted selection -- skip work when unchanged
let sceneGen = 0;

// drawOverlay calls this on every hover; only a changed signature does real work
function applyZ() {
  if (!scene || !doc) return;
  const sig = `${zMode}|${sceneGen}|${[...selection].sort((a, b) => a - b).join(",")}`;
  if (sig === zSig) return;
  zSig = sig;
  applyZOrder(scene, zMode, selection);
  requestRender();
}

function setZMode(m: ZMode) {
  zMode = m;
  try {
    localStorage.setItem("svre.zmode", m);
  } catch {
    /* best effort */
  }
  const b = $("b-zmode");
  b.textContent = m === "game" ? "顺序：游戏" : "顺序：静态";
  b.classList.toggle("static", m === "static");
  applyZ();
}

// objects whose runtime depth is fixed by code: reordering or relayering them cannot
// change the game picture. Say so out loud -- a silent no-op reads as "the editor is
// broken" (it did, once).
function depthCodedWhy(obj: string): string | null {
  const c = db.createOf(obj);
  if (!c) return null;
  if (c.draw?.mode === "baked") return "烙进背景 surface";
  const d = c.depth;
  if (d && !d.conditional && d.mode === "y") return "游戏内按 depth=-y 排序";
  if (d && !d.conditional && d.mode === "const") return `游戏内 depth 恒为 ${d.value}`;
  return null;
}
const depthToastAt = new Map<string, number>();
function toastDepthCoded(obj: string) {
  const why = depthCodedWhy(obj);
  if (!why) return;
  const now = Date.now();
  if (now - (depthToastAt.get(obj) ?? -1e9) < 8000) return; // one reminder per object per drag session
  depthToastAt.set(obj, now);
  toast(`${obj} ${why}：调序不影响游戏内遮挡，只改静态视图与创建顺序`);
}

// ================= boot =================

async function init() {
  const params = new URLSearchParams(location.search);
  renderMode = params.get("render") === "1";
  if (renderMode) document.body.classList.add("render");
  hydrateIcons();

  const host = $("stage");
  await app.init({ resizeTo: host, background: renderMode ? 0x0d0e11 : 0x2a2a2a, antialias: false, roundPixels: true, autoDensity: true, resolution: devicePixelRatio });
  host.appendChild(app.canvas);
  world.addChild(artboard); // index 0, under every scene root
  ghostLayer.alpha = 0.65;
  app.stage.addChild(world, notesLayer, overlay);
  // render on demand: the scene is static between mutations, and software GL charges full
  // price for every frame. A slow heartbeat covers async texture arrivals and any missed
  // invalidation; every mutation path below calls requestRender().
  app.ticker.stop();
  setInterval(() => app.render(), 500);
  requestRender();
  // resizeTo only tracks the window; the stage also changes when the banner or dock reflows
  new ResizeObserver(() => { app.resize(); drawOverlay(); }).observe(host);

  $("load-state").textContent = "加载资产…";
  await db.load();
  await refreshRooms();

  for (const t of Object.values(toggles)) t.onchange = () => { applyVisibility(); };
  $("b-fit").onclick = fit;
  $("b-1x").onclick = () => zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
  $("b-zoom-out").onclick = () => zoomStep(-1);
  $("b-zoom-in").onclick = () => zoomStep(1);
  const zp = $<HTMLSelectElement>("zoom-preset");
  zp.onchange = () => {
    if (zp.value === "fit") fit();
    else if (zp.value) zoomAt(Number(zp.value) / 100, host.clientWidth / 2, host.clientHeight / 2);
    zp.value = ""; // redrawZoomDependent rewrites the current-% option
  };
  $("b-compile").onclick = compileDoc;
  $("b-undo").onclick = () => undoRedo("undo");
  $("b-redo").onclick = () => undoRedo("redo");
  $("b-new").onclick = openNewDialog;
  $("b-zmode").onclick = () => setZMode(zMode === "game" ? "static" : "game");
  setZMode(zMode); // sync the button label with the persisted preference
  wireToolbox();
  wireTabs();
  wireDock();
  wirePalette();
  wireInsts();
  wireViewport(host);
  wireKeys(host);
  wireWs();

  const initial = params.get("room");
  if (renderMode) {
    // svre render: bare canvas, overlays from the URL, ready flag for the screenshotter
    for (const k of ["grid", "collision", "hidden", "markers", "notes"] as const)
      toggles[k].checked = params.get(k) === "1";
    const zm = params.get("z"); // ?z=static renders the UTMT audit view instead
    if (zm === "game" || zm === "static") setZMode(zm);
    if (initial) await openRoom(initial, { silent: true });
    const focus = params.get("focus")?.split(",").map(Number);
    const z = Number(params.get("zoom"));
    if (focus && focus.length === 2 && focus.every(Number.isFinite)) focusOn(focus[0], focus[1], Number.isFinite(z) && z > 0 ? z : zoom);
    else fit();
    app.render(); // deterministic pixels before the screenshotter's ready flag
    (window as any).svreReady = true;
    return;
  }
  if (initial ?? rooms[0]?.name) await openRoom(initial ?? rooms[0].name);
}

async function refreshRooms(selectAfter?: string) {
  rooms = await api("/api/rooms");
  const sel = $<HTMLSelectElement>("room-select");
  sel.innerHTML = rooms
    .map((r) => {
      const marks = `${r.hasProject ? "" : " · 未导入"}${r.dirty ? " ●" : ""}${r.drift ? " ⚠ 漂移" : ""}`;
      return `<option value="${esc(r.name)}">${esc(r.name)}${marks}</option>`;
    })
    .join("");
  sel.onchange = () => openRoom(sel.value);
  if (selectAfter) sel.value = selectAfter;
  else if (doc) sel.value = doc.name;
}

// ---------------- open / sync ----------------

async function openRoom(name: string, opts: { silent?: boolean } = {}) {
  const entry = rooms.find((r) => r.name === name);
  if (entry && !entry.hasProject) {
    // a compiled room with no project yet: offer to adopt it into a project
    if (opts.silent || !confirm(`房间 ${name} 尚未导入。是否从 Codes/${name}.gml 创建工程？基底将自动推断。`)) {
      $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
      return;
    }
    try {
      const r = await api("/api/import", "POST", { name, by: BY });
      toast(`已导入 ${name}：基底 ${r.base}，${r.ops} 条操作`);
    } catch (e) {
      alert(`导入失败：${(e as Error).message}`);
      $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
      return;
    }
    await refreshRooms(name);
  }
  $("load-state").textContent = `打开 ${name}…`;
  let snap: DocSnapshot;
  try {
    snap = await api(`/api/doc/${name}`);
  } catch (e) {
    $("load-state").textContent = `打开失败：${(e as Error).message}`;
    return;
  }
  doc = snap;
  selection.clear();
  hovered = null;
  layerOff.clear();
  hiddenInsts.clear();
  remoteSel.clear();
  flash.clear();
  activeLayer = guessActiveLayer();
  lastSeenRev = snap.rev;
  setTool({ kind: "select" });
  await refreshScene();
  fit();
  updateChrome();
  refreshLint();
  history.replaceState(null, "", `?room=${encodeURIComponent(name)}`);
}

// pull the server's state wholesale (someone else edited, undo/redo, adopt, 409 recovery)
async function syncDoc() {
  if (!doc) return;
  doc = await api(`/api/doc/${doc.name}`);
  for (const id of [...selection]) if (!findInstance(room(), id)) selection.delete(id);
  await refreshScene();
  updateChrome();
}

// the layer new things go to: a well-known one, else the first instance layer
function guessActiveLayer(): number {
  const r = room();
  const prefer = ["ForegroundInstances", "Entity", "StuffInstances", "Instances"];
  for (const n of prefer) {
    const i = r.layers.findIndex((L) => L.layer_name === n && L.layer_type === LayerType.Instances);
    if (i >= 0) return i;
  }
  return r.layers.findIndex((L) => L.layer_type === LayerType.Instances);
}

// ---------------- edits ----------------

// Serialize commits so local replay order matches the server log.
let commitQueue: Promise<unknown> = Promise.resolve();

function commit(label: string, ops: Op[]): Promise<boolean> {
  const run = commitQueue.then(() => commitNow(label, ops));
  commitQueue = run.catch(() => {});
  return run;
}

async function commitNow(label: string, ops: Op[]): Promise<boolean> {
  if (!doc || !ops.length) return false;
  const name = doc.name;
  try {
    const r = await api(`/api/doc/${name}/apply`, "POST", { by: BY, label, ops });
    if (!doc || doc.name !== name) return true; // the user switched rooms mid-flight; the server still logged it
    applyAll(room(), r.ops); // replay the server's normalized ops (ids, expects) locally
    doc.rev = r.rev;
    doc.log.push({ rev: r.rev, by: BY, at: new Date().toISOString(), label, ops: r.ops.length, ids: r.ids ?? [] });
    lintFindings = r.findings ?? lintFindings;
    await refreshScene();
    updateChrome();
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      toast(`冲突：${e.message}，已刷新到最新状态`);
      await syncDoc();
      return false;
    }
    toast(`编辑失败：${(e as Error).message}`);
    return false;
  }
}

async function undoRedo(which: "undo" | "redo") {
  if (!doc) return;
  try {
    await api(`/api/doc/${doc.name}/${which}`, "POST", { by: BY });
    await syncDoc();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast(which === "undo" ? "没有可撤销的修改" : "没有可重做的修改");
    else toast((e as Error).message);
    updateChrome();
  }
}

async function compileDoc() {
  if (!doc) return;
  try {
    const r = await api(`/api/doc/${doc.name}/compile`, "POST", {});
    lintFindings = r.findings ?? [];
    toast(`已编译 ${r.file}（r${r.rev}），已同步 ${r.roomsCs}${lintFindings.length ? ` · ⚠ ${lintFindings.length} 条检查警告` : ""}`);
    await syncDoc();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (Array.isArray(e.detail)) {
        alert(`日志无法在基底上完整重放，请先处理以下问题：\n\n${(e.detail as ReplayProblem[]).map((p) => `r${p.rev}：${p.message}`).join("\n")}`);
      } else if (confirm(`${e.message}\n\n「确定」采纳磁盘上的外部改动（记入一条 external 日志）；「取消」不做改动。`)) {
        await adoptDoc();
        await compileDoc();
      }
    } else alert(`编译失败：${(e as Error).message}`);
  }
}

async function adoptDoc() {
  if (!doc) return;
  try {
    const r = await api(`/api/doc/${doc.name}/adopt`, "POST", { by: "external" });
    toast(r.ops ? `已采纳外部改动：${r.ops} 条操作已记入日志` : "磁盘文件与当前状态一致");
    await syncDoc();
    await refreshRooms(doc.name);
  } catch (e) {
    alert(`采纳失败：${(e as Error).message}`);
  }
}

async function refreshLint() {
  if (!doc || renderMode) return;
  try {
    lintFindings = await api(`/api/doc/${doc.name}/lint`);
    updateChrome();
  } catch { /* lint is advisory */ }
}

// ---------------- scene ----------------

async function refreshScene() {
  if (!doc) return;
  const next = await buildScene(db, room(), { zmode: zMode });
  if (scene) {
    world.removeChild(scene.root);
    scene.root.destroy({ children: true });
  }
  scene = next;
  sceneGen++; // force applyZ: fresh nodes carry no selection lift yet
  resizeGate.clear(); // gates are per instance; classification re-asks the sprite cache
  world.addChild(scene.root);
  world.addChild(ghostLayer); // keep the ghost on top
  nodeById = new Map(scene.nodes.map((n) => [n.inst.instance_id, n]));
  if (hovered !== null && !nodeById.has(hovered)) hovered = null;
  applyZ();
  applyVisibility();
  renderLayerList();
  renderInstList();
  renderPaletteRoom();
  renderHistory();
  drawNotes();
  inspect();
  postSelection();
}

function applyVisibility() {
  if (!scene || !doc) return;
  for (const n of scene.nodes) {
    let on = !layerOff.has(n.layerIndex) && !hiddenInsts.has(n.inst.instance_id);
    if (n.kind === "hidden") on &&= toggles.hidden.checked;
    if (n.kind === "collision") on &&= toggles.collision.checked;
    if (n.kind === "marker") on &&= toggles.markers.checked;
    n.view.visible = on;
    // no alpha fudging: hidden-band sprites render at their natural alpha, same
    // as UTMT shows them (s_pbluebox is alpha-196 by itself, sprite0 fully opaque)
  }
  scene.gridLayer.visible = toggles.grid.checked;
  notesLayer.visible = toggles.notes.checked;
  redrawZoomDependent();
}

function updateChrome() {
  if (!doc) return;
  const dirty = doc.dirty;
  const bc = $<HTMLButtonElement>("b-compile");
  bc.classList.toggle("primary", dirty);
  bc.innerHTML = `${ICONS.compile}<span>编译</span>${dirty ? '<span class="dirty-dot" title="有未编译的改动">●</span>' : ""}`;
  const canUndo = doc.undoable.includes(BY);
  const canRedo = doc.redoable.includes(BY);
  $<HTMLButtonElement>("b-undo").disabled = !canUndo;
  $<HTMLButtonElement>("b-redo").disabled = !canRedo;
  document.title = `${dirty ? "● " : ""}${room().name} — SV Room Editor`;
  const counts = scene!.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  $("load-state").innerHTML =
    `${esc(room().name)} · r${doc.rev}${doc.compiledRev !== null ? ` · 编译于 r${doc.compiledRev}` : " · 从未编译"}` +
    ` · ${room().width}×${room().height} · 可见 ${counts.drawn ?? 0} · 隐形 ${counts.hidden ?? 0} · 碰撞 ${counts.collision ?? 0} · 标记 ${counts.marker ?? 0}` +
    (lintFindings.length ? ` · <span style="color:var(--warn)" title="${esc(lintFindings.map((f) => f.message).join("\n"))}">⚠ ${lintFindings.length} 条检查警告</span>` : "");

  // badge = entries arrived since the history tab was last open
  const unseen = doc.log.filter((e) => e.rev > lastSeenRev).length;
  $("history-badge").textContent = unseen ? String(unseen) : "";

  // banner: drift and a changed base are the two states that need a decision
  const entry = rooms.find((r) => r.name === doc!.name);
  const banner = $("banner");
  let html = "";
  if (doc.drift)
    html = `⚠ 磁盘上的 rooms/${esc(doc.name)}.compiled.json 在上次编译后被外部修改（生成器或手工编辑）。编译前请先采纳，或强制覆盖。<button data-act="adopt">采纳外部改动</button>`;
  else if (doc.baseChanged)
    html = `⚠ 基底房间已变更（可能是游戏更新）。日志仍会照常重放${doc.problems.length ? `，但有 ${doc.problems.length} 条操作无法对应` : ""}。`;
  else if (doc.problems.length)
    html = `⚠ ${doc.problems.length} 条日志无法在基底上重放，编译将被拒绝。`;
  else if (entry?.generatedBy.length)
    html = `此房间曾由 ${esc(entry.generatedBy.join("、"))} 生成。工程已接管其内容，请勿再运行生成器，否则会覆盖编译产物。`;
  banner.hidden = !html;
  banner.innerHTML = html;
  banner.querySelector('button[data-act="adopt"]')?.addEventListener("click", adoptDoc);
}

// ================= layers panel =================

function renderLayerList() {
  if (!doc || !scene) return;
  const list = $("layer-list");
  const typeName: Record<number, string> = { 0: "path", 1: "背景", 2: "实例", 3: "资产", 4: "瓦片" };
  list.innerHTML = room().layers
    .map((L, i) => {
      const inst = L.layer_type === LayerType.Instances;
      const n = inst ? L.layer_data.instances.length : "";
      const cls = [layerOff.has(i) ? "off" : "", i === activeLayer ? "active" : "", inst ? "" : "nonedit"].join(" ");
      return `<li data-i="${i}" class="${cls}" title="${inst ? "单击设为当前图层（新对象将放入此层）" : "非实例图层，只读"}">
        <span class="eye" data-eye="${i}" title="显示/隐藏">${layerOff.has(i) ? ICONS.eyeOff : ICONS.eye}</span>
        <span class="name">${esc(L.layer_name)}${L.is_visible ? "" : ' <span class="tag">游戏内隐藏</span>'}</span>
        <span class="meta">${typeName[L.layer_type] ?? L.layer_type} ${n} · d${L.layer_depth}</span></li>`;
    })
    .join("");
  list.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", (e) => {
      const i = Number((li as HTMLElement).dataset.i);
      if ((e.target as Element).closest("[data-eye]")) {
        layerOff.has(i) ? layerOff.delete(i) : layerOff.add(i);
        applyVisibility();
      } else if (room().layers[i].layer_type === LayerType.Instances) {
        activeLayer = i;
      }
      renderLayerList();
    });
  });
}

// ================= instance layers (the real, Photoshop-style 图层) =================
//
// Each row is one instance. Groups are GameMaker layers sorted by depth, front-most
// first; inside a group the array order is reversed (later in the array = drawn on
// top in the static / UTMT view). The array order is the DATA this tab edits, and it
// is mirrored into game_objects, the game's creation order. Dragging a row between
// two rows of the same group reorders it; dragging across groups relayers. Both are
// the `relayer` op — same-layer relayer IS the reorder op.
// The canvas defaults to the GAME's order (runtime depth simulation): rows with a
// depth badge are sorted by their depth code there, so for them this list's order
// only feeds the static view and the creation-order tie-break -- reordering cannot
// change their game occlusion (a toast says so when you try).

function renderInstList() {
  if (!doc || !scene || $("tab-insts").hidden) return;
  const q = $<HTMLInputElement>("insts-q").value.trim().toLowerCase();
  const groups = room()
    .layers.map((L, i) => ({ L, i }))
    .filter(({ L }) => L.layer_type === LayerType.Instances)
    .sort((a, b) => a.L.layer_depth - b.L.layer_depth);
  const rows: string[] = [];
  for (const { L, i } of groups) {
    const insts = (L.layer_data.instances as RoomInstance[]).slice().reverse(); // front-most first
    const shown = insts.filter((inst) => !q || (inst.object_definition ?? "").toLowerCase().includes(q) || String(inst.instance_id).includes(q));
    if (q && !shown.length) continue;
    rows.push(`<li class="grp${i === activeLayer ? " active" : ""}" data-gi="${i}" title="单击设为放置目标层；将实例拖到此行即移至该层最前">
      <span class="gname">${esc(L.layer_name)}</span><span class="gmeta">d${L.layer_depth} · ${insts.length}</span></li>`);
    for (const inst of shown) {
      const n = nodeById.get(inst.instance_id);
      const obj = inst.object_definition ?? "";
      const badge = n && n.depth !== L.layer_depth ? `<span class="depth-badge" title="${esc(n.depthWhy)}">d${n.depth}</span>` : "";
      rows.push(`<li class="inst${selection.has(inst.instance_id) ? " sel" : ""}${hiddenInsts.has(inst.instance_id) ? " off" : ""}"
        data-id="${inst.instance_id}" draggable="true" title="${esc(obj)} #${inst.instance_id}&#10;${esc(n?.depthWhy ?? "")}&#10;拖动调整数组顺序（组内调序 / 跨组换层）">
        <span class="grip">${ICONS.grip}</span>${thumbHtml(db, obj, inst.image_index, 28)}
        <div class="itext"><div class="iname">${esc(obj)} <span class="iid">#${inst.instance_id}</span>${badge}</div>
        <div class="imeta">@${inst.x},${inst.y}${inst.scale_x !== 1 || inst.scale_y !== 1 ? ` · ${inst.scale_x}×${inst.scale_y}` : ""}</div></div>
        <span class="eye" data-eye="${inst.instance_id}" title="编辑器内隐藏（不影响游戏）">${hiddenInsts.has(inst.instance_id) ? ICONS.eyeOff : ICONS.eye}</span></li>`);
    }
  }
  const list = $("inst-list");
  list.innerHTML = rows.join("") || `<li class="muted" style="padding:10px">没有匹配的实例</li>`;
  wireInstRows(list);
}

function wireInstRows(list: HTMLElement) {
  list.querySelectorAll<HTMLElement>("li.inst").forEach((li) => {
    const id = Number(li.dataset.id);
    li.addEventListener("click", (e) => {
      if ((e.target as Element).closest("[data-eye]")) {
        hiddenInsts.has(id) ? hiddenInsts.delete(id) : hiddenInsts.add(id);
        li.classList.toggle("off");
        li.querySelector("[data-eye]")!.innerHTML = hiddenInsts.has(id) ? ICONS.eyeOff : ICONS.eye;
        applyVisibility();
        return;
      }
      if (e.shiftKey || e.ctrlKey) selection.has(id) ? selection.delete(id) : selection.add(id);
      else { selection.clear(); selection.add(id); }
      const at = findInstance(room(), id);
      if (at) activeLayer = at.layer;
      renderLayerList();
      syncInstSelection(false);
      inspect();
      drawOverlay();
      postSelection();
    });
    li.addEventListener("dblclick", () => {
      const at = findInstance(room(), id);
      if (at) focusOn(at.inst.x, at.inst.y, Math.max(zoom, 2));
    });
    li.addEventListener("dragstart", (e) => {
      dragRowId = id;
      armDragScroll(li.closest("section") as HTMLElement | null);
      if (!selection.has(id)) {
        selection.clear();
        selection.add(id);
        syncInstSelection(false);
        inspect();
        drawOverlay();
        postSelection();
      }
      e.dataTransfer?.setData("text/plain", String(id));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    li.addEventListener("dragover", (e) => {
      if (dragRowId === null || dragRowId === id) return;
      e.preventDefault();
      const r = li.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      li.classList.toggle("drop-before", !after);
      li.classList.toggle("drop-after", after);
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-before", "drop-after"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drop-before", "drop-after");
      if (dragRowId === null || dragRowId === id) return;
      const after = e.clientY > li.getBoundingClientRect().top + li.getBoundingClientRect().height / 2;
      dropInstAt(dragRowId, { kind: "row", id, after });
      dragRowId = null;
    });
    li.addEventListener("dragend", () => { dragRowId = null; });
  });
  list.querySelectorAll<HTMLElement>("li.grp").forEach((li) => {
    const gi = Number(li.dataset.gi);
    li.addEventListener("click", () => {
      activeLayer = gi;
      renderLayerList();
      renderInstList();
    });
    li.addEventListener("dragover", (e) => {
      if (dragRowId === null) return;
      e.preventDefault();
      li.classList.add("drop-before");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
    li.addEventListener("drop", (e) => {
      e.preventDefault();
      li.classList.remove("drop-before");
      if (dragRowId !== null) dropInstAt(dragRowId, { kind: "front", layer: gi });
      dragRowId = null;
    });
  });
  // one-time, section-level: feed the edge auto-scroll with pointer positions (the
  // per-row listeners above are re-wired on every renderInstList, this must not stack)
  const section = list.closest("section") as HTMLElement | null;
  if (section && !section.dataset.scrollWired) {
    section.dataset.scrollWired = "1";
    section.addEventListener("dragover", (e) => { if (dragRowId !== null) dragScrollY = e.clientY; });
  }
}

// A drop between rows means "sit immediately before the row above the line" in that
// layer's array (the list shows front-most first = the array reversed). A drop on a group
// header = front-most of that layer. Same layer = reorder, different layer = relayer.
function dropInstAt(id: number, target: { kind: "row"; id: number; after: boolean } | { kind: "front"; layer: number }) {
  if (!doc) return;
  const src = findInstance(room(), id);
  if (!src) return;
  let toLayer: number, anchor: number | null;
  if (target.kind === "front") {
    toLayer = target.layer;
    anchor = null;
  } else {
    const dst = findInstance(room(), target.id);
    if (!dst) return;
    toLayer = dst.layer;
    const arr = room().layers[toLayer].layer_data.instances as RoomInstance[];
    anchor = target.after ? target.id : (arr[dst.index + 1]?.instance_id ?? null);
  }
  if (anchor === id) return;
  const arr = room().layers[src.layer].layer_data.instances as RoomInstance[];
  if (toLayer === src.layer && (arr[src.index + 1]?.instance_id ?? null) === anchor) return; // already there
  const srcName = room().layers[src.layer].layer_name!;
  const dstName = room().layers[toLayer].layer_name!;
  const obj = src.inst.object_definition ?? String(id);
  toastDepthCoded(obj);
  commit(toLayer === src.layer ? `调整顺序 ${obj}` : `移到 ${dstName}：${obj}`, [
    { op: "relayer", id, layer: dstName, before: anchor, expect: { layer: srcName } },
  ]);
}

// keep row highlights in step with the canvas selection; canvas-side picks also scroll
function syncInstSelection(scroll: boolean) {
  const list = $("inst-list");
  list.querySelectorAll<HTMLElement>("li.inst").forEach((li) => li.classList.toggle("sel", selection.has(Number(li.dataset.id))));
  if (scroll && selection.size && !$("tab-insts").hidden)
    list.querySelector<HTMLElement>(`li.inst[data-id="${[...selection][0]}"]`)?.scrollIntoView({ block: "nearest" });
}

function wireInsts() {
  const q = $<HTMLInputElement>("insts-q");
  let t = 0;
  q.oninput = () => {
    clearTimeout(t);
    t = window.setTimeout(renderInstList, 80);
  };
}

// ---------------- toolbox & dock ----------------

function wireToolbox() {
  document.querySelectorAll<HTMLButtonElement>("#toolbox button[data-tool]").forEach((b) => {
    // 放置 opens the library modal; every other button arms its tool directly
    b.onclick = () => (b.dataset.tool === "place" ? openPalette() : pickTool(b.dataset.tool as Tool["kind"]));
  });
}

// collapsible dock panels; the collapsed set survives restarts
function wireDock() {
  let collapsed: string[] = [];
  try { collapsed = JSON.parse(localStorage.getItem("svre.dock.collapsed") ?? "[]"); } catch { /* private mode */ }
  const heads = [...document.querySelectorAll<HTMLElement>("[data-collapse]")];
  const apply = () => {
    for (const h of heads) h.closest(".dock-panel")!.classList.toggle("collapsed", collapsed.includes(h.dataset.collapse!));
  };
  for (const h of heads) {
    h.onclick = () => {
      const k = h.dataset.collapse!;
      collapsed = collapsed.includes(k) ? collapsed.filter((x) => x !== k) : [...collapsed, k];
      try { localStorage.setItem("svre.dock.collapsed", JSON.stringify(collapsed)); } catch { /* best effort */ }
      apply();
    };
  }
  apply();
}

function wireTabs() {
  document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab!);
  });
}
function showTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>(".tabs button[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  $("tab-insts").hidden = tab !== "insts";
  $("tab-layers").hidden = tab !== "layers";
  $("tab-history").hidden = tab !== "history";
  if (tab === "insts") renderInstList();
  if (tab === "history" && doc) {
    lastSeenRev = doc.rev;
    $("history-badge").textContent = "";
    renderHistory();
  }
}

// ================= history & notes =================

const WHO: Record<string, string> = { human: "人类", import: "导入", external: "外部" };
const whoBadge = (by: string) => {
  const cls = by === "import" || by === "external" ? by : by === "human" ? "" : "agent";
  return `<span class="who ${cls}">${esc(WHO[by] ?? by)}</span>`;
};

function renderHistory() {
  if (!doc || $("tab-history").hidden) return;
  const list = $("history-list");
  list.innerHTML = doc.log
    .slice()
    .reverse()
    .map((e) => {
      const time = e.at.slice(11, 19);
      return `<li data-rev="${e.rev}" class="${e.undoOf !== undefined ? "undo" : ""}" title="点击高亮本次改动涉及的实例">
        <div class="h-top">${whoBadge(e.by)}<span class="h-label">${esc(e.label || "(未命名)")}</span><span class="h-meta">r${e.rev} · ${time}</span></div>
        <div class="h-meta">${e.ops} 条操作${e.ids.length ? ` · id ${e.ids.slice(0, 8).join(",")}${e.ids.length > 8 ? "…" : ""}` : ""}</div>
        ${e.note ? `<div class="h-note">${esc(e.note)}</div>` : ""}</li>`;
    })
    .join("");
  list.querySelectorAll<HTMLElement>("li[data-rev]").forEach((li) => {
    li.onclick = () => {
      const e = doc!.log.find((x) => x.rev === Number(li.dataset.rev));
      if (!e) return;
      flashIds(e.ids);
    };
  });

  const nl = $("notes-list");
  nl.innerHTML = doc.notes
    .map(
      (n) => `<div class="note-item">${whoBadge(n.by)}<span class="txt">${esc(n.text)} <span class="h-meta">@${n.x},${n.y}</span></span>
        <button data-note="${n.id}" title="删除便签">×</button></div>`,
    )
    .join("");
  nl.querySelectorAll<HTMLButtonElement>("button[data-note]").forEach((b) => {
    b.onclick = async () => {
      await api(`/api/doc/${doc!.name}/notes`, "POST", { remove: b.dataset.note });
      doc = await api(`/api/doc/${doc!.name}`);
      renderHistory();
      drawNotes();
    };
  });
}

function flashIds(ids: number[]) {
  flash = new Map(ids.map((id) => [id, Date.now() + 1500]));
  drawOverlay();
  setTimeout(drawOverlay, 1600);
}

// note pins on the canvas: a diamond + text, world space
function drawNotes() {
  notesLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  if (!doc) return;
  for (const n of doc.notes) {
    const pin = new Container();
    pin.position.set(n.x, n.y);
    pin.addChild(
      new Graphics().poly([0, -6, 6, 0, 0, 6, -6, 0]).fill({ color: 0xffc060, alpha: 0.9 }).stroke({ color: 0x402800, width: 1, pixelLine: true }),
    );
    const t = new Text({ text: n.text, style: { fontSize: 10, fill: 0xffe0b0, fontFamily: "Segoe UI, sans-serif", stroke: { color: 0x000000, width: 3 } } });
    t.position.set(9, -7);
    t.resolution = 4;
    pin.addChild(t);
    notesLayer.addChild(pin);
  }
  notesLayer.visible = toggles.notes.checked;
  requestRender();
}

// keep note pins readable at any zoom: counter-scale them
function rescaleNotes() {
  for (const pin of notesLayer.children) pin.scale.set(1 / zoom);
}

async function addNoteAt(wx: number, wy: number) {
  if (!doc) return;
  const text = prompt(`便签（${Math.round(wx)}, ${Math.round(wy)}）：人类和 agent 均可见`, "");
  if (!text?.trim()) return;
  await api(`/api/doc/${doc.name}/notes`, "POST", { by: BY, x: Math.round(wx), y: Math.round(wy), text: text.trim() });
  doc = await api(`/api/doc/${doc.name}`);
  renderHistory();
  drawNotes();
}

// ---------------- palette & placement (modal library) ----------------

// the library lives in a modal, not the dock: a catalog wants width. Triggered by the
// toolbox 放置 button, Ctrl+K, or P with no prior pick. Picking arms the place tool and
// closes; Esc / backdrop click closes without changing the armed tool.
function openPalette() {
  const dlg = $<HTMLDialogElement>("palette-dialog");
  renderPaletteRoom();
  renderPalette();
  if (!dlg.open) dlg.showModal();
  const q = $<HTMLInputElement>("palette-q");
  q.focus();
  q.select();
}
function closePalette() { $<HTMLDialogElement>("palette-dialog").close(); }

function wirePalette() {
  const q = $<HTMLInputElement>("palette-q");
  const fam = $("palette-families");
  fam.innerHTML = FAMILIES.map((f, i) => `<button data-f="${i}" class="${f === family ? "on" : ""}">${f.label}</button>`).join("");
  fam.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => {
      family = FAMILIES[Number(b.dataset.f)];
      fam.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderPalette();
    };
  });
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(renderPalette, 80); };
  q.onkeydown = (e) => {
    if (e.key === "Enter") { const first = $("palette-list").querySelector<HTMLElement>("li"); first?.click(); }
    if (e.key === "Escape") { e.preventDefault(); closePalette(); }
  };
  const dlg = $<HTMLDialogElement>("palette-dialog");
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
  // one-time: hovering a library card narrates the full identity in the pinned info line
  $("palette-list").addEventListener("mouseover", (e) => {
    const li = (e.target as Element).closest("li[data-o]") as HTMLElement | null;
    if (!li) return;
    const n = li.dataset.o!;
    const chain = db.parentChain(n).slice(0, 3).join(" → ");
    $("palette-info").textContent =
      `${n} · ${db.objects[n]?.sprite ?? "无 sprite"}${chain ? " · " + chain : ""}${db.modObjects.has(n) ? " · mod 自建" : ""}`;
  });
}

function renderPalette() {
  const names = searchObjects(db, $<HTMLInputElement>("palette-q").value, family);
  // the user's own mod objects outrank vanilla ones at equal search rank (stable sort)
  // and carry a badge -- the library is the game's catalog, theirs is the point
  const ranked = names.slice().sort((a, b) => Number(db.modObjects.has(b)) - Number(db.modObjects.has(a)));
  const list = $("palette-list");
  list.innerHTML = ranked
    .map((n) => {
      const on = tool.kind === "place" && tool.object === n ? "on" : "";
      const mod = db.modObjects.has(n) ? `<i class="mod-badge" title="mod 自建对象（assets.json 注册）">mod</i>` : "";
      return `<li data-o="${esc(n)}" class="${on}" title="${esc(n)}">${thumbHtml(db, n, 0, 56)}${mod}<span class="pname">${esc(n.replace(/^o_/, ""))}</span></li>`;
    })
    .join("") || `<li class="muted" style="padding:10px;grid-column:1/-1">没有匹配的对象</li>`;
  list.querySelectorAll<HTMLElement>("li[data-o]").forEach((li) => {
    li.onclick = () => { setTool({ kind: "place", object: li.dataset.o! }); closePalette(); };
  });
}

// objects already in the room, as quick chips: most placement is "another one of these".
// They stay compact chips (row-ish), the library stays a card grid -- same shape
// language only for things that really are room content.
function renderPaletteRoom() {
  if (!doc || !scene) return;
  const counts = new Map<string, number>();
  for (const L of room().layers)
    if (L.layer_type === LayerType.Instances)
      for (const inst of L.layer_data.instances as RoomInstance[])
        if (inst.object_definition) counts.set(inst.object_definition, (counts.get(inst.object_definition) ?? 0) + 1);
  const entries = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  $("palette-room-wrap").hidden = entries.length === 0;
  const box = $("palette-room");
  box.innerHTML = entries
    .map(([o, n]) => {
      const on = tool.kind === "place" && tool.object === o ? "on" : "";
      return `<button class="chip ${on}" data-o="${esc(o)}" title="${esc(o)} · ${n} 个实例">${thumbHtml(db, o, 0, 22)}<span>${esc(o.replace(/^o_/, ""))}</span><b>×${n}</b></button>`;
    })
    .join("");
  box.querySelectorAll<HTMLButtonElement>("button.chip").forEach((b) => {
    b.onclick = () => { setTool({ kind: "place", object: b.dataset.o! }); closePalette(); };
  });
}

function toolCursor() {
  if (spaceHeld || tool.kind === "hand") return "grab";
  if (tool.kind !== "select") return "crosshair";
  return "";
}

function setTool(t: Tool) {
  tool = t;
  if (t.kind === "place") lastPlaced = t.object;
  if (t.kind === "zone") zoneObject = t.object;
  if (t.kind === "marker") markerObject = t.object;
  ghostLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  const names = { select: "选择", hand: "抓手", note: "便签", place: "放置", collision: "碰撞矩形", barrier: "屏障涂刷", zone: "区域", marker: "标记" } as const;
  $("s-tool").textContent =
    t.kind === "place" ? `放置 ${t.object}（单击放置，Esc 结束）`
    : t.kind === "hand" ? "抓手（拖动平移）"
    : t.kind === "note" ? "便签（单击留便签）"
    : t.kind === "collision" ? "碰撞矩形（拖出矩形 · Esc 结束）"
    : t.kind === "barrier" ? "屏障涂刷（拖动刷格 · Alt+拖动擦除 · Esc 结束）"
    : t.kind === "zone" ? `区域 ${t.object}（拖出矩形，Esc 结束）`
    : t.kind === "marker" ? `标记 ${t.object}（单击放置，Esc 结束）`
    : "选择";
  $("opt-tool").textContent = names[t.kind] + (t.kind === "place" ? `：${t.object}` : "");
  $("stage").style.cursor = toolCursor();
  document.querySelectorAll<HTMLButtonElement>("#toolbox button[data-tool]").forEach((b) => {
    const on = b.dataset.tool === t.kind;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLElement>("#palette-list li[data-o], #palette-room button[data-o]").forEach((el) => {
    el.classList.toggle("on", t.kind === "place" && el.dataset.o === t.object);
  });
  if (t.kind === "place" || t.kind === "marker") buildGhost(t.object);
  renderToolExtras();
  drawOverlay();
}

// letter keys land here; P re-arms the last pick, or opens the library when there is none
function pickTool(kind: Tool["kind"]) {
  if (kind === "place") {
    if (!lastPlaced) { openPalette(); return; }
    setTool({ kind: "place", object: lastPlaced });
  } else if (kind === "zone") setTool({ kind, object: zoneObject });
  else if (kind === "marker") setTool({ kind, object: markerObject });
  else setTool({ kind });
}

async function buildGhost(object: string) {
  const spr = db.objects[object]?.sprite;
  const v = (spr && (await spriteView(db, spr, 0))) || markerView(object.replace(/^o_/, ""));
  if ((tool.kind !== "place" && tool.kind !== "marker") || tool.object !== object) return; // tool changed meanwhile
  ghostLayer.removeChildren();
  ghostLayer.addChild(v);
  moveGhost();
}

function moveGhost() {
  const g = ghostLayer.children[0];
  if (!g) return;
  g.position.set(snapPoint(cursorWorld.x), snapPoint(cursorWorld.y));
  requestRender();
}

function placeAt(wx: number, wy: number) {
  if (!doc || (tool.kind !== "place" && tool.kind !== "marker")) return;
  const object = tool.object;
  const li = tool.kind === "marker" ? layerFor(object) : activeLayer;
  const L = room().layers[li];
  if (L?.layer_type !== LayerType.Instances) {
    alert("请先在「层组」页签中选择一个实例图层");
    return;
  }
  const verb = tool.kind === "marker" ? "标记" : "放置";
  commit(`${verb} ${object}`, [{ op: "add", layer: L.layer_name!, inst: { object_definition: object, x: snapPoint(wx), y: snapPoint(wy) } as RoomInstance }]).then(selectPlaced);
}

// select what a placement/drawing commit just created (the ids came back in the log entry)
function selectPlaced(ok: boolean) {
  if (!ok || !doc) return;
  selection.clear();
  for (const id of doc.log[doc.log.length - 1]?.ids ?? []) selection.add(id);
  inspect();
  drawOverlay();
}

// ---------------- functional object tools ----------------

// where a freshly drawn functional object belongs: the layer already holding one of its
// kind, else a well-known home (collision stamps, camera boxes, surfaces), else the
// active layer. The options bar shows the answer next to the tool ("→ Collisions").
function layerFor(object: string): number {
  const r = room();
  const instLayers = r.layers.map((L, i) => ({ L, i })).filter(({ L }) => L.layer_type === LayerType.Instances);
  for (const { L, i } of instLayers)
    if ((L.layer_data.instances as RoomInstance[]).some((x) => x.object_definition === object)) return i;
  const byName = (re: RegExp) => instLayers.find(({ L }) => re.test(L.layer_name ?? ""))?.i ?? -1;
  if (object === COLLISION_PAINT) { const i = byName(/coli/i); if (i >= 0) return i; } // vanilla spells it "Colissions"
  if (object === BARRIER_PAINT) { // vanilla home is a "Projectiles" layer, else it shares the collision layer
    const i = byName(/projectile/i);
    if (i >= 0) return i;
    const j = byName(/coli/i);
    if (j >= 0) return j;
  }
  if (/^oCamera/.test(object)) { const i = byName(/camera/i); if (i >= 0) return i; }
  if (db.parentChain(object).includes("c_zone")) { const i = byName(/surface/i); if (i >= 0) return i; }
  if (r.layers[activeLayer]?.layer_type === LayerType.Instances) return activeLayer;
  return guessActiveLayer();
}
const layerNameOf = (i: number) => room().layers[i]?.layer_name ?? "?";

// zone-drawable objects: an invisible/trigger-ish object whose sprite is a solid-colour
// box -- the same pixel test that gates the resize handles, so anything the editor can
// stretch it can also draw. Scanned lazily on first use (~70 candidates, ~8 pages).
function zoneObjects(): Promise<string[]> {
  if (!zoneObjectsCache)
    zoneObjectsCache = (async () => {
      const cand = Object.keys(db.objects).filter((n) => {
        const d = db.objects[n];
        const s = d.sprite ? db.sprites[d.sprite] : undefined;
        if (!d.sprite || !s || s.w > 128 || s.h > 128) return false;
        return /trigger|zone|camera|surface|area|collis/i.test(n) || db.parentChain(n).some((p) => /^(c_trigger|c_zone)$/.test(p) || /camera/i.test(p));
      });
      const ok: string[] = [];
      for (const n of cand) {
        try {
          if (await plainBoxSprite(db.objects[n].sprite!)) ok.push(n);
        } catch { /* unreadable frame */ }
      }
      ok.sort();
      const pin = ["oCameraStatic", "o_area_marker"]; // the usual suspects first
      return [...pin.filter((p) => ok.includes(p)), ...ok.filter((n) => !pin.includes(n))];
    })();
  return zoneObjectsCache;
}

// the marker tool's list: the palette's curated 碰撞/标记 family (starters, barrier and
// encounter markers…) minus the collision stamp, plus the light markers
function markerObjects(): string[] {
  if (!markerObjectsCache) {
    const fam = FAMILIES.find((f) => f.label === "碰撞/标记")!;
    const set = new Set(searchObjects(db, "", fam, 300).filter((n) => n !== COLLISION_PAINT));
    for (const n of Object.keys(db.objects)) if (/^o_light_marker/.test(n)) set.add(n);
    const pin = ["o_position_starter", "o_position_starter_dungeon_enter", "o_position_starter_dungeon_exit"];
    markerObjectsCache = [...pin.filter((p) => set.has(p)), ...[...set].filter((n) => !pin.includes(n)).sort()];
  }
  return markerObjectsCache;
}

// the options bar shows each drawing tool's particulars: object pickers, target layer
function renderToolExtras() {
  const box = $("opt-extra");
  box.innerHTML = "";
  if (!doc) return;
  const hint = (text: string) => {
    const s = document.createElement("span");
    s.className = "opt-hint";
    s.textContent = text;
    box.appendChild(s);
  };
  if (tool.kind === "collision") {
    hint(`${COLLISION_PAINT} · 拖出矩形 · 放入 ${layerNameOf(layerFor(COLLISION_PAINT))} 层`);
    return;
  }
  if (tool.kind === "barrier") {
    hint(`${BARRIER_PAINT} · 拖动涂刷，Alt+拖动擦除 · 放入 ${layerNameOf(layerFor(BARRIER_PAINT))} 层`);
    return;
  }
  if (tool.kind === "zone") {
    const cur0 = tool.object; // const: `tool` is a mutable module var, closures un-narrow it
    const sel = document.createElement("select");
    sel.title = "选择要绘制的对象：具有纯色盒 sprite 的功能对象（与尺寸手柄同一套像素判据）";
    sel.innerHTML = `<option>${esc(cur0)}</option>`;
    sel.disabled = true;
    box.appendChild(sel);
    hint(`拖出矩形 · 放入 ${layerNameOf(layerFor(cur0))} 层`);
    void zoneObjects().then((names) => {
      if (!names.includes(cur0)) names.unshift(cur0);
      sel.innerHTML = names.map((n) => `<option ${n === cur0 ? "selected" : ""}>${esc(n)}</option>`).join("");
      sel.disabled = false;
    });
    sel.onchange = () => setTool({ kind: "zone", object: sel.value });
    return;
  }
  if (tool.kind === "marker") {
    const cur0 = tool.object;
    const names = markerObjects();
    if (!names.includes(cur0)) names.unshift(cur0);
    const sel = document.createElement("select");
    sel.title = "选择要放置的标记：出生点、灯光、区域标记等功能对象";
    sel.innerHTML = names.map((n) => `<option ${n === cur0 ? "selected" : ""}>${esc(n)}</option>`).join("");
    sel.onchange = () => setTool({ kind: "marker", object: sel.value });
    box.appendChild(sel);
    hint(`单击放置 · 放入 ${layerNameOf(layerFor(cur0))} 层`);
  }
}

// the world rect a zone drag covers: edges snap to cell lines like the resize handles;
// a plain click means the cell under the cursor
function zoneRect(d: { ax: number; ay: number; bx: number; by: number; moved: boolean }) {
  const snapE = (v: number) => (snapOn() ? Math.round(v / CELL) * CELL : Math.round(v));
  if (!d.moved) {
    const L = snapPoint(d.ax), T = snapPoint(d.ay);
    return { L, T, R: L + CELL, B: T + CELL };
  }
  const L = snapE(Math.min(d.ax, d.bx)), T = snapE(Math.min(d.ay, d.by));
  const unit = snapOn() ? CELL : 1;
  const R = Math.max(L + unit, snapE(Math.max(d.ax, d.bx)));
  const B = Math.max(T + unit, snapE(Math.max(d.ay, d.by)));
  return { L, T, R, B };
}

// every cell a paint stroke touches, clamped to the room; a click is just that cell
function paintCells(d: { ax: number; ay: number; bx: number; by: number }) {
  const L = Math.min(d.ax, d.bx), T = Math.min(d.ay, d.by);
  const spanX = Math.max(Math.abs(d.bx - d.ax), 1), spanY = Math.max(Math.abs(d.by - d.ay), 1);
  const maxCX = Math.ceil(room().width / CELL) - 1, maxCY = Math.ceil(room().height / CELL) - 1;
  const cx0 = Math.max(0, Math.floor(L / CELL)), cy0 = Math.max(0, Math.floor(T / CELL));
  // the far edge lands exactly on a cell line: don't bleed into the next cell
  const cx1 = Math.min(maxCX, Math.floor((L + spanX - 1e-6) / CELL)), cy1 = Math.min(maxCY, Math.floor((T + spanY - 1e-6) / CELL));
  return { cx0, cy0, cx1, cy1 };
}

function zoneCommit(d: { ax: number; ay: number; bx: number; by: number; moved: boolean; object: string }) {
  if (!doc) return;
  const object = d.object;
  const { L, T, R, B } = zoneRect(d);
  const spr = db.objects[object]?.sprite;
  const def = spr ? db.sprites[spr] : undefined;
  const f = def?.frames[0];
  let x = L, y = T, scale_x = 1, scale_y = 1;
  if (def && f && f.length) {
    // the same math as the resize handles: the sprite's local box sits at (tgt − origin)
    const lb = { x: f[5] - def.ox, y: f[6] - def.oy, w: f[7], h: f[8] };
    scale_x = (R - L) / lb.w;
    scale_y = (B - T) / lb.h;
    x = Math.round(L - lb.x * scale_x);
    y = Math.round(T - lb.y * scale_y);
  }
  const label = object === COLLISION_PAINT ? `碰撞矩形 ${R - L}×${B - T}` : `区域 ${object} ${R - L}×${B - T}`;
  commit(label, [
    { op: "add", layer: layerNameOf(layerFor(object)), inst: { object_definition: object, x, y, scale_x, scale_y } as RoomInstance },
  ]).then(selectPlaced);
}

function paintCommit(d: { ax: number; ay: number; bx: number; by: number; object: string }, erase: boolean) {
  if (!doc) return;
  const { cx0, cy0, cx1, cy1 } = paintCells(d);
  if (cx1 < cx0 || cy1 < cy0) { drawOverlay(); return; }
  const object = d.object, what = paintLabel(object);
  // dedup/erase are per object family: barrier cells and walk-collision cells coexist
  const stamps: RoomInstance[] = [];
  for (const L of room().layers)
    if (L.layer_type === LayerType.Instances)
      for (const i of L.layer_data.instances as RoomInstance[]) if (i.object_definition === object) stamps.push(i);
  const inRect = (i: RoomInstance) => {
    const cx = Math.floor(i.x / CELL), cy = Math.floor(i.y / CELL);
    return cx >= cx0 && cx <= cx1 && cy >= cy0 && cy <= cy1;
  };
  if (erase) {
    const hits = stamps.filter(inRect);
    if (!hits.length) { $("s-hover").textContent = `此处没有可擦除的${what}格`; drawOverlay(); return; }
    commit(`擦除${what} ${hits.length} 格`, hits.map((i) => ({ op: "delete", id: i.instance_id, expect: { object_definition: i.object_definition, x: i.x, y: i.y } })));
    return;
  }
  const taken = new Set(stamps.map((i) => `${Math.floor(i.x / CELL)},${Math.floor(i.y / CELL)}`));
  const layer = layerNameOf(layerFor(object));
  const ops: Op[] = [];
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++)
      if (!taken.has(`${cx},${cy}`)) ops.push({ op: "add", layer, inst: { object_definition: object, x: cx * CELL, y: cy * CELL } as RoomInstance });
  if (!ops.length) { $("s-hover").textContent = `所选格子已存在${what}`; drawOverlay(); return; }
  commit(`涂刷${what} ${ops.length} 格`, ops);
}

// ================= viewport & pointer =================

function redrawZoomDependent() {
  if (!scene || !doc) return;
  if (toggles.grid.checked) drawGrid(scene.gridLayer, room(), zoom, true);
  drawBounds(scene.boundsLayer, room(), zoom);
  rescaleNotes();
  drawArtboard();
  drawOverlay();
  const pct = `${Math.round(zoom * 100)}%`;
  $("s-zoom").textContent = pct;
  ($("zoom-cur") as HTMLOptionElement).textContent = pct;
  $<HTMLSelectElement>("zoom-preset").value = "";
}

function zoomAt(z: number, sx: number, sy: number) {
  z = Math.min(16, Math.max(0.1, z));
  const wx = (sx - world.x) / zoom, wy = (sy - world.y) / zoom;
  zoom = z;
  world.scale.set(zoom);
  world.position.set(Math.round(sx - wx * zoom), Math.round(sy - wy * zoom));
  redrawZoomDependent();
}

function focusOn(wx: number, wy: number, z: number) {
  const host = $("stage");
  zoom = z;
  world.scale.set(z);
  world.position.set(Math.round(host.clientWidth / 2 - wx * z), Math.round(host.clientHeight / 2 - wy * z));
  redrawZoomDependent();
}

function fit() {
  if (!doc) return;
  const host = $("stage");
  const z = Math.min(host.clientWidth / room().width, host.clientHeight / room().height) * 0.94;
  zoom = z >= 1 ? Math.floor(z * 2) / 2 : z;
  world.scale.set(zoom);
  world.position.set(Math.round((host.clientWidth - room().width * zoom) / 2), Math.round((host.clientHeight - room().height * zoom) / 2));
  redrawZoomDependent();
}

const ZOOM_STEPS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16];
// +/- step through the presets around the stage centre
function zoomStep(dir: 1 | -1) {
  const host = $("stage");
  const z = dir > 0 ? ZOOM_STEPS.find((s) => s > zoom * 1.001) : [...ZOOM_STEPS].reverse().find((s) => s < zoom * 0.999);
  zoomAt(z ?? (dir > 0 ? 16 : 0.1), host.clientWidth / 2, host.clientHeight / 2);
}

// the room as a dark sheet with a soft shadow over the neutral pasteboard
function drawArtboard() {
  artboard.clear();
  if (renderMode || !doc) return;
  artboard.rect(3 / zoom, 4 / zoom, room().width, room().height).fill({ color: 0x000000, alpha: 0.35 });
  artboard.rect(0, 0, room().width, room().height).fill(0x0d0e11);
}

// ---------------- rulers ----------------

const RULER = 22; // CSS px; matches --ruler
let rulerCursor: { x: number; y: number } | null = null; // stage-local cursor, for the accent marker

// major steps stay cell-aligned (the 26px grid); minors subdivide where readable
function rulerStep() {
  const majors = [1, 2, 13, 26, 52, 104, 260, 520, 1040, 2600, 5200, 10400];
  const major = majors.find((m) => m * zoom >= 52) ?? majors[majors.length - 1];
  let minor = major;
  for (const n of [13, 10, 8, 5, 4, 2]) if (major % n === 0 && (major / n) * zoom >= 6) { minor = major / n; break; }
  return { major, minor };
}

function drawRuler(c: HTMLCanvasElement, horizontal: boolean, len: number) {
  const dpr = devicePixelRatio || 1;
  const bw = Math.max(1, Math.round((horizontal ? len : RULER) * dpr));
  const bh = Math.max(1, Math.round((horizontal ? RULER : len) * dpr));
  if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; }
  const ctx = c.getContext("2d");
  if (!ctx || len <= 0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, horizontal ? len : RULER, horizontal ? RULER : len);
  ctx.font = "9px 'Segoe UI', sans-serif";
  const off = horizontal ? world.x : world.y;
  if (doc) {
    const a = off, b = off + (horizontal ? room().width : room().height) * zoom;
    ctx.fillStyle = "rgba(108,182,255,0.07)";
    if (horizontal) ctx.fillRect(a, 0, b - a, RULER); else ctx.fillRect(0, a, RULER, b - a);
    ctx.strokeStyle = "rgba(108,182,255,0.35)";
    ctx.beginPath();
    for (const p of [a, b]) {
      const q = Math.round(p) + 0.5;
      if (horizontal) { ctx.moveTo(q, 0); ctx.lineTo(q, RULER); } else { ctx.moveTo(0, q); ctx.lineTo(RULER, q); }
    }
    ctx.stroke();
  }
  const { major, minor } = rulerStep();
  const k0 = Math.floor(-off / zoom / minor), k1 = Math.ceil((len - off) / zoom / minor);
  for (let k = k0; k <= k1; k++) {
    const v = k * minor;
    const p = Math.round(off + v * zoom) + 0.5;
    if (p < -0.5 || p > len + 0.5) continue;
    const isMajor = v % major === 0;
    const t = isMajor ? 13 : 6;
    ctx.strokeStyle = isMajor ? "#6a6a70" : "#48484e";
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(p, RULER); ctx.lineTo(p, RULER - t); }
    else { ctx.moveTo(RULER, p); ctx.lineTo(RULER - t, p); }
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = "#9a9aa0";
      if (horizontal) ctx.fillText(String(v), p + 3, 10);
      else { ctx.save(); ctx.translate(9, p - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(String(v), 0, 0); ctx.restore(); }
    }
  }
  const cur = horizontal ? rulerCursor?.x : rulerCursor?.y;
  if (cur !== undefined && cur >= 0 && cur <= len) {
    const q = Math.round(cur) + 0.5;
    ctx.strokeStyle = "#6cb6ff";
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(q, 0); ctx.lineTo(q, RULER); } else { ctx.moveTo(0, q); ctx.lineTo(RULER, q); }
    ctx.stroke();
  }
}

function drawRulers() {
  if (renderMode) return;
  const host = $("stage");
  drawRuler($("ruler-x") as HTMLCanvasElement, true, host.clientWidth);
  drawRuler($("ruler-y") as HTMLCanvasElement, false, host.clientHeight);
}

type Drag =
  | { mode: "pan"; sx: number; sy: number; wx: number; wy: number; button: number; moved: boolean }
  | { mode: "move"; sx: number; sy: number; ids: number[]; orig: { id: number; x: number; y: number; tx: number; ty: number }[]; moved: boolean }
  | { mode: "resize"; sx: number; sy: number; id: number; handle: string; lb: { x: number; y: number; w: number; h: number }; box: { x: number; y: number; w: number; h: number }; orig: { x: number; y: number; scale_x: number; scale_y: number }; moved: boolean }
  | { mode: "zone"; ax: number; ay: number; bx: number; by: number; moved: boolean; object: string }
  | { mode: "paint"; ax: number; ay: number; bx: number; by: number; moved: boolean; object: string }
  | { mode: "marquee"; sx: number; sy: number; ex: number; ey: number; additive: boolean; moved: boolean };
let drag: Drag | null = null;

// where a resize handle sits, in screen px; hit-test radius matches the drawn square
function handleAt(n: InstanceNode, sx: number, sy: number): string | null {
  const b = n.view.getBounds();
  const pts: [string, number, number][] = [
    ["nw", b.x, b.y], ["n", b.x + b.width / 2, b.y], ["ne", b.x + b.width, b.y],
    ["e", b.x + b.width, b.y + b.height / 2], ["se", b.x + b.width, b.y + b.height],
    ["s", b.x + b.width / 2, b.y + b.height], ["sw", b.x, b.y + b.height], ["w", b.x, b.y + b.height / 2],
  ];
  for (const [h, x, y] of pts) if (Math.abs(sx - x) <= 5 && Math.abs(sy - y) <= 5) return h;
  return null;
}

// The game draws these rectangles as whole 26px cells: scale_x/scale_y are cell counts
// and stay integers in every vanilla room. So with 吸附 on, a driven axis quantizes to a
// whole number of cells and the origin settles on the nearest grid corner, absorbing any
// initial deviation; Alt / toggle off follows the pointer one pixel at a time.
// New scale keeps the sprite's sign; x/y shift with the edges.
function resizeCompute(d: Extract<Drag, { mode: "resize" }>, wx: number, wy: number) {
  const gx = Math.sign(d.orig.scale_x) || 1, gy = Math.sign(d.orig.scale_y) || 1;
  const L0 = d.box.x, T0 = d.box.y, R0 = L0 + d.box.w, B0 = T0 + d.box.h;
  let x = d.orig.x, y = d.orig.y, scale_x = d.orig.scale_x, scale_y = d.orig.scale_y;
  if (snapOn()) {
    if (d.handle.includes("e")) {
      scale_x = gx * Math.max(1, Math.round((wx - L0) / d.lb.w));
      x = Math.round((L0 - d.lb.x * scale_x) / CELL) * CELL;
    } else if (d.handle.includes("w")) {
      scale_x = gx * Math.max(1, Math.round((R0 - wx) / d.lb.w));
      x = Math.round((R0 - (d.lb.x + d.lb.w) * scale_x) / CELL) * CELL;
    }
    if (d.handle.includes("s")) {
      scale_y = gy * Math.max(1, Math.round((wy - T0) / d.lb.h));
      y = Math.round((T0 - d.lb.y * scale_y) / CELL) * CELL;
    } else if (d.handle.includes("n")) {
      scale_y = gy * Math.max(1, Math.round((B0 - wy) / d.lb.h));
      y = Math.round((B0 - (d.lb.y + d.lb.h) * scale_y) / CELL) * CELL;
    }
    return { x, y, scale_x, scale_y, w: Math.abs(scale_x) * d.lb.w, h: Math.abs(scale_y) * d.lb.h };
  }
  let L = L0, T = T0, R = R0, B = B0;
  if (d.handle.includes("e")) R = Math.max(L + 1, Math.round(wx));
  if (d.handle.includes("w")) L = Math.min(R - 1, Math.round(wx));
  if (d.handle.includes("s")) B = Math.max(T + 1, Math.round(wy));
  if (d.handle.includes("n")) T = Math.min(B - 1, Math.round(wy));
  scale_x = (gx * (R - L)) / d.lb.w;
  scale_y = (gy * (B - T)) / d.lb.h;
  // origins can sit off-cell (oCameraStatic is centred), which leaves x/y fractional
  // when an edge is pinned to a pixel -- the room format stores integers
  return { x: Math.round(L - d.lb.x * scale_x), y: Math.round(T - d.lb.y * scale_y), scale_x, scale_y, w: R - L, h: B - T };
}

function wireViewport(host: HTMLElement) {
  const local = (e: PointerEvent | WheelEvent) => {
    const r = host.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };
  const toWorld = (sx: number, sy: number) => ({ x: (sx - world.x) / zoom, y: (sy - world.y) / zoom });

  host.addEventListener("contextmenu", (e) => e.preventDefault());
  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    const { sx, sy } = local(e);
    zoomAt(zoom * Math.pow(1.0015, -e.deltaY), sx, sy);
  }, { passive: false });

  host.addEventListener("pointerdown", (e) => {
    host.setPointerCapture(e.pointerId);
    const { sx, sy } = local(e);
    altHeld = e.altKey;
    if (e.button === 1 || e.button === 2 || (e.button === 0 && (spaceHeld || tool.kind === "hand" || tool.kind === "note"))) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: world.x, wy: world.y, button: e.button, moved: false };
      host.classList.add("panning");
      return;
    }
    if (e.button !== 0 || !doc) return;
    if (tool.kind === "place" || tool.kind === "marker") {
      const w = toWorld(sx, sy);
      placeAt(w.x, w.y);
      return;
    }
    if (tool.kind === "zone" || tool.kind === "collision" || tool.kind === "barrier") {
      const w = toWorld(sx, sy);
      // the target object freezes into the drag: switching tools mid-drag can't cross wires
      if (tool.kind === "barrier")
        drag = { mode: "paint", ax: w.x, ay: w.y, bx: w.x, by: w.y, moved: false, object: BARRIER_PAINT };
      else
        drag = { mode: "zone", ax: w.x, ay: w.y, bx: w.x, by: w.y, moved: false, object: tool.kind === "collision" ? COLLISION_PAINT : tool.object };
      drawOverlay();
      return;
    }
    // a handle of the single selected coverage rectangle wins over move/marquee
    if (selection.size === 1) {
      const n = nodeById.get([...selection][0]);
      if (n && n.view.visible && resizeGate.get(n.inst.instance_id)) {
        const handle = handleAt(n, sx, sy);
        if (handle) {
          const lb = n.view.getLocalBounds();
          const vsx = n.view.scale.x, vsy = n.view.scale.y;
          drag = {
            mode: "resize", sx, sy, id: n.inst.instance_id, handle,
            lb: { x: lb.x, y: lb.y, w: lb.width, h: lb.height },
            box: { x: n.view.x + lb.x * vsx, y: n.view.y + lb.y * vsy, w: lb.width * vsx, h: lb.height * vsy },
            orig: { x: n.inst.x, y: n.inst.y, scale_x: n.inst.scale_x, scale_y: n.inst.scale_y },
            moved: false,
          };
          return;
        }
      }
    }
    const hit = pick(sx, sy);
    if (hit) {
      const id = hit.inst.instance_id;
      if (e.shiftKey || e.ctrlKey) {
        selection.has(id) ? selection.delete(id) : selection.add(id);
        inspect();
        drawOverlay();
        postSelection();
        return;
      }
      if (!selection.has(id)) { selection.clear(); selection.add(id); }
      activeLayer = hit.layerIndex;
      renderLayerList();
      syncInstSelection(true);
      inspect();
      const orig = instsOf(selection).map((a) => ({ id: a.inst.instance_id, x: a.inst.x, y: a.inst.y, tx: a.inst.x, ty: a.inst.y }));
      drag = { mode: "move", sx, sy, ids: orig.map((o) => o.id), orig, moved: false };
      postSelection();
    } else {
      drag = { mode: "marquee", sx, sy, ex: sx, ey: sy, additive: e.shiftKey || e.ctrlKey, moved: false };
    }
    drawOverlay();
  });

  host.addEventListener("pointermove", (e) => {
    const { sx, sy } = local(e);
    altHeld = e.altKey;
    cursorWorld = toWorld(sx, sy);
    rulerCursor = { x: sx, y: sy };
    $("s-pos").textContent = `x ${Math.floor(cursorWorld.x)}  y ${Math.floor(cursorWorld.y)}`;
    $("s-cell").textContent = `格 ${Math.floor(cursorWorld.x / CELL)}, ${Math.floor(cursorWorld.y / CELL)}`;
    drawRulers();
    if (tool.kind === "place" || tool.kind === "marker") moveGhost();
    else if ((tool.kind === "zone" || tool.kind === "collision" || tool.kind === "barrier") && !drag) drawOverlay(); // idle cursor cell

    if (drag?.mode === "pan") {
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      world.position.set(drag.wx + e.clientX - drag.sx, drag.wy + e.clientY - drag.sy);
      drawOverlay();
      return;
    }
    if (drag?.mode === "resize") {
      const d = drag;
      if (!d.moved && Math.abs(sx - d.sx) + Math.abs(sy - d.sy) < 4) return;
      d.moved = true;
      const w = toWorld(sx, sy);
      const n = nodeById.get(d.id);
      if (!n) return;
      const v = resizeCompute(d, w.x, w.y);
      n.view.scale.set(v.scale_x, v.scale_y);
      n.view.position.set(v.x, v.y);
      $("s-hover").textContent = `调整尺寸 ${Math.round(v.w)}×${Math.round(v.h)}${snapOn() ? "（已吸附整格，按住 Alt 自由调整）" : ""}`;
      drawOverlay();
      return;
    }
    if (drag?.mode === "move") {
      const d = drag;
      const rdx = (sx - d.sx) / zoom, rdy = (sy - d.sy) / zoom;
      if (!d.moved && Math.abs(sx - d.sx) + Math.abs(sy - d.sy) < 4) return;
      d.moved = true;
      // snap the final resting place, not the delta: a start that's slightly off the
      // grid still lands exactly on a cell corner (Alt / toggle off = free whole pixels)
      const on = snapOn();
      for (const o of d.orig) {
        o.tx = on ? Math.round((o.x + rdx) / CELL) * CELL : o.x + Math.round(rdx);
        o.ty = on ? Math.round((o.y + rdy) / CELL) * CELL : o.y + Math.round(rdy);
        const n = nodeById.get(o.id);
        if (n) n.view.position.set(o.tx, o.ty);
      }
      const f = d.orig[0];
      $("s-hover").textContent = d.orig.length === 1
        ? `移动 → ${f.tx}, ${f.ty}${on ? "（吸附格点，Alt 自由）" : ""}`
        : `移动 ${d.orig.length} 个实例${on ? "（各自吸附格点）" : ""}`;
      drawOverlay();
      return;
    }
    if (drag?.mode === "zone" || drag?.mode === "paint") {
      const d = drag;
      const w = toWorld(sx, sy);
      d.bx = w.x;
      d.by = w.y;
      if (!d.moved && (Math.abs(w.x - d.ax) + Math.abs(w.y - d.ay)) * zoom > 4) d.moved = true;
      if (d.mode === "zone") {
        const r = zoneRect(d);
        const what = d.object === COLLISION_PAINT ? "碰撞矩形" : `区域 ${d.object}`;
        $("s-hover").textContent = `${what} ${r.R - r.L}×${r.B - r.T} → ${layerNameOf(layerFor(d.object))}`;
      } else if (d.mode === "paint") {
        const c = paintCells(d);
        const what = paintLabel(d.object);
        $("s-hover").textContent = `${altHeld ? "擦除" : "涂刷"}${what} ${c.cx1 - c.cx0 + 1}×${c.cy1 - c.cy0 + 1} 格${altHeld ? "" : "（按住 Alt 擦除）"}`;
      }
      drawOverlay();
      return;
    }
    if (drag?.mode === "marquee") {
      drag.ex = sx; drag.ey = sy;
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
      drawOverlay();
      return;
    }
    const h = tool.kind === "hand" || tool.kind === "zone" || tool.kind === "collision" || tool.kind === "barrier" ? null : pick(sx, sy);
    if (h?.inst.instance_id !== hovered) {
      hovered = h?.inst.instance_id ?? null;
      $("s-hover").textContent = h ? `${h.inst.object_definition}  #${h.inst.instance_id}  @${h.inst.x},${h.inst.y}  depth ${h.depth}  [${h.layer.layer_name}]` : "—";
      drawOverlay();
    }
    // resize-handle cursor for the single selected coverage rectangle
    if (tool.kind === "select" && !spaceHeld) {
      let cur = "";
      if (selection.size === 1) {
        const n = nodeById.get([...selection][0]);
        if (n && n.view.visible && resizeGate.get(n.inst.instance_id)) {
          const handle = handleAt(n, sx, sy);
          if (handle) cur = handle.length === 1 ? (handle === "e" || handle === "w" ? "ew-resize" : "ns-resize") : handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize";
        }
      }
      host.style.cursor = cur;
    }
  });

  host.addEventListener("pointerleave", () => { rulerCursor = null; drawRulers(); });

  host.addEventListener("pointerup", (e) => {
    host.classList.remove("panning");
    const d = drag;
    drag = null;
    if (!d || !doc) return;
    if (d.mode === "pan") {
      // a click that didn't drag = note: right-click always, left-click with the note tool
      if (!d.moved && !renderMode && (d.button === 2 || (d.button === 0 && tool.kind === "note" && !spaceHeld))) {
        const r = host.getBoundingClientRect();
        const w = toWorld(e.clientX - r.left, e.clientY - r.top);
        addNoteAt(w.x, w.y);
      }
      return;
    }
    if (d.mode === "zone") {
      zoneCommit(d);
      drawOverlay();
      return;
    }
    if (d.mode === "paint") {
      paintCommit(d, e.altKey);
      return;
    }
    if (d.mode === "resize") {
      if (!d.moved) return;
      const r0 = host.getBoundingClientRect();
      const w = toWorld(e.clientX - r0.left, e.clientY - r0.top);
      const v = resizeCompute(d, w.x, w.y);
      const unchanged = v.x === d.orig.x && v.y === d.orig.y && v.scale_x === d.orig.scale_x && v.scale_y === d.orig.scale_y;
      if (unchanged) {
        refreshScene(); // snapped back to the start: restore the previewed view
        return;
      }
      const n = nodeById.get(d.id);
      commit(`调整 ${n?.inst.object_definition ?? d.id} 尺寸`, [{
        op: "set", id: d.id,
        set: { x: v.x, y: v.y, scale_x: v.scale_x, scale_y: v.scale_y },
        expect: { ...d.orig },
      }]).then((ok) => { if (!ok) refreshScene(); });
    } else if (d.mode === "move" && d.moved) {
      const ops: Op[] = d.orig
        .filter((o) => o.tx !== o.x || o.ty !== o.y)
        .map((o) => ({ op: "set", id: o.id, set: { x: o.tx, y: o.ty }, expect: { x: o.x, y: o.y } }));
      if (!ops.length) refreshScene(); // snapped back to the start: restore the previewed views
      else {
        const what = d.orig.length === 1 ? String(findInstance(room(), d.orig[0].id)?.inst.object_definition ?? "") : `${d.orig.length} 个实例`;
        commit(`移动 ${what}`, ops).then((ok) => { if (!ok) refreshScene(); });
      }
    } else if (d.mode === "marquee") {
      if (!d.additive) selection.clear();
      if (d.moved) {
        const x0 = Math.min(d.sx, d.ex), x1 = Math.max(d.sx, d.ex), y0 = Math.min(d.sy, d.ey), y1 = Math.max(d.sy, d.ey);
        for (const n of scene!.nodes) {
          if (!n.view.visible) continue;
          const b = n.view.getBounds();
          if (b.x < x1 && b.x + b.width > x0 && b.y < y1 && b.y + b.height > y0) selection.add(n.inst.instance_id);
        }
      }
      syncInstSelection(false);
      inspect();
      drawOverlay();
      postSelection();
    }
  });
}

// topmost visible instance under a screen point: overlays first, then the game picture by draw order
function pick(sx: number, sy: number): InstanceNode | null {
  if (!scene) return null;
  let best: InstanceNode | null = null;
  for (const n of scene.nodes) {
    if (!n.view.visible) continue;
    const b = n.view.getBounds();
    if (sx >= b.x && sx < b.x + b.width && sy >= b.y && sy < b.y + b.height)
      // ties go to the LATER node: pixi's stable sort draws later children on top,
      // so the same rule here keeps clicks consistent with the picture (and relayer
      // reorders flip both). With `>` the first node kept the tie -- the bottom one.
      if (!best || n.view.zIndex >= best.view.zIndex) best = n;
  }
  return best;
}

// pixi's ticker is stopped (see init): mutations ask for a frame here, coalesced by RAF
let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; app.render(); });
}

function drawOverlay() {
  applyZ(); // selection changes land here; a signature guard keeps hovers free
  overlay.clear();
  const box = (n: InstanceNode, color: number, w: number) => {
    if (!n.view.visible) return;
    const b = n.view.getBounds();
    overlay.rect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.width), Math.round(b.height)).stroke({ color, width: w });
  };
  if (hovered !== null && !selection.has(hovered)) {
    const n = nodeById.get(hovered);
    if (n) box(n, 0xffffff, 1);
  }
  for (const id of selection) {
    const n = nodeById.get(id);
    if (n) box(n, 0x6cb6ff, 2);
  }
  // drag-resize handles: single selection of a visible coverage rectangle
  if (selection.size === 1 && tool.kind === "select") {
    const n = nodeById.get([...selection][0]);
    if (n && n.view.visible) {
      const gate = resizeGate.get(n.inst.instance_id);
      if (gate === undefined) void computeResizeGate(n).then(() => drawOverlay());
      else if (gate) {
        const b = n.view.getBounds();
        for (const [hx, hy] of [
          [b.x, b.y], [b.x + b.width / 2, b.y], [b.x + b.width, b.y],
          [b.x + b.width, b.y + b.height / 2], [b.x + b.width, b.y + b.height],
          [b.x + b.width / 2, b.y + b.height], [b.x, b.y + b.height], [b.x, b.y + b.height / 2],
        ] as [number, number][]) {
          overlay.rect(hx - 3, hy - 3, 6, 6).fill({ color: 0xffffff }).stroke({ color: 0x1c2b3a, width: 1 });
        }
      }
    }
  }
  // other authors' selections (thinner, warm)
  for (const ids of remoteSel.values()) {
    for (const id of ids) {
      const n = nodeById.get(id);
      if (n) box(n, 0xffb454, 1);
    }
  }
  const nowTs = Date.now();
  for (const [id, until] of flash) {
    if (until < nowTs) continue;
    const n = nodeById.get(id);
    if (n) box(n, 0xff7a30, 3);
  }
  if (drag?.mode === "marquee" && drag.moved) {
    const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey);
    overlay.rect(x, y, Math.abs(drag.ex - drag.sx), Math.abs(drag.ey - drag.sy))
      .fill({ color: 0x6cb6ff, alpha: 0.08 }).stroke({ color: 0x6cb6ff, width: 1 });
  }
  // drawing-tool previews: the zone rect / paint span mid-drag, or the starting cell
  // under the cursor when a drawing tool is idle
  if (doc && !renderMode) {
    if (drag?.mode === "zone") {
      const r = zoneRect(drag);
      const color = drag.object === COLLISION_PAINT ? 0xff3040 : 0x40c0ff;
      overlay
        .rect(world.x + r.L * zoom, world.y + r.T * zoom, (r.R - r.L) * zoom, (r.B - r.T) * zoom)
        .fill({ color, alpha: 0.1 })
        .stroke({ color, width: 1 });
    } else if (drag?.mode === "paint") {
      const c = paintCells(drag);
      if (c.cx1 >= c.cx0 && c.cy1 >= c.cy0) {
        const base = drag.object === BARRIER_PAINT ? 0xe89a2c : 0xff3040;
        const color = altHeld ? (drag.object === BARRIER_PAINT ? 0xffe9b0 : 0xffb454) : base;
        overlay
          .rect(world.x + c.cx0 * CELL * zoom, world.y + c.cy0 * CELL * zoom, (c.cx1 - c.cx0 + 1) * CELL * zoom, (c.cy1 - c.cy0 + 1) * CELL * zoom)
          .fill({ color, alpha: 0.16 })
          .stroke({ color, width: 1.5 });
      }
    } else if ((tool.kind === "zone" || tool.kind === "collision" || tool.kind === "barrier") && rulerCursor) {
      const cx = Math.floor(cursorWorld.x / CELL), cy = Math.floor(cursorWorld.y / CELL);
      const color = tool.kind === "collision" ? 0xff3040 : tool.kind === "barrier" ? 0xe89a2c : 0x40c0ff;
      overlay
        .rect(world.x + cx * CELL * zoom + 0.5, world.y + cy * CELL * zoom + 0.5, CELL * zoom - 1, CELL * zoom - 1)
        .stroke({ color, width: 1, alpha: 0.75 });
    }
  }
  drawRulers();
  requestRender();
}

// tell the world what we have selected (agents see it in the snapshot / over WS)
let selTimer = 0;
function postSelection() {
  if (!doc || renderMode) return;
  clearTimeout(selTimer);
  selTimer = window.setTimeout(() => {
    api(`/api/doc/${doc!.name}/selection`, "POST", { by: BY, ids: [...selection] }).catch(() => {});
  }, 300);
}

// ================= keyboard =================

function wireKeys(host: HTMLElement) {
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") { spaceHeld = false; host.style.cursor = toolCursor(); }
    if (e.key === "Alt") { altHeld = false; moveGhost(); }
  });
  window.addEventListener("keydown", (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (ctrl && k === "s") { e.preventDefault(); compileDoc(); return; }
    if (ctrl && k === "k") { e.preventDefault(); openPalette(); return; }
    if (inField) return;
    if (!doc) return;

    if (e.key === "Alt") { e.preventDefault(); altHeld = true; moveGhost(); return; }
    if (e.key === " ") { e.preventDefault(); spaceHeld = true; host.style.cursor = "grab"; return; }
    if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); undoRedo("undo"); return; }
    if ((ctrl && k === "y") || (ctrl && e.shiftKey && k === "z")) { e.preventDefault(); undoRedo("redo"); return; }
    if (ctrl && k === "a") {
      e.preventDefault();
      selection.clear();
      for (const n of scene!.nodes) if (n.view.visible && n.layerIndex === activeLayer) selection.add(n.inst.instance_id);
      inspect(); drawOverlay(); postSelection();
      return;
    }
    if (ctrl && k === "c") { copySelection(); return; }
    if (ctrl && k === "v") { e.preventDefault(); paste(); return; }
    if (ctrl && k === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selection.size) {
        e.preventDefault();
        const ops: Op[] = instsOf(selection).map((a) => ({
          op: "delete",
          id: a.inst.instance_id,
          expect: { object_definition: a.inst.object_definition, x: a.inst.x, y: a.inst.y },
        }));
        commit(`删除 ${ops.length} 个实例`, ops).then((ok) => { if (ok) selection.clear(); });
      }
      return;
    }
    if (e.key.startsWith("Arrow") && selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? CELL : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      const ops: Op[] = instsOf(selection).map((a) => ({
        op: "set",
        id: a.inst.instance_id,
        set: { x: a.inst.x + dx, y: a.inst.y + dy },
        expect: { x: a.inst.x, y: a.inst.y },
      }));
      commit("微调", ops);
      return;
    }
    if (e.key === "Escape") {
      if (drag && (drag.mode === "zone" || drag.mode === "paint")) { drag = null; drawOverlay(); $("s-hover").textContent = "—"; return; }
      if (tool.kind !== "select") setTool({ kind: "select" });
      else { selection.clear(); inspect(); drawOverlay(); postSelection(); }
      return;
    }
    if (k === "=" || k === "+") { e.preventDefault(); zoomStep(1); return; }
    if (k === "-") { e.preventDefault(); zoomStep(-1); return; }
    if (ctrl && k === "0") { e.preventDefault(); fit(); return; }
    if (ctrl && k === "1") { e.preventDefault(); zoomAt(1, host.clientWidth / 2, host.clientHeight / 2); return; }
    if (ctrl || e.altKey || e.metaKey) return;
    if (k === "v") { pickTool("select"); return; }
    if (k === "h" && !e.shiftKey) { pickTool("hand"); return; }
    if (k === "h") { toggles.hidden.checked = !toggles.hidden.checked; applyVisibility(); return; } // Shift+H
    if (k === "p") { pickTool("place"); return; }
    if (k === "c") { pickTool("collision"); return; }
    if (k === "b") { pickTool("barrier"); return; }
    if (k === "t") { pickTool("zone"); return; }
    if (k === "m") { pickTool("marker"); return; }
    if (k === "n") { pickTool("note"); return; }
    if (k === "f") fit();
    if (k === "1") zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
    if (k === "g") { toggles.grid.checked = !toggles.grid.checked; applyVisibility(); }
    if (k === "s") { toggles.snap.checked = !toggles.snap.checked; }
  });
}

function copySelection() {
  if (!doc || !selection.size) return;
  clipboard = instsOf(selection).map((a) => ({
    layerName: room().layers[a.layer].layer_name,
    inst: JSON.parse(JSON.stringify(a.inst)),
  }));
  $("s-hover").textContent = `已复制 ${clipboard.length} 个实例`;
}

// paste so the clipboard's top-left instance lands on the cursor cell; ids are stripped,
// the server hands out fresh ones from the high-water mark
function paste() {
  if (!doc || !clipboard.length) return;
  const minX = Math.min(...clipboard.map((c) => c.inst.x)), minY = Math.min(...clipboard.map((c) => c.inst.y));
  const dx = snapPoint(cursorWorld.x) - minX, dy = snapPoint(cursorWorld.y) - minY;
  const ops: Op[] = clipboard.map((c) => {
    const li = room().layers.findIndex((L) => L.layer_name === c.layerName && L.layer_type === LayerType.Instances);
    const inst = { ...c.inst, x: c.inst.x + dx, y: c.inst.y + dy } as any;
    delete inst.instance_id;
    return { op: "add", layer: room().layers[li >= 0 ? li : activeLayer].layer_name!, inst };
  });
  commit("粘贴", ops).then((ok) => {
    if (!ok || !doc) return;
    selection.clear();
    for (const id of doc.log[doc.log.length - 1]?.ids ?? []) selection.add(id);
    inspect(); drawOverlay();
  });
}

function duplicate() {
  if (!doc || !selection.size) return;
  const ops: Op[] = instsOf(selection).map((a) => {
    const inst = { ...a.inst, x: a.inst.x + CELL, y: a.inst.y + CELL } as any;
    delete inst.instance_id;
    return { op: "add", layer: room().layers[a.layer].layer_name!, inst };
  });
  commit("复制", ops).then((ok) => {
    if (!ok || !doc) return;
    selection.clear();
    for (const id of doc.log[doc.log.length - 1]?.ids ?? []) selection.add(id);
    inspect(); drawOverlay();
  });
}

// ================= inspector =================

type FieldKind = "int" | "num" | "color" | "code";
const FIELDS: { key: keyof RoomInstance; label: string; kind: FieldKind }[] = [
  { key: "x", label: "x", kind: "int" },
  { key: "y", label: "y", kind: "int" },
  { key: "scale_x", label: "scale_x", kind: "num" },
  { key: "scale_y", label: "scale_y", kind: "num" },
  { key: "rotation", label: "旋转", kind: "num" },
  { key: "image_index", label: "帧", kind: "int" },
  { key: "image_speed", label: "动画速度", kind: "num" },
  { key: "color", label: "颜色 AABBGGRR", kind: "color" },
  { key: "creation_code", label: "creation", kind: "code" },
  { key: "pre_create_code", label: "pre-create", kind: "code" },
];

const fmt = (kind: FieldKind, v: unknown) =>
  kind === "color" ? (Number(v) >>> 0).toString(16).toUpperCase().padStart(8, "0") : kind === "code" ? (v ?? "") : String(v);

function parseField(kind: FieldKind, s: string): { ok: true; v: unknown } | { ok: false } {
  s = s.trim();
  if (kind === "code") return { ok: true, v: s === "" ? null : s };
  if (kind === "color") {
    const h = s.replace(/^(0x|#)/i, "");
    return /^[0-9a-f]{1,8}$/i.test(h) ? { ok: true, v: parseInt(h, 16) >>> 0 } : { ok: false };
  }
  const n = Number(s);
  if (s === "" || !Number.isFinite(n)) return { ok: false };
  if (kind === "int" && !Number.isInteger(n)) return { ok: false };
  return { ok: true, v: n };
}

function inspect() {
  const body = $("inspect-body");
  const at = doc ? instsOf(selection) : [];
  syncInstSelection(false);
  if (!doc || at.length === 0) {
    body.innerHTML = `<span class="muted">单击选择实例；Shift 加选，空白处拖动框选。<br><br>工具：V 选择 · H 抓手 · P 放置 · C 碰撞涂刷 · T 区域 · M 标记 · N 便签。<br>「图层」页签中每个实例一行，拖动调整遮挡顺序。</span>`;
    return;
  }
  const insts = at.map((a) => a.inst);
  const first = insts[0];
  const n = nodeById.get(first.instance_id);
  const same = (k: keyof RoomInstance) => insts.every((i) => i[k] === first[k]);
  const layerIdx = at.map((a) => a.layer);
  const sameLayer = layerIdx.every((l) => l === layerIdx[0]);

  const inputs = FIELDS.map((f) => {
    const mixed = !same(f.key);
    return `<label>${f.label}</label><input data-k="${f.key}" data-kind="${f.kind}" class="${mixed ? "mixed" : ""}" value="${mixed ? "" : esc(fmt(f.kind, first[f.key]))}" placeholder="${mixed ? "（多个值）" : ""}" spellcheck="false" />`;
  }).join("");
  const layerOpts = room().layers
    .map((L, i) => (L.layer_type === LayerType.Instances ? `<option value="${i}" ${sameLayer && layerIdx[0] === i ? "selected" : ""}>${esc(L.layer_name)}</option>` : ""))
    .join("");

  const head = insts.length === 1
    ? `<div class="insp-title">${esc(first.object_definition)} <span class="h-meta">#${first.instance_id}</span></div>`
    : `<div class="insp-title">${insts.length} 个实例${same("object_definition") ? " · " + esc(first.object_definition) : ""}</div>`;

  let facts = "";
  if (insts.length === 1 && n) {
    const obj = first.object_definition ?? "";
    const chain = db.parentChain(obj);
    const flags: string[] = [];
    if (n.customDraw) flags.push(`<span class="flag">自定义 Draw：编辑器按默认绘制</span>`);
    if (n.kind === "hidden") flags.push(`<span class="flag info">游戏内不可见</span>`);
    if (n.kind === "collision") flags.push(`<span class="flag info">${paintLabel(obj)} ${first.scale_x}×${first.scale_y} 格</span>`);
    if (!db.objects[obj]) flags.push(`<span class="flag">原版和 assets.json 里都没有这个对象：AddRoomJson 会静默丢弃这个实例</span>`);
    else if (db.modObjects.has(obj)) flags.push(`<span class="flag info">mod 对象（assets.json 注册，生成 C# 先于 AddRoomJson）</span>`);
    facts = `<div class="insp-section kv">
        <div class="k">sprite</div><div class="v">${esc(db.objects[obj]?.sprite ?? "—")}</div>
        <div class="k">格</div><div class="v">${Math.floor(first.x / CELL)}, ${Math.floor(first.y / CELL)}</div>
        <div class="k">depth</div><div class="v">${n.depth}</div>
        <div class="k">  来源</div><div class="v">${esc(n.depthWhy)}</div>
        <div class="k">可见</div><div class="v">${esc(n.visibleWhy)}</div>
        <div class="k">instance_id</div><div class="v">${first.instance_id}（MSL 导入时重编号）</div>
      </div>
      <div class="chain">父链：${chain.length ? esc(chain.join(" → ")) : "（无）"}</div>
      <div>${flags.join("")}</div>`;
  }

  body.innerHTML = `${head}
    <div class="form">
      <label>图层</label><select data-layer>${sameLayer ? "" : '<option selected disabled>（多个图层）</option>'}${layerOpts}</select>
      ${inputs}
    </div>
    ${facts}`;

  body.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((inp) => {
    const commitField = () => {
      const key = inp.dataset.k as keyof RoomInstance;
      const kind = inp.dataset.kind as FieldKind;
      if (inp.classList.contains("mixed") && inp.value === "") return;
      const p = parseField(kind, inp.value);
      if (!p.ok) { inp.style.borderColor = "var(--bad)"; return; }
      if (insts.every((i) => i[key] === p.v)) return;
      const ops: Op[] = insts.map((i) => ({ op: "set", id: i.instance_id, set: { [key]: p.v } as any, expect: { [key]: i[key] } as any }));
      commit(`修改 ${key}`, ops);
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { commitField(); inp.blur(); }
      if (e.key === "Escape") { inspect(); }
    });
    inp.addEventListener("change", commitField);
  });
  body.querySelector<HTMLSelectElement>("select[data-layer]")!.onchange = (e) => {
    const to = Number((e.target as HTMLSelectElement).value);
    const layerName = room().layers[to].layer_name!;
    for (const o of new Set(at.map((a) => a.inst.object_definition ?? ""))) toastDepthCoded(o);
    const ops: Op[] = at.map((a) => ({
      op: "relayer",
      id: a.inst.instance_id,
      layer: layerName,
      expect: { layer: room().layers[a.layer].layer_name! },
    }));
    commit(`换图层 → ${layerName}`, ops);
    activeLayer = to;
  };
}

// ================= new-room dialog =================

async function openNewDialog() {
  const dlg = $("new-dialog") as HTMLDialogElement;
  const q = $<HTMLInputElement>("nd-q");
  const baseSel = $<HTMLSelectElement>("nd-base");
  const nameInp = $<HTMLInputElement>("nd-name");
  const fill = async () => {
    const list = await api(`/api/vanilla?q=${encodeURIComponent(q.value)}`);
    baseSel.innerHTML = list
      .map((r: any) => `<option value="${esc(r.name)}">${esc(r.name)} · ${r.w}×${r.h} · ${r.instances} 实例</option>`)
      .join("");
  };
  q.oninput = fill;
  await fill();
  dlg.showModal();
  $("nd-ok").onclick = async (e) => {
    e.preventDefault();
    const name = nameInp.value.trim();
    if (!/^r_[A-Za-z0-9_]+$/.test(name)) { alert("房间名格式不正确，应形如 r_sv_something"); return; }
    if (!baseSel.value) { alert("请选择一个原版房间作为基底"); return; }
    try {
      await api("/api/create", "POST", { name, base: baseSel.value, keep: $<HTMLSelectElement>("nd-keep").value, by: BY });
    } catch (err) {
      alert(`创建失败：${(err as Error).message}`);
      return;
    }
    dlg.close();
    await refreshRooms(name);
    await openRoom(name);
  };
}

// ================= websocket =================

function wireWs() {
  const hot = (import.meta as any).hot;
  if (!hot) return;
  hot.on("svre:event", async (e: any) => {
    if (e?.type === "created") { await refreshRooms(); return; }
    if (!doc || e?.room !== doc.name) return;
    switch (e.type) {
      case "change":
        if (e.entry?.by === BY) break; // our own commit already replayed it
        toast(`${whoText(e.entry?.by)}：${e.entry?.label ?? "修改了房间"}（r${e.entry?.rev}）`);
        await syncDoc();
        break;
      case "undo":
        if (e.by === BY) break;
        toast(`${whoText(e.by)} 撤销了 r${e.undone}`);
        await syncDoc();
        break;
      case "compiled":
        doc.compiledRev = e.rev;
        doc.dirty = false;
        updateChrome();
        break;
      case "notes":
        if (e.by === BY) break;
        toast(`${whoText(e.by)} 修改了便签`);
        doc = await api(`/api/doc/${doc.name}`);
        renderHistory();
        drawNotes();
        break;
      case "selection":
        if (e.by === BY) break;
        remoteSel.set(e.by, e.ids ?? []);
        drawOverlay();
        break;
      case "reloaded":
        toast("工程文件在磁盘上发生变化（git 操作或其他服务），已重新加载");
        await syncDoc();
        break;
    }
  });
}

const whoText = (by?: string) => (by === BY ? "你" : by ? `${by}` : "有人");

// scripting hook for headless checks (Playwright / svre render)
(window as any).svre = {
  focus: focusOn,
  set(name: keyof typeof toggles, on: boolean) {
    toggles[name].checked = on;
    applyVisibility();
  },
  get doc() { return doc; },
  get selection() { return [...selection]; },
  screen(wx: number, wy: number) { return { x: world.x + wx * zoom, y: world.y + wy * zoom }; },
  // a reliable click target for tests: screen center of the first visible drawn instance
  pickTarget() {
    const n = scene?.nodes.find((n) => n.kind === "drawn" && n.view.visible);
    if (!n) return null;
    const b = n.view.getBounds();
    return { id: n.inst.instance_id, object: n.inst.object_definition, x: b.x + b.width / 2, y: b.y + b.height / 2 };
  },
  kindOf(id: number) { return nodeById.get(id)?.kind ?? null; },
  visOf(id: number) { return nodeById.get(id)?.view.visible ?? null; },
  // view internals for render-fidelity pins: child classes of the node's view
  // (a sprite view holds a Sprite, the fallback marker diamond a Graphics + Text)
  viewInfo(id: number) {
    const n = nodeById.get(id);
    if (!n) return null;
    return { z: n.view.zIndex, a: n.view.alpha, kids: n.view.children.map((c) => c.constructor.name) };
  },
  // the canvas's live draw order, bottom-to-top: pixi's own children array (sorted
  // in place at render time) mapped back to instance ids, with the view's zIndex
  drawOrder() {
    if (!scene) return [];
    const ord = new Map(scene.root.children.map((c, i) => [c, i]));
    return scene.nodes
      .filter((n) => ord.has(n.view))
      .map((n) => ({ id: n.inst.instance_id, z: n.view.zIndex, ord: ord.get(n.view)! }))
      .sort((a, b) => a.ord - b.ord);
  },
  toolKind() { return tool.kind; },
  zmode(m?: "game" | "static") {
    if (m === "game" || m === "static") setZMode(m);
    return zMode;
  },
  instRowCount() { return document.querySelectorAll("#inst-list li.inst").length; },
  gateOf(id: number) { return resizeGate.get(id) ?? null; },
  // a stage-local point where canvas pick() returns this instance, or null if it's
  // fully covered by higher-z overlays (collision stamps, hidden boxes, markers)
  pickPoint(id: number) {
    const n = nodeById.get(id);
    if (!n) return null;
    const b = n.view.getBounds();
    for (let fy = 0.1; fy < 1; fy += 0.1)
      for (let fx = 0.1; fx < 1; fx += 0.1) {
        const x = b.x + b.width * fx, y = b.y + b.height * fy;
        if (pick(x, y) === n) return { x, y };
      }
    return null;
  },
  handlePoint(id: number, handle = "e") {
    const n = nodeById.get(id);
    if (!n || !resizeGate.get(id)) return null;
    const b = n.view.getBounds();
    const pts: Record<string, [number, number]> = {
      nw: [b.x, b.y], n: [b.x + b.width / 2, b.y], ne: [b.x + b.width, b.y],
      e: [b.x + b.width, b.y + b.height / 2], se: [b.x + b.width, b.y + b.height],
      s: [b.x + b.width / 2, b.y + b.height], sw: [b.x, b.y + b.height], w: [b.x, b.y + b.height / 2],
    };
    const p = pts[handle];
    return p ? { x: p[0], y: p[1] } : null;
  },
  // unscaled footprint + current world box of an instance (resize math checks)
  geom(id: number) {
    const n = nodeById.get(id);
    if (!n) return null;
    const lb = n.view.getLocalBounds();
    const vsx = n.view.scale.x, vsy = n.view.scale.y;
    return {
      lb: { x: lb.x, y: lb.y, w: lb.width, h: lb.height },
      box: { x: n.view.x + lb.x * vsx, y: n.view.y + lb.y * vsy, w: lb.width * vsx, h: lb.height * vsy },
    };
  },
  // a reliable resize target for tests: screen point of the east handle of the first
  // visible coverage rectangle (collision stamp / wall / trigger box)
  async pickRect() {
    for (const n of scene?.nodes ?? []) {
      if (n.kind === "marker" || !n.view.visible) continue;
      if (!(await computeResizeGate(n))) continue;
      const b = n.view.getBounds();
      // the follow-up click lands on the centre: only offer a rectangle that the
      // pick at that point would actually select -- a later sibling covering the
      // centre would win the click and the test would resize the wrong instance
      if (pick(b.x + b.width / 2, b.y + b.height / 2) !== n) continue;
      return { id: n.inst.instance_id, object: n.inst.object_definition, x: b.x + b.width, y: b.y + b.height / 2, bounds: { x: b.x, y: b.y, w: b.width, h: b.height } };
    }
    return null;
  },
  spriteOf(name: string) { const d = db.sprites[name]; return d && { w: d.w, h: d.h, ox: d.ox, oy: d.oy, frames: d.frames.length }; },
};

init().catch((e) => {
  console.error(e);
  $("load-state").textContent = `出错：${e.message}`;
});
