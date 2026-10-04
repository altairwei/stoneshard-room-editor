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
import { FAMILIES, familyLabel, searchObjects, thumbHtml, type Family } from "./palette";
import { ICONS, hydrateIcons } from "./icons.ts";
import { getLang, hydrate, initLang, objName, setLang, t, type Lang } from "./i18n/index.ts";
// the real Finding, not a narrow copy: the bottom panel needs `rule`/`ids`/`cells` to
// say where a problem is and to jump to it. analysis.ts only imports core/room.ts, so it
// is renderer-safe (server/store.ts uses the same types).
import type { Finding } from "./core/analysis.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

const BY = "human"; // this client's author identity in the log

// ---------------- server shapes ----------------

interface RoomEntry { name: string; hasProject: boolean; hasCompiled: boolean; dirty: boolean; drift: boolean; generatedBy: string[] }
interface LogSummary { rev: number; by: string; at: string; label: string; note?: string; undoOf?: number; ops: number; ids: number[] }
// GET /api/diagnostics. Declared here rather than imported from server/store.ts: that
// module pulls node:fs, which the renderer bundle cannot have.
interface ProjectDiagnostic { code: string; level: "error" | "warn" | "info"; message: string; subject?: string; paths?: string[] }
interface RoomDiagnostic { name: string; findings: Finding[]; problems: ReplayProblem[] }
interface Diagnostics { rooms: RoomDiagnostic[]; project: ProjectDiagnostic[]; totals: { error: number; warn: number; info: number } }
interface DocSnapshot {
  name: string; rev: number; compiledRev: number | null; dirty: boolean; drift: boolean;
  base: unknown; baseChanged: boolean; problems: ReplayProblem[]; notes: Note[];
  log: LogSummary[]; selection: Record<string, { ids: number[]; at: string }>;
  undoable: string[]; redoable: string[]; room: Room;
  vanilla?: boolean; // a vanilla cache room opened for viewing: no project, read-only
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
  // the server's diagnostics/log labels and error messages are localized per request
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}lang=${getLang()}`, {
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
const paintLabel = (object: string) => (object === BARRIER_PAINT ? t("屏障") : t("碰撞"));
const hiddenInsts = new Set<number>(); // per-instance editor-local hide (the eyes in the 图层 tab)
let dragRowId: number | null = null; // instance row mid-drag in the 图层 tab

// ---------------- project state (welcome page vs. editor) ----------------
// A mirror of the backend's three-state model (server/api.ts modeOf): "welcome" = no
// project open, which is a normal state and not a defect; "setup" = machine-level
// pieces (the asset cache, the depth facts) still missing; "ready" = the editor has
// both. The server decides, this side only renders -- no re-derivation, or the two
// drift apart on the first edge case.
type UiMode = "welcome" | "setup" | "ready";
interface ProjectInfo { path: string; name: string; exists: boolean }
interface RecentEntry extends ProjectInfo { at: string }
let uiMode: UiMode = "welcome";
let projectInfo: ProjectInfo | null = null;
let recentList: RecentEntry[] = [];
// A switch THIS tab started: the POST is in flight and the server's "project" event can
// land either before or after it returns. Both orders are fine -- the event just must
// not trigger a second, competing reload while the first one is on its way.
let switching = false;
// when Ctrl+K was last pressed: the second half of the Ctrl+K Ctrl+O chord. A timestamp
// rather than a boolean so a stray Ctrl+K cannot leave the chord armed forever.
let chordArmed = 0;

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
// a vanilla cache room is open for viewing only: rendering, selection and the inspector
// all work, every edit path is refused (commit() is the hard backstop)
const readOnly = () => !!doc?.vanilla;
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

let roToastAt = 0;
function toastReadOnly() {
  const now = Date.now();
  if (now - roToastAt < 4000) return; // one reminder per editing attempt burst
  roToastAt = now;
  toast(t("原版房间只读查看：要改动请「新建…」以它为基底派生工程"));
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
  b.textContent = m === "game" ? t("顺序：游戏") : t("顺序：静态");
  b.classList.toggle("static", m === "static");
  applyZ();
  pushMenuState();
}

// ---------------- UI theme (day/night chrome) ----------------
// index.html's inline script sets data-theme from svre.theme before first paint; this
// owns the state afterwards. Chrome colours are CSS tokens (style.css); the few canvas
// chrome colours pixi/2d-context paint with live here and follow the same switch.
// The room ART never follows the UI theme -- sprites, the artboard sheet and the
// overlay signal colours are game data or fixed signals, so the canvas keeps telling
// the game truth in either theme. Render mode stays on its own fixed dark, so CLI
// screenshots are identical regardless of the operator's theme.
type UiTheme = "dark" | "light";
// voidBg/sheet: pixi pasteboard + the artboard page. gridLine/gridMajor/bounds: canvas
// chrome drawn over the sheet. The room's own background FILL layers (the black void
// around interiors) are game data -- they are not here and never flip.
const THEME_CANVAS: Record<UiTheme, { voidBg: number; sheet: number; gridLine: number; gridMajor: number; bounds: number; rulerMinor: string; rulerMajor: string; rulerText: string; rulerCursor: string }> = {
  dark: { voidBg: 0x26282d, sheet: 0x0d0e11, gridLine: 0xffffff, gridMajor: 0xffe08a, bounds: 0xffd479, rulerMinor: "#3a414c", rulerMajor: "#565e6b", rulerText: "#8b93a1", rulerCursor: "#62a8ff" },
  light: { voidBg: 0xb9b6af, sheet: 0xd3d0c9, gridLine: 0x101014, gridMajor: 0xa67c00, bounds: 0xa67c00, rulerMinor: "#c6cad2", rulerMajor: "#a2a8b2", rulerText: "#5d6470", rulerCursor: "#2568cc" },
};

function uiTheme(): UiTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function setUiTheme(t: UiTheme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem("svre.theme", t);
  } catch {
    /* best effort */
  }
  if (!renderMode) app.renderer.background.color = THEME_CANVAS[t].voidBg;
  // the button shows the current theme, like 顺序 shows the current z mode
  $("b-theme").querySelector("i")!.innerHTML = ICONS[t === "light" ? "sun" : "moon"];
  drawRulers();
  redrawZoomDependent(); // re-paints artboard/grid/bounds with the theme's canvas colours
  pushMenuState();
}

// objects whose runtime depth is fixed by code: reordering or relayering them cannot
// change the game picture. Say so out loud -- a silent no-op reads as "the editor is
// broken" (it did, once).
function depthCodedWhy(obj: string): string | null {
  const c = db.createOf(obj);
  if (!c) return null;
  if (c.draw?.mode === "baked") return t("烙进背景 surface");
  const d = c.depth;
  if (d && !d.conditional && d.mode === "y") return t("游戏内按 depth=-y 排序");
  if (d && !d.conditional && d.mode === "const") return t("游戏内 depth 恒为 {value}", { value: d.value ?? "" });
  return null;
}
const depthToastAt = new Map<string, number>();
function toastDepthCoded(obj: string) {
  const why = depthCodedWhy(obj);
  if (!why) return;
  const now = Date.now();
  if (now - (depthToastAt.get(obj) ?? -1e9) < 8000) return; // one reminder per object per drag session
  depthToastAt.set(obj, now);
  toast(t("{obj} {why}：调序不影响游戏内遮挡，只改静态视图与创建顺序", { obj, why }));
}

// ================= boot =================

async function init() {
  const params = new URLSearchParams(location.search);
  renderMode = params.get("render") === "1";
  if (renderMode) document.body.classList.add("render");
  hydrateIcons();
  initLang(); // read the persisted language before the static HTML paints its text
  hydrate(); // swap every data-t leaf to the active lang (zh = the literal already there)
  wireWs(); // connect early: the setup wizard's progress rides this same channel
  // Three states, decided once by the server (see setupState): no project (welcome),
  // project but an incomplete machine (wizard), or both (the editor).
  const st: SetupState = await api("/api/setup");
  uiMode = st.mode;
  projectInfo = st.project;
  if (st.mode === "welcome") {
    // Nothing below has anything to work on: no store behind /api/rooms, no room, no
    // assets to load. `render` still gets its ready flag -- a screenshotter pointed at
    // an install with no project must get a blank canvas, not a hang.
    if (renderMode) { (window as any).svreReady = true; return; }
    await showWelcome(st);
    booted = true; // chrome-level menus (project.*, help.setup) are live from here
    return;
  }
  if (st.mode === "setup") {
    // A blocking dialog never resolves -- that is the whole point of this branch.
    await showSetupDialog(st);
    // Non-blocking + setup mode means nothing is missing and a round was asked for by hand
    // (POST /api/setup/restart): the gate is still closed, so there is no editor to boot.
    // What sits behind the dialog is the welcome page, whose machine strip names the round.
    if (renderMode) { (window as any).svreReady = true; return; }
    await showWelcome(st);
    booted = true;
    return;
  }

  // The window names the project from here on -- not only once a room is open: /api/rooms
  // is still a fetch away, and until then the title would claim to be nothing at all.
  setTitle(null);

  const host = $("stage");
  await app.init({ resizeTo: host, background: renderMode ? 0x0d0e11 : THEME_CANVAS[uiTheme()].voidBg, antialias: false, roundPixels: true, autoDensity: true, resolution: devicePixelRatio });
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

  $("load-state").textContent = t("加载资产…");
  await db.load();
  // the cache can be complete and still carry no depth facts (the wizard's scan step was
  // skipped, or create.json was emptied by hand): the game-order canvas is then really the
  // static one. Say it once, loudly, rather than drawing a wrong occlusion order silently.
  if (!Object.keys(db.create).length)
    toast(t("缺深度事实（create.json 为空）：对象写在 Create 里的 depth 代码读不到，「游戏顺序」已回退图层深度，遮挡可能与游戏内不一致"), 15000);
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
  $("b-theme").onclick = () => setUiTheme(uiTheme() === "light" ? "dark" : "light");
  setUiTheme(uiTheme()); // sync the icon with the theme index.html painted at boot
  wireViewMenu();
  wireToolbox();
  wireTabs();
  wireDock();
  wireBottomPanel();
  wirePalette();
  wireSpriteImport();
  wireVanillaDialog();
  wireInsts();
  wireViewport(host);
  wireKeys(host);
  // the chrome has been up since bootChrome(); this is just the "data is in" gate on the
  // menu actions (the checkmarks were already seated there, and setZMode/setUiTheme keep
  // them in sync from here on)
  booted = true;

  const initial = params.get("room");
  const wantVanilla = params.get("vanilla") === "1";
  if (renderMode) {
    // svre render: bare canvas, overlays from the URL, ready flag for the screenshotter
    for (const k of ["grid", "collision", "hidden", "markers", "notes"] as const)
      toggles[k].checked = params.get(k) === "1";
    const zm = params.get("z"); // ?z=static renders the UTMT audit view instead
    if (zm === "game" || zm === "static") setZMode(zm);
    if (initial) await openRoom(initial, { silent: true, vanilla: wantVanilla });
    const focus = params.get("focus")?.split(",").map(Number);
    const z = Number(params.get("zoom"));
    if (focus && focus.length === 2 && focus.every(Number.isFinite)) focusOn(focus[0], focus[1], Number.isFinite(z) && z > 0 ? z : zoom);
    else fit();
    app.render(); // deterministic pixels before the screenshotter's ready flag
    (window as any).svreReady = true;
    return;
  }
  if (initial ?? rooms[0]?.name) await openRoom(initial ?? rooms[0].name, { vanilla: wantVanilla && !!initial });
}

async function refreshRooms(selectAfter?: string) {
  rooms = await api("/api/rooms");
  const sel = $<HTMLSelectElement>("room-select");
  // vanilla cache rooms aren't projects and never appear in this list; the picker
  // entry opens a search dialog instead. While one is open it shows up as a marked
  // option so the dropdown keeps naming what the canvas shows.
  const vg = doc?.vanilla
    ? `<option value="${esc(doc.name)}" data-vanilla="1">${esc(doc.name)} · ${t("查看中")}</option>`
    : "";
  // Two groups, because the two things in here are not the same kind of thing: rooms of
  // the open project (writable, compiled, drift-checked) and vanilla cache rooms (read
  // only, no project behind them). An <optgroup> with no options is not rendered at all
  // by Chrome, so an empty project needs a placeholder or the group silently disappears.
  const own = rooms.length
    ? rooms
        .map((r) => {
          const marks = `${r.hasProject ? "" : " · " + t("未导入")}${r.dirty ? " ●" : ""}${r.drift ? " ⚠ " + t("漂移") : ""}`;
          return `<option value="${esc(r.name)}">${esc(r.name)}${marks}</option>`;
        })
        .join("")
    : `<option disabled>${t("（工程还没有房间：用「新建…」从原版房间派生一个）")}</option>`;
  sel.innerHTML =
    `<optgroup label="${esc(projectInfo?.name ?? t("工程"))}">${own}</optgroup>` +
    `<optgroup label="${t("原版（只读）")}">${vg}<option value="__vanilla_pick__">${t("打开原版房间…")}</option></optgroup>`;
  sel.onchange = () => {
    const v = sel.value;
    if (v === "__vanilla_pick__") {
      sel.value = doc?.name ?? ""; // revert: the dialog decides where we go
      openVanillaPicker();
      return;
    }
    if (sel.selectedOptions[0]?.dataset.vanilla) {
      if (v !== doc?.name || !doc?.vanilla) void openRoom(v, { vanilla: true });
      return;
    }
    void openRoom(v);
  };
  if (selectAfter) sel.value = selectAfter;
  else if (doc) sel.value = doc.name;
  // Nothing on screen yet (a brand-new project, or the room list came back before the
  // ?room= open did): updateChrome only runs once a room is open, so the title has to be
  // seated here or the window names the app instead of the project.
  if (!doc) setTitle(null);
  // A brand-new project (新建项目…) has no rooms yet, so nothing below will open one and the
  // status line would sit on "加载资产…" forever. Say what this state is instead.
  if (!rooms.length && !doc)
    $("load-state").textContent = `${projectInfo?.name ?? t("工程")} · ${t("还没有房间 · 用「新建…」从原版房间派生一个")}`;
}

// ================= welcome page (no project open) =================
// The window (and the Electron title bar, which mirrors document.title) names the open
// project: this app holds one at a time, and the title is the only place that says which.
const APP_NAME = "Stoneshard Room Editor";
function setTitle(roomName: string | null) {
  document.title = `${roomName ? `${roomName} — ` : ""}${projectInfo ? `${projectInfo.name} — ` : ""}${APP_NAME}`;
}

// The one way this tab leaves a project behind: a full reload. Not reload() -- that would
// keep ?room=<old> and try to open a room the new project does not have -- and not "/" --
// that breaks the moment the app is served under a base path. replace() also keeps the
// dead project out of the back button's history.
const hardReset = () => location.replace(location.pathname);

async function showWelcome(st: SetupState) {
  document.body.classList.add("no-project");
  document.body.classList.remove("vanilla-ro");
  $("welcome").hidden = false;
  setTitle(null); // the app names itself; there is no project to name
  paintMachineBar(st);
  $("wc-open").onclick = () => void openProjectDialog("打开项目");
  $("wc-new").onclick = () => void openProjectDialog("新建项目");
  await refreshProjects();
}

// The machine-level strip: what this install still needs before any project can open.
// It is about the MACHINE, so it does not change when the project does.
function paintMachineBar(st: SetupState) {
  const box = $("wc-machine");
  box.textContent = "";
  const missing: string[] = [];
  if (st.reasons.includes("cache")) missing.push("资产缓存");
  if (st.reasons.includes("create")) missing.push("深度事实（create.json）");
  if (!missing.length) {
    if (st.forced) missing.push("资产缓存（已请求重新提取）");
    else {
      const ok = document.createElement("div");
      ok.className = "wc-machine-ok";
      ok.textContent = `✓ ${t("本机已就绪（资产缓存 · 深度事实）")}${st.expected ? ` · ${t("参考版本")} ${st.expected.game}` : ""}`;
      box.append(ok);
      return;
    }
  }
  const bar = document.createElement("div");
  bar.className = "wc-machine-warn";
  const txt = document.createElement("span");
  // a missing cache blocks every project; a missing source tree only costs the
  // game-order canvas, which the editor already warns about on its own
  const soft = missing.length === 1 && missing[0].startsWith("深度事实");
  txt.textContent = `⚠ ${t("本机还缺：")}${missing.map((m) => t(m)).join(" · ")}${soft ? t("（不影响打开项目，遮挡顺序会回退图层深度）") : ""}`;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = t("运行本机设置…");
  btn.onclick = () => void openMachineSetup();
  bar.append(txt, btn);
  box.append(bar);
}

async function refreshProjects() {
  const p = await api("/api/projects");
  if (p.current) projectInfo = p.current;
  recentList = p.recent ?? [];
  renderRecent();
  pushMenuState(); // 最近打开 lives in the native menu, and the shell keeps no copy of its own
}

function renderRecent() {
  const list = $("wc-recent-list");
  list.textContent = "";
  if (!recentList.length) {
    const li = document.createElement("li");
    li.className = "wc-recent-empty";
    li.textContent = t("还没有打开过项目。");
    list.append(li);
    return;
  }
  for (const r of recentList) {
    const li = document.createElement("li");
    li.className = `wc-row${r.exists ? "" : " missing"}`;
    li.dataset.path = r.path;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "wc-row-open";
    open.title = r.exists ? t("打开 {path}", { path: r.path }) : t("{path} 已经不在了", { path: r.path });
    open.innerHTML = `<span class="wc-row-name">${esc(r.name)}</span><span class="wc-row-path">${esc(r.path)}</span>`;
    open.onclick = () => void openProject(r.path);
    li.append(open);

    if (!r.exists) {
      const gone = document.createElement("span");
      gone.className = "wc-row-missing";
      gone.textContent = t("文件夹不在了");
      li.append(gone);
    } else {
      const at = document.createElement("span");
      at.className = "wc-row-at";
      at.textContent = relTime(r.at);
      li.append(at);
    }

    const tools = document.createElement("span");
    tools.className = "wc-row-tools";
    if (hostBridge?.revealPath && r.exists) {
      const show = document.createElement("button");
      show.type = "button";
      show.title = t("在文件管理器中显示");
      show.textContent = "📁";
      show.onclick = () => void hostBridge!.revealPath!(r.path);
      tools.append(show);
    }
    const forget = document.createElement("button");
    forget.type = "button";
    forget.title = t("从列表移除（磁盘上的文件夹不动）");
    forget.textContent = "✕";
    forget.onclick = () => void forgetRecent(r.path);
    tools.append(forget);
    li.append(tools);
    list.append(li);
  }
}

// "3 天前" reads better than a timestamp in a shortlist, but a time of day never does:
// anything older than a week gets the date.
function relTime(iso: string): string {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return "";
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 90) return t("刚刚");
  if (s < 3600) return t("{n} 分钟前", { n: Math.round(s / 60) });
  if (s < 86400) return t("{n} 小时前", { n: Math.round(s / 3600) });
  if (s < 86400 * 7) return t("{n} 天前", { n: Math.round(s / 86400) });
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

async function forgetRecent(dir: string) {
  try {
    const r = await api("/api/projects/forget", "POST", { path: dir });
    recentList = r.recent ?? [];
    renderRecent();
    pushMenuState();
  } catch (e) {
    toast(t("移除失败：{err}", { err: (e as Error).message }));
  }
}

// 打开项目… and 新建项目… are the same gesture: pick (or type) a folder, then open it.
// The OS picker's createDirectory is what makes 新建项目 a new-folder dialog, so there is
// no second form to keep in sync -- and one route keeps the force/confirm semantics.
async function openProjectDialog(_kind: "打开项目" | "新建项目") {
  if (switching) return;
  const title = t(_kind === "新建项目" ? "新建项目文件夹" : "打开项目文件夹");
  const picked = hostBridge?.pickDir
    ? await hostBridge.pickDir(title)
    : await promptDialog(t(_kind === "新建项目"
        ? "新建项目：mod 源码目录的完整路径\n\n（目录不存在则新建；文件夹名会成为生成的 C# 命名空间，只能用字母、数字、下划线，且不以数字开头）"
        : "打开项目：mod 源码目录的完整路径\n\n（目录不存在则新建；文件夹名会成为生成的 C# 命名空间，只能用字母、数字、下划线，且不以数字开头）"));
  if (picked) await openProject(picked);
}

async function openProject(dir: string, force = false) {
  if (switching) return;
  switching = true;
  try {
    await api("/api/projects/open", "POST", { path: dir, force });
  } catch (e) {
    switching = false;
    // Not a mod tree: worth exactly one confirmation, then it opens anyway (the server
    // fills in the skeleton). Note the error body carries the machine-readable code in
    // `detail` -- that is what ApiError surfaces.
    if (e instanceof ApiError && e.status === 409 && (e.detail as { code?: string } | null)?.code === "unfamiliar") {
      if (await confirmDialog(e.message)) return openProject(dir, true);
      return;
    }
    await alertDialog(t(force ? "打开项目失败：{err}" : "项目失败：{err}", { err: e instanceof Error ? e.message : String(e) }));
    return;
  }
  hardReset(); // a switch rebuilds every cache in this tab; only a reload is honest
}

async function closeProject() {
  if (switching) return;
  // Nothing is lost -- every edit is already in rooms/<name>.room.json; only the compiled
  // snapshot is stale -- but "关闭" is exactly the word a user reads as "save and close".
  if (doc?.dirty && !(await confirmDialog(t("房间 {name} 有未编译的改动。\n\n关闭项目只是回到欢迎页：工程文件都在磁盘上，改动不会丢，只是还没编译进快照。", { name: doc.name })))) return;
  switching = true;
  try {
    await api("/api/projects/close", "POST", {});
  } catch (e) {
    switching = false;
    return alertDialog(t("关闭项目失败：{err}", { err: e instanceof Error ? e.message : String(e) }));
  }
  hardReset();
}

// The machine-level setup, reachable with or without a project open (菜单 帮助 → 本机设置…,
// or the welcome page's strip). With a project open and the machine ready it is not a
// blocker: the dialog closes and the editor is still there underneath.
//
// Deliberately NOT POST /api/setup/restart, which would flip every client of this backend
// into the blocking wizard. The old cache stays valid while a new extract runs, so the run
// itself is enough -- and it does not have to cost the user their editor.
async function openMachineSetup() {
  if (switching) return;
  const st: SetupState = await api("/api/setup");
  uiMode = st.mode;
  projectInfo = st.project;
  await showSetupDialog(st);
}

// ---------------- open / sync ----------------

// ---------------- in-page message dialogs ----------------
// window.confirm/alert/prompt are synchronous blocking calls; Electron never answers
// them, and the renderer wedges hard on the unanswered dialog IPC. Every user prompt
// goes through this one async <dialog> instead (nicer in the browser too).
function msgDialog(text: string, opts: { input?: string; okText?: string; cancel?: boolean } = {}): Promise<string | boolean | null> {
  const dlg = $<HTMLDialogElement>("msg-dialog");
  const inp = $<HTMLInputElement>("md-input");
  const cancelBtn = $<HTMLButtonElement>("md-cancel");
  $("md-text").textContent = text;
  inp.hidden = opts.input === undefined;
  inp.value = opts.input ?? "";
  cancelBtn.hidden = opts.cancel === false;
  $("md-ok").textContent = opts.okText ?? t("确定");
  const done = new Promise<string | boolean | null>((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue === "ok") resolve(opts.input !== undefined ? inp.value : true);
      else resolve(opts.input !== undefined ? null : false);
    }, { once: true });
  });
  dlg.showModal();
  (inp.hidden ? $("md-ok") : inp).focus();
  if (!inp.hidden) inp.select();
  return done;
}
const confirmDialog = (text: string) => msgDialog(text) as Promise<boolean>;
const alertDialog = async (text: string) => { await msgDialog(text, { cancel: false }); };
const promptDialog = (text: string, initial = "") => msgDialog(text, { input: initial }) as Promise<string | null>;

async function openRoom(name: string, opts: { silent?: boolean; vanilla?: boolean } = {}) {
  const entry = rooms.find((r) => r.name === name);
  if (!opts.vanilla && entry && !entry.hasProject) {
    // a compiled room with no project yet: offer to adopt it into a project
    if (opts.silent || !(await confirmDialog(t("房间 {name} 尚未导入。是否从 Codes/{name}.gml 创建工程？基底将自动推断。", { name })))) {
      $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
      return;
    }
    try {
      const r = await api("/api/import", "POST", { name, by: BY });
      toast(t("已导入 {name}：基底 {base}，{ops} 条操作", { name, base: r.base, ops: r.ops }));
    } catch (e) {
      await alertDialog(t("导入失败：{err}", { err: (e as Error).message }));
      $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
      return;
    }
    await refreshRooms(name);
  }
  $("load-state").textContent = t("打开 {name}…", { name });
  let snap: DocSnapshot;
  try {
    snap = await api(opts.vanilla ? `/api/vanilla-doc/${name}` : `/api/doc/${name}`);
  } catch (e) {
    $("load-state").textContent = t("打开失败：{err}", { err: (e as Error).message });
    $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
    return;
  }
  doc = snap;
  lintFindings = []; // a fresh room starts with no opinion; refreshLint refills projects
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
  await refreshRooms(name); // sync the dropdown (deep links, the vanilla marker option)
  updateChrome();
  refreshLint();
  refreshDiagnostics(true); // the panel covers every room, so opening one is a good moment
  history.replaceState(null, "", `?room=${encodeURIComponent(name)}${opts.vanilla ? "&vanilla=1" : ""}`);
}

// pull the server's state wholesale (someone else edited, undo/redo, adopt, 409 recovery)
async function syncDoc() {
  if (!doc || doc.vanilla) return; // vanilla views have no server-side state to sync
  doc = await api(`/api/doc/${doc.name}`);
  for (const id of [...selection]) if (!findInstance(room(), id)) selection.delete(id);
  await refreshScene();
  updateChrome();
  refreshDiagnostics(); // wholesale resync: adopt, undo/redo, 409 recovery, external reload
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
  if (readOnly()) { toastReadOnly(); return Promise.resolve(false); } // vanilla views take no edits
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
    refreshDiagnostics(); // an edit anywhere moves the project-wide list, not just this room's
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      toast(t("冲突：{msg}，已刷新到最新状态", { msg: e.message }));
      await syncDoc();
      return false;
    }
    toast(t("编辑失败：{err}", { err: (e as Error).message }));
    return false;
  }
}

async function undoRedo(which: "undo" | "redo") {
  if (!doc || readOnly()) { if (readOnly()) toastReadOnly(); return; }
  try {
    await api(`/api/doc/${doc.name}/${which}`, "POST", { by: BY });
    await syncDoc();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) toast(t(which === "undo" ? "没有可撤销的修改" : "没有可重做的修改"));
    else toast((e as Error).message);
    updateChrome();
  }
}

async function compileDoc() {
  if (!doc || readOnly()) { if (readOnly()) toastReadOnly(); return; }
  try {
    const r = await api(`/api/doc/${doc.name}/compile`, "POST", {});
    lintFindings = r.findings ?? [];
    toast(`${t("已编译 {file}（r{rev}），已同步 {rooms}", { file: r.file, rev: r.rev, rooms: r.roomsCs })}${lintFindings.length ? t(" · ⚠ {n} 条检查警告", { n: lintFindings.length }) : ""}`);
    await syncDoc();
    refreshDiagnostics(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (Array.isArray(e.detail)) {
        await alertDialog(`${t("日志无法在基底上完整重放，请先处理以下问题：\n\n")}${(e.detail as ReplayProblem[]).map((p) => t("r{rev}：{msg}", { rev: p.rev, msg: p.message })).join("\n")}`);
      } else if (await confirmDialog(`${e.message}\n\n${t("「确定」采纳磁盘上的外部改动（记入一条 external 日志）；「取消」不做改动。")}`)) {
        await adoptDoc();
        await compileDoc();
      }
    } else await alertDialog(t("编译失败：{err}", { err: (e as Error).message }));
  }
}

async function adoptDoc() {
  if (!doc) return;
  try {
    const r = await api(`/api/doc/${doc.name}/adopt`, "POST", { by: "external" });
    toast(r.ops ? t("已采纳外部改动：{n} 条操作已记入日志", { n: r.ops }) : t("磁盘文件与当前状态一致"));
    await syncDoc();
    await refreshRooms(doc.name);
  } catch (e) {
    await alertDialog(t("采纳失败：{err}", { err: (e as Error).message }));
  }
}

async function refreshLint() {
  if (!doc || renderMode || doc.vanilla) return; // lint speaks about the mod's rules; a cache room has no project to judge
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
  renderHistory();
  drawNotes();
  inspect();
  postSelection();
}

function applyVisibility() {
  pushMenuState();
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
  document.body.classList.toggle("vanilla-ro", readOnly());
  const counts = scene!.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  const bc = $<HTMLButtonElement>("b-compile");
  if (readOnly()) {
    // vanilla cache room: view-only chrome. No rev/compile state exists, edit buttons
    // stay inert, and the banner carries the one decision available (derive a project).
    bc.disabled = true;
    bc.classList.remove("primary");
    bc.innerHTML = `${ICONS.compile}<span>${t("编译")}</span>`;
    $<HTMLButtonElement>("b-undo").disabled = true;
    $<HTMLButtonElement>("b-redo").disabled = true;
    setTitle(t("{name}（原版 · 只读）", { name: room().name }));
    // no room name here: the dropdown names it ("xxx · 查看中"), and so does the title bar
    $("load-state").textContent =
      t("原版缓存 · 只读 · {w}×{h}", { w: room().width, h: room().height }) +
      t(" · 可见 {drawn} · 隐形 {hidden} · 碰撞 {collision} · 标记 {marker}", { drawn: counts.drawn ?? 0, hidden: counts.hidden ?? 0, collision: counts.collision ?? 0, marker: counts.marker ?? 0 });
    $("history-badge").textContent = "";
    const banner = $("banner");
    banner.hidden = false;
    banner.innerHTML = t("原版缓存房间 · 只读查看，任何编辑都不会落盘。要基于它修改：「新建…」以它为基底派生工程（写入 mod 的 rooms/）。");
    return;
  }
  bc.disabled = false;
  const dirty = doc.dirty;
  bc.classList.toggle("primary", dirty);
  bc.innerHTML = `${ICONS.compile}<span>${t("编译")}</span>${dirty ? `<span class="dirty-dot" title="${t("有未编译的改动")}">●</span>` : ""}`;
  const canUndo = doc.undoable.includes(BY);
  const canRedo = doc.redoable.includes(BY);
  $<HTMLButtonElement>("b-undo").disabled = !canUndo;
  $<HTMLButtonElement>("b-redo").disabled = !canRedo;
  setTitle(`${dirty ? "● " : ""}${room().name}`);
  // the room name is the dropdown's job and the title bar's; the problem count is the
  // status bar's. What is left: how this room's log and contents stand right now.
  $("load-state").textContent =
    `r${doc.rev}` + (doc.compiledRev !== null ? t(" · 编译于 r{rev}", { rev: doc.compiledRev }) : t(" · 从未编译")) +
    t(" · {w}×{h} · 可见 {drawn} · 隐形 {hidden} · 碰撞 {collision} · 标记 {marker}", { w: room().width, h: room().height, drawn: counts.drawn ?? 0, hidden: counts.hidden ?? 0, collision: counts.collision ?? 0, marker: counts.marker ?? 0 });

  // badge = entries arrived since the history tab was last open
  const unseen = doc.log.filter((e) => e.rev > lastSeenRev).length;
  $("history-badge").textContent = unseen ? String(unseen) : "";

  // banner: drift and a changed base are the two states that need a decision
  const entry = rooms.find((r) => r.name === doc!.name);
  const banner = $("banner");
  let html = "";
  if (doc.drift)
    html = `⚠ ${t("磁盘上的 rooms/{name}.compiled.json 在上次编译后被外部修改（生成器或手工编辑）。编译前请先采纳，或强制覆盖。", { name: esc(doc.name) })}<button data-act="adopt">${t("采纳外部改动")}</button>`;
  else if (doc.baseChanged)
    html = `⚠ ${t("基底房间已变更（可能是游戏更新）。日志仍会照常重放{again}。", { again: doc.problems.length ? t("，但有 {n} 条操作无法对应", { n: doc.problems.length }) : "" })}`;
  else if (doc.problems.length)
    html = `⚠ ${t("{n} 条日志无法在基底上重放，编译将被拒绝。", { n: doc.problems.length })}`;
  else if (entry?.generatedBy.length)
    html = t("此房间曾由 {who} 生成。工程已接管其内容，请勿再运行生成器，否则会覆盖编译产物。", { who: esc(entry.generatedBy.join("、")) });
  banner.hidden = !html;
  banner.innerHTML = html;
  banner.querySelector('button[data-act="adopt"]')?.addEventListener("click", adoptDoc);
}

// ================= bottom panel: 问题 / 日志 =================
// Where the answer to "app 显示有 6 条警告，我去哪看" lives. 「问题」is the whole project's
// lint in one list -- every room at once, which is what the top bar's count was silently
// summarising -- and each row jumps to the instance it is about. 「日志」is what this page
// received from the server's event stream: the same events the sync logic below already
// consumes and mostly discards, kept instead of dropped.

interface LogLine { at: string; kind: string; text: string; room?: string; key?: string; n: number }

const BP_OPEN = "svre.panel.open";
const BP_H = "svre.panel.h";
const BP_TAB = "svre.panel.tab";
const BP_MIN_H = 90; // the tab strip plus one line; below this it is not worth opening
const LOG_MAX = 500; // ring buffer: the panel is a session view, not an audit log

const LVL: Record<string, string> = { error: "✕", warn: "⚠", info: "ℹ" };
const KIND: Record<string, string> = {
  project: "项目", setup: "本机设置", assets: "资产", created: "新建房间", change: "改动",
  undo: "撤销", compiled: "编译", notes: "便签", selection: "选区", reloaded: "重载",
  local: "本页",
};

// undefined = never asked, null = the ask failed, an object = the answer. The panel says
// something different for each, so "还没有结果" never reads as "没有问题".
let diag: Diagnostics | null | undefined;
let diagTimer: number | null = null;
let diagBusy = false; // a second pass arrived while the first was in flight
let bpTab: "problems" | "log" = "problems";
let logLines: LogLine[] = [];

// "is the panel actually on screen": `hidden` alone is not enough, because body.no-project
// hides it with CSS too, and the banner-style rules must not think it is up then.
const bpUp = () => !$("bottom-panel").hidden && uiMode === "ready" && !renderMode;

function bpShow(tab?: "problems" | "log") {
  $("bottom-panel").hidden = false;
  if (tab) setBpTab(tab);
  else setBpTab(bpTab);
  try { localStorage.setItem(BP_OPEN, "1"); } catch { /* private mode */ }
  refreshDiagnostics(true);
}

function bpHide() {
  $("bottom-panel").hidden = true;
  try { localStorage.setItem(BP_OPEN, "0"); } catch { /* private mode */ }
  syncProblemsChrome();
}

// the menu item and the shortcut toggle; an explicit tab switches to it instead of closing,
// so "视图 → 日志" always lands on the log rather than making the user press it twice
function bpToggle(tab?: "problems" | "log") {
  if ($("bottom-panel").hidden) bpShow(tab);
  else if (tab && bpTab !== tab) setBpTab(tab);
  else bpHide();
}

function setBpTab(tab: "problems" | "log", remember = true) {
  bpTab = tab;
  if (remember) try { localStorage.setItem(BP_TAB, tab); } catch { /* private mode */ }
  document.querySelectorAll<HTMLButtonElement>(".bp-tabs button[data-bptab]").forEach((b) => b.classList.toggle("on", b.dataset.bptab === tab));
  $("bpt-problems").hidden = tab !== "problems";
  $("bpt-log").hidden = tab !== "log";
  if (tab === "log") renderLog();
  else renderProblems();
  syncProblemsChrome();
}

// the count is "things you would act on": errors and warnings, not the info notes.
// It lives on the status bar (and on the tab while the list is not the thing on screen);
// the top bar's own copy was merged away with the appbar -- the status bar is the entry.
function syncProblemsChrome() {
  const n = diag ? diag.totals.error + diag.totals.warn : 0;
  $("problems-badge").textContent = n && !(bpUp() && bpTab === "problems") ? String(n) : "";
  const s = $("s-problems");
  s.hidden = !n;
  s.textContent = n ? `⚠ ${n}` : "";
  s.classList.toggle("bad", !!diag && diag.totals.error > 0);
  s.title = !n ? "" : diag ? t("{err} 个错误 · {warn} 个警告 · 点击查看（Ctrl+Shift+M）", { err: diag.totals.error, warn: diag.totals.warn }) : t("点击查看（Ctrl+Shift+M）");
}

// lint is advisory and every edit invalidates it, so a burst of commits coalesces into
// one pass. `immediate` is for the moments where waiting would be visible: the panel
// opening, the 重新检查 button, a room load.
function refreshDiagnostics(immediate = false) {
  if (diagTimer !== null) { clearTimeout(diagTimer); diagTimer = null; }
  if (immediate) { void loadDiagnostics(); return; }
  diagTimer = window.setTimeout(() => { diagTimer = null; void loadDiagnostics(); }, 350);
}

async function loadDiagnostics() {
  if (renderMode || uiMode !== "ready") return;
  if (diagBusy) { refreshDiagnostics(); return; } // one at a time; re-arm for the latest state
  diagBusy = true;
  try {
    diag = (await api("/api/diagnostics")) as Diagnostics;
  } catch {
    diag = null; // the panel says so rather than toasting on every retry
  } finally {
    diagBusy = false;
  }
  if (bpUp() && bpTab === "problems") renderProblems();
  syncProblemsChrome();
}

function renderProblems() {
  const list = $("problems-list");
  const rows: string[] = [];
  if (!diag)
    rows.push(
      diag === null
        ? `<li class="p-row muted">${t("检查失败。")}<button id="bp-retry" class="bp-act">${t("重试")}</button></li>`
        : `<li class="p-row muted">${t("正在检查整个项目…")}</li>`,
    );
  else {
    for (const r of diag.rooms) {
      if (!r.findings.length && !r.problems.length) continue;
      const n = r.findings.filter((f) => f.level !== "info").length + r.problems.length;
      rows.push(`<li class="grp"><span class="gname">${esc(r.name)}</span><span class="gcount">${t("{n} 条", { n: n || r.findings.length })}</span></li>`);
      // a replay problem blocks compilation and has no id list to select -- it is about the
      // log against the base, not about an instance, so it is the one row that is not a link
      for (const p of r.problems)
        rows.push(`<li class="p-row error"><span class="p-lvl">${LVL.error}</span><span class="p-msg">${t("日志无法在基底上重放：{msg}", { msg: esc(p.message ?? String(p)) })}</span></li>`);
      for (const f of r.findings) rows.push(problemRow(r.name, f));
    }
    if (diag.project.length) {
      rows.push(`<li class="grp"><span class="gname">${t("项目")}</span></li>`);
      for (const p of diag.project) {
        rows.push(`<li class="p-row ${p.level}"><span class="p-lvl">${LVL[p.level] ?? "•"}</span><span class="p-msg">${esc(p.message)}</span></li>`);
        if (p.paths?.length) rows.push(`<li class="p-paths">${p.paths.map(esc).join("<br>")}</li>`);
      }
    }
    if (!rows.length) rows.push(`<li class="p-row muted">${t("没有问题")}</li>`);
  }
  list.innerHTML = rows.join("");
  list.querySelector<HTMLButtonElement>("#bp-retry")?.addEventListener("click", () => refreshDiagnostics(true));
  list.querySelectorAll<HTMLElement>("li.p-row.jump").forEach((li) => {
    li.onclick = () => void gotoProblem(li.dataset.room!, li.dataset.ids ?? "", li.dataset.cells ?? "");
  });
}

function problemRow(roomName: string, f: Finding): string {
  const ids = f.ids ?? [];
  const cells = f.cells ?? [];
  const jump = ids.length > 0 || cells.length > 0;
  const where = cells.length ? `${cells[0][0]},${cells[0][1]}` : ids.length ? `#${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ""}` : "";
  const title = t("点击定位（{room}{extra}）", { room: esc(roomName), extra: doc && doc.name === roomName ? "" : t(" · 会先打开这个房间") });
  return `<li class="p-row ${f.level}${jump ? " jump" : ""}"${jump ? ` data-room="${esc(roomName)}" data-ids="${ids.join(",")}" data-cells="${cells.map((c) => c.join(",")).join(";")}" title="${title}"` : ""}>` +
    `<span class="p-lvl">${LVL[f.level] ?? "•"}</span><span class="p-msg">${esc(f.message)}</span>` +
    `<span class="p-loc">${esc(where)}</span>` +
    `<span class="p-rule">${esc(f.rule)}</span></li>`;
}

// Jump to what a finding is about. A finding on another room has to open that room first
// (the load is async and re-renders everything, so the locator runs after it settles).
async function gotoProblem(roomName: string, idsCsv: string, cellsCsv: string) {
  const ids = idsCsv ? idsCsv.split(",").map(Number).filter((n) => Number.isFinite(n)) : [];
  const cells = cellsCsv ? (cellsCsv.split(";").map((c) => c.split(",").map(Number)) as [number, number][]) : [];
  if (!doc || doc.name !== roomName) {
    await openRoom(roomName);
    if (!doc || doc.name !== roomName) return; // the open failed; the toast already said why
  }
  // a finding that names the instances it is about selects them; one that only knows a
  // place (a missing starter, a leak) still gets the camera pointed at it
  const live = ids.filter((id) => nodeById.has(id));
  if (live.length) {
    selection.clear();
    for (const id of live) selection.add(id);
    syncInstSelection(false);
    inspect();
    drawOverlay();
    postSelection();
    flashIds(live);
  }
  const [cx, cy] = cells[0] ?? [];
  if (cx !== undefined && cy !== undefined) focusOn(cx * CELL + CELL / 2, cy * CELL + CELL / 2, Math.max(zoom, 1.5));
  else if (live.length) {
    const n = nodeById.get(live[0])!;
    focusOn(n.inst.x, n.inst.y, Math.max(zoom, 1.5));
  }
}

function renderLog() {
  $("log-list").innerHTML = logLines.length
    ? logLines
        .slice()
        .reverse()
        .map((l) =>
          `<li><span class="l-at">${esc(l.at.slice(11, 19))}</span><span class="l-kind">${esc(t(KIND[l.kind] ?? l.kind))}</span>` +
          `<span class="l-text">${esc(l.text)}${l.n > 1 ? ` <span class="l-at">×${l.n}</span>` : ""}` +
          `${l.room ? ` <span class="l-at">${esc(l.room)}</span>` : ""}</span></li>`,
        )
        .join("")
    : `<li class="muted" style="padding:10px">${t("还没有收到服务端事件")}</li>`;
}

// Called at the very top of onStoreEvent, before its early-returns throw events away.
// Scope, stated plainly: only what this page received -- the server's own console output
// is not in the stream, and a second tab's private traffic is not either.
function recordLog(e: any) {
  const kind = String(e?.type ?? "?");
  if (kind === "setup") {
    // first-run progress reports every file of an extract; collapse a run of the same
    // job+phase into one line with a counter instead of flooding the buffer
    const key = `${e.job ?? ""}/${e.phase ?? ""}`;
    const text = [e.job, e.phase, e.line, e.detail].filter(Boolean).join(" · ") || (e.mismatches ? t("{n} 处统计差异", { n: e.mismatches }) : t("本机设置"));
    const last = logLines[logLines.length - 1];
    if (last?.key === key) {
      last.text = text;
      last.at = e.at ?? new Date().toISOString();
      last.n++;
    } else pushLog({ at: e.at ?? new Date().toISOString(), kind, text, key, n: 1 });
    return;
  }
  // Our own cursor moving is not an event worth recording: postSelection echoes every
  // click back through the server, and a log where 90% of the lines are "你选中了 N 个实例"
  // is a log nobody reads. Someone else's cursor moving still is.
  if (kind === "selection" && e.by === BY) return;
  let text: string;
  switch (kind) {
    case "project": text = e.mode === "welcome" ? t("关闭了项目") : t("打开项目 {name}", { name: e.project?.name ?? "" }); break;
    case "created": text = t("新建房间 {name}", { name: e.name ?? "" }); break;
    case "assets": text = `${whoText(e.by)}${t("导入了 {obj}", { obj: e.object ?? "mod sprite" })}`; break;
    case "change": text = t("{who}：{label}（r{rev}）", { who: whoText(e.entry?.by), label: e.entry?.label ?? t("修改了房间"), rev: e.entry?.rev }); break;
    case "undo": text = `${whoText(e.by)}${t("撤销了 r{rev}", { rev: e.undone })}`; break;
    case "compiled": text = t("编译完成（r{rev}）", { rev: e.rev }); break;
    case "notes": text = `${whoText(e.by)}${t("修改了便签")}`; break;
    case "selection": text = `${whoText(e.by)}${t("选中了 {n} 个实例", { n: e.ids?.length ?? 0 })}`; break;
    case "reloaded": text = t("工程文件在磁盘上变化，已重新加载"); break;
    default: text = kind;
  }
  pushLog({ at: e.at ?? new Date().toISOString(), kind, text, room: e.room, n: 1 });
}

function pushLog(l: LogLine) {
  logLines.push(l);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
  if (bpUp() && bpTab === "log") renderLog();
}

function wireBottomPanel() {
  document.querySelectorAll<HTMLButtonElement>(".bp-tabs button[data-bptab]").forEach((b) => {
    b.onclick = () => setBpTab(b.dataset.bptab as "problems" | "log");
  });
  $("bp-close").onclick = () => bpHide();
  $("bp-refresh").onclick = () => refreshDiagnostics(true);
  $("s-problems").onclick = () => bpShow("problems");
  // the whole strip is a drag handle: pointer capture means the drag survives the cursor
  // leaving the 6px band, which it does immediately
  const grip = $("bp-resize");
  const panel = $("bottom-panel");
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("dragging");
    const startY = e.clientY;
    const startH = panel.getBoundingClientRect().height;
    const move = (ev: PointerEvent) => {
      // keep at least 160px of canvas: a panel that can swallow the editor is a trap
      panel.style.height = `${Math.max(BP_MIN_H, Math.min(window.innerHeight - 160, startH + (startY - ev.clientY)))}px`;
    };
    const up = () => {
      grip.classList.remove("dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      try { localStorage.setItem(BP_H, String(Math.round(panel.getBoundingClientRect().height))); } catch { /* private mode */ }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });
  try {
    const h = Number(localStorage.getItem(BP_H));
    if (Number.isFinite(h) && h >= BP_MIN_H) panel.style.height = `${h}px`;
    if (localStorage.getItem(BP_TAB) === "log") bpTab = "log";
    // restored open even before a project is loaded: body.no-project hides it until there
    // is an editor to put it under, which is exactly what the user left behind
    if (localStorage.getItem(BP_OPEN) === "1") panel.hidden = false;
  } catch { /* private mode: the defaults are fine */ }
  setBpTab(bpTab, false);
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
      return `<li data-i="${i}" class="${cls}" title="${inst ? t("单击设为当前图层（新对象将放入此层）") : t("非实例图层，只读")}">
        <span class="eye" data-eye="${i}" title="${t("显示/隐藏")}">${layerOff.has(i) ? ICONS.eyeOff : ICONS.eye}</span>
        <span class="name">${esc(L.layer_name)}${L.is_visible ? "" : ' <span class="tag">' + t("游戏内隐藏") + '</span>'}</span>
        <span class="meta">${t(typeName[L.layer_type] ?? L.layer_type)} ${n} · d${L.layer_depth}</span></li>`;
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
    rows.push(`<li class="grp${i === activeLayer ? " active" : ""}" data-gi="${i}" title="${t("单击设为放置目标层；将实例拖到此行即移至该层最前")}">
      <span class="gname">${esc(L.layer_name)}</span><span class="gmeta">d${L.layer_depth} · ${insts.length}</span></li>`);
    for (const inst of shown) {
      const n = nodeById.get(inst.instance_id);
      const obj = inst.object_definition ?? "";
      const badge = n && n.depth !== L.layer_depth ? `<span class="depth-badge" title="${esc(n.depthWhy)}">d${n.depth}</span>` : "";
      rows.push(`<li class="inst${selection.has(inst.instance_id) ? " sel" : ""}${hiddenInsts.has(inst.instance_id) ? " off" : ""}"
        data-id="${inst.instance_id}" draggable="${readOnly() ? "false" : "true"}" title="${esc(obj)} #${inst.instance_id}&#10;${esc(n?.depthWhy ?? "")}&#10;${readOnly() ? t("原版房间只读，不能调序") : t("拖动调整数组顺序（组内调序 / 跨组换层）")}">
        <span class="grip">${ICONS.grip}</span>${thumbHtml(db, obj, inst.image_index, 28)}
        <div class="itext"><div class="iname">${esc(obj)} <span class="iid">#${inst.instance_id}</span>${badge}</div>
        <div class="imeta">@${inst.x},${inst.y}${inst.scale_x !== 1 || inst.scale_y !== 1 ? ` · ${inst.scale_x}×${inst.scale_y}` : ""}</div></div>
        <span class="eye" data-eye="${inst.instance_id}" title="${t("编辑器内隐藏（不影响游戏）")}">${hiddenInsts.has(inst.instance_id) ? ICONS.eyeOff : ICONS.eye}</span></li>`);
    }
  }
  const list = $("inst-list");
  list.innerHTML = rows.join("") || `<li class="muted" style="padding:10px">${t("没有匹配的实例")}</li>`;
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
      if (readOnly()) { e.preventDefault(); return; }
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
  if (!doc || readOnly()) return;
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
  commit(toLayer === src.layer ? t("调整顺序 {obj}", { obj }) : t("移到 {layer}：{obj}", { layer: dstName, obj }), [
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

// 视图 dropdown: in a plain browser the top bar's view controls (order, zoom, theme)
// collect into this popover; in the Electron shell the native menu owns them and the
// button is menu-only, so this never shows there.
function wireViewMenu() {
  const btn = $("b-view"), menu = $("view-menu");
  const close = () => { menu.hidden = true; };
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("pointerdown", (e) => {
    if (!menu.hidden && !menu.contains(e.target as Node) && !btn.contains(e.target as Node)) close();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  // a command closes the menu; the zoom <select> stays open until the user picks
  menu.addEventListener("click", (e) => { if ((e.target as HTMLElement).closest("button")) close(); });
  // language row: switch in place, then re-paint static HTML and pull server text in the
  // new lang (?lang= is read by api() at call time, so a refresh re-localizes everything)
  const langRow = [...document.querySelectorAll<HTMLButtonElement>("#lang-row button")];
  const seatLangRow = () => {
    for (const b of langRow) b.classList.toggle("lang-on", b.dataset.lang === getLang());
  };
  for (const b of langRow) b.onclick = () => {
    setLang((b.dataset.lang as "zh" | "en" | "ru") ?? "zh");
    hydrate();
    // re-render the JS-owned lists too: hydrate only repaints static [data-t] HTML, and
    // these lists embed their own translated strings. The scene's already-built nodes
    // keep their build-time depthWhy/visibleWhy until the room is rebuilt -- accepted.
    renderLayerList();
    renderInstList();
    renderHistory();
    if ($<HTMLDialogElement>("palette-dialog").open) renderPalette();
    refreshLint();
    refreshDiagnostics(true);
    seatLangRow();
  };
  seatLangRow();
}

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
  return `<span class="who ${cls}">${esc(t(WHO[by] ?? by))}</span>`;
};

function renderHistory() {
  if (!doc || $("tab-history").hidden) return;
  const list = $("history-list");
  list.innerHTML = doc.log
    .slice()
    .reverse()
    .map((e) => {
      const time = e.at.slice(11, 19);
      return `<li data-rev="${e.rev}" class="${e.undoOf !== undefined ? "undo" : ""}" title="${t("点击高亮本次改动涉及的实例")}">
        <div class="h-top">${whoBadge(e.by)}<span class="h-label">${esc(e.label || t("(未命名)"))}</span><span class="h-meta">r${e.rev} · ${time}</span></div>
        <div class="h-meta">${t("{n} 条操作", { n: e.ops })}${e.ids.length ? ` · id ${e.ids.slice(0, 8).join(",")}${e.ids.length > 8 ? "…" : ""}` : ""}</div>
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
        <button data-note="${n.id}" title="${t("删除便签")}">×</button></div>`,
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
  if (!doc || readOnly()) { if (readOnly()) toastReadOnly(); return; }
  const text = await promptDialog(t("便签（{x}, {y}）：人类和 agent 均可见", { x: Math.round(wx), y: Math.round(wy) }));
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
  if (readOnly()) { toastReadOnly(); return; } // the library arms the place tool
  const dlg = $<HTMLDialogElement>("palette-dialog");
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
  fam.innerHTML = FAMILIES.map((f, i) => `<button data-f="${i}" class="${f === family ? "on" : ""}">${familyLabel(f)}</button>`).join("");
  fam.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => {
      family = FAMILIES[Number(b.dataset.f)];
      fam.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      renderPalette();
    };
  });
  let timer = 0;
  q.oninput = () => { clearTimeout(timer); timer = window.setTimeout(renderPalette, 80); };
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
      `${n} · ${db.objects[n]?.sprite ?? t("无 sprite")}${chain ? " · " + chain : ""}${db.modObjects.has(n) ? " · " + t("mod 自建") : ""}`;
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
      const mod = db.modObjects.has(n) ? `<i class="mod-badge" title="${t("mod 自建对象（assets.json 注册）")}">mod</i>` : "";
      return `<li data-o="${esc(n)}" class="${on}" title="${esc(n)}">${thumbHtml(db, n, 0, 56)}${mod}<span class="pname">${esc(objName(n) || n.replace(/^o_/, ""))}</span></li>`;
    })
    .join("") || `<li class="muted" style="padding:10px;grid-column:1/-1">${t("没有匹配的对象")}</li>`;
  list.querySelectorAll<HTMLElement>("li[data-o]").forEach((li) => {
    li.onclick = () => { setTool({ kind: "place", object: li.dataset.o! }); closePalette(); };
  });
}

// ---- sprite import (the artist flow: draw PNG -> register into the mod -> place) ----
// Writes Sprites/*.png + an assets.json entry via the server; the generated C# and every
// open client then heal/refresh off the same manifest, so what the artist places is what
// the game will register. Mod-level action: allowed even on the vanilla read-only view.
let spriteFiles: File[] = [];

function openSpriteImport() {
  const dlg = $<HTMLDialogElement>("sprite-dialog");
  if (!dlg.open) {
    // a fresh import starts from defaults, never from the previous one's leftovers
    spriteFiles = [];
    $<HTMLInputElement>("sd-files").value = "";
    $("sd-preview").textContent = t("可多选：多个文件按文件名 _N 顺序作为多帧");
    for (const id of ["sd-sprite", "sd-object", "sd-note"]) $<HTMLInputElement>(id).value = "";
    $<HTMLInputElement>("sd-ox").value = "0";
    $<HTMLInputElement>("sd-oy").value = "0";
  }
  dlg.showModal();
}

function wireSpriteImport() {
  const dlg = $<HTMLDialogElement>("sprite-dialog");
  dlg.querySelector("form")!.addEventListener("submit", (e) => e.preventDefault()); // Enter must not navigate
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
  $("b-import-sprite").onclick = openSpriteImport;
  $("sd-cancel").onclick = () => dlg.close();
  $("sd-ok").onclick = () => void submitSpriteImport();
  $<HTMLInputElement>("sd-files").onchange = onSpriteFiles;
}

function onSpriteFiles() {
  // frames in explicit _N order first, then alphabetical; the FileList itself is
  // read-only, so the sorted copy is what submit reads
  spriteFiles = [...($<HTMLInputElement>("sd-files").files ?? [])].sort((a, b) => {
    const n = (f: File) => { const m = /_(\d+)\.png$/i.exec(f.name); return m ? Number(m[1]) : -1; };
    return n(a) - n(b) || a.name.localeCompare(b.name);
  });
  const prev = $("sd-preview");
  prev.innerHTML = "";
  if (!spriteFiles.length) { prev.textContent = t("可多选：多个文件按文件名 _N 顺序作为多帧"); return; }
  const img = document.createElement("img");
  img.src = URL.createObjectURL(spriteFiles[0]);
  img.style.cssText = "image-rendering:pixelated;max-height:64px;max-width:96px;vertical-align:middle;margin-right:8px";
  img.onload = () => URL.revokeObjectURL(img.src);
  prev.append(img, document.createTextNode(t("{n} 帧", { n: spriteFiles.length })));
  const base = spriteFiles[0].name.replace(/\.png$/i, "").replace(/_\d+$/, "");
  $<HTMLInputElement>("sd-sprite").value = base;
  $<HTMLInputElement>("sd-object").value = base.replace(/^s_/, "o_");
}

async function submitSpriteImport() {
  const sprite = $<HTMLInputElement>("sd-sprite").value.trim();
  const object = $<HTMLInputElement>("sd-object").value.trim();
  if (!spriteFiles.length) { await alertDialog(t("先选 PNG 文件")); return; }
  if (!sprite || !object) { await alertDialog(t("sprite 名和对象名都要填")); return; }
  const frames = await Promise.all(spriteFiles.map(async (f) => {
    const u8 = new Uint8Array(await f.arrayBuffer());
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return { data: btoa(s) };
  }));
  const ox = Number($<HTMLInputElement>("sd-ox").value), oy = Number($<HTMLInputElement>("sd-oy").value);
  const body: Record<string, unknown> = {
    sprite, object, frames, by: BY,
    parent: $<HTMLInputElement>("sd-parent").value.trim() || undefined,
    visible: $<HTMLInputElement>("sd-visible").checked,
    note: $<HTMLInputElement>("sd-note").value.trim() || undefined,
  };
  if (ox !== 0 || oy !== 0) body.origin = [ox, oy]; // MSL's packer default is already (0,0)
  try {
    const r = await fetch("/api/mod-assets/import-sprite", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { await alertDialog(t("导入失败：{err}", { err: j.error ?? r.status })); return; } // dialog stays open, nothing lost
    $<HTMLDialogElement>("sprite-dialog").close();
    toast(t("已导入 {obj}（{n} 帧）", { obj: object, n: frames.length }));
    await db.reloadModAssets();
    // land the artist on their new card in the library
    $<HTMLInputElement>("palette-q").value = object;
    renderPalette();
  } catch (e) {
    await alertDialog(t("导入失败：{err}", { err: (e as Error).message }));
  }
}

function toolCursor() {
  if (spaceHeld || tool.kind === "hand") return "grab";
  if (tool.kind !== "select") return "crosshair";
  return "";
}

function setTool(nt: Tool) {
  if (readOnly() && nt.kind !== "select" && nt.kind !== "hand") { toastReadOnly(); return; } // view-only: no edit tools
  tool = nt;
  if (nt.kind === "place") lastPlaced = nt.object;
  if (nt.kind === "zone") zoneObject = nt.object;
  if (nt.kind === "marker") markerObject = nt.object;
  ghostLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  const names = { select: "选择", hand: "抓手", note: "便签", place: "放置", collision: "碰撞矩形", barrier: "屏障涂刷", zone: "区域", marker: "标记" } as const;
  $("s-tool").textContent =
    nt.kind === "place" ? t("放置 {obj}（单击放置，Esc 结束）", { obj: nt.object })
    : nt.kind === "hand" ? t("抓手（拖动平移）")
    : nt.kind === "note" ? t("便签（单击留便签）")
    : nt.kind === "collision" ? t("碰撞矩形（拖出矩形 · Esc 结束）")
    : nt.kind === "barrier" ? t("屏障涂刷（拖动刷格 · Alt+拖动擦除 · Esc 结束）")
    : nt.kind === "zone" ? t("区域 {obj}（拖出矩形，Esc 结束）", { obj: nt.object })
    : nt.kind === "marker" ? t("标记 {obj}（单击放置，Esc 结束）", { obj: nt.object })
    : t("选择");
  $("opt-tool").textContent = t(names[nt.kind]) + (nt.kind === "place" ? t("：{obj}", { obj: nt.object }) : "");
  $("stage").style.cursor = toolCursor();
  document.querySelectorAll<HTMLButtonElement>("#toolbox button[data-tool]").forEach((b) => {
    const on = b.dataset.tool === nt.kind;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLElement>("#palette-list li[data-o]").forEach((el) => {
    el.classList.toggle("on", nt.kind === "place" && el.dataset.o === nt.object);
  });
  if (nt.kind === "place" || nt.kind === "marker") buildGhost(nt.object);
  renderToolExtras();
  drawOverlay();
  pushMenuState();
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
  const v = (spr && (await spriteView(db, spr, 0))) || markerView(objName(object) || object.replace(/^o_/, ""));
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
    void alertDialog(t("请先在「层组」页签中选择一个实例图层"));
    return;
  }
  const verb = tool.kind === "marker" ? t("标记") : t("放置");
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
    hint(`${COLLISION_PAINT} · ${t("拖出矩形")} · ${t("放入 {layer} 层", { layer: layerNameOf(layerFor(COLLISION_PAINT)) })}`);
    return;
  }
  if (tool.kind === "barrier") {
    hint(`${BARRIER_PAINT} · ${t("拖动涂刷，Alt+拖动擦除")} · ${t("放入 {layer} 层", { layer: layerNameOf(layerFor(BARRIER_PAINT)) })}`);
    return;
  }
  if (tool.kind === "zone") {
    const cur0 = tool.object; // const: `tool` is a mutable module var, closures un-narrow it
    const sel = document.createElement("select");
    sel.title = t("选择要绘制的对象：具有纯色盒 sprite 的功能对象（与尺寸手柄同一套像素判据）");
    sel.innerHTML = `<option>${esc(cur0)}</option>`;
    sel.disabled = true;
    box.appendChild(sel);
    hint(`${t("拖出矩形")} · ${t("放入 {layer} 层", { layer: layerNameOf(layerFor(cur0)) })}`);
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
    sel.title = t("选择要放置的标记：出生点、灯光、区域标记等功能对象");
    sel.innerHTML = names.map((n) => `<option ${n === cur0 ? "selected" : ""}>${esc(n)}</option>`).join("");
    sel.onchange = () => setTool({ kind: "marker", object: sel.value });
    box.appendChild(sel);
    hint(`${t("单击放置")} · ${t("放入 {layer} 层", { layer: layerNameOf(layerFor(cur0)) })}`);
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
  const label = object === COLLISION_PAINT ? t("碰撞矩形 {w}×{h}", { w: R - L, h: B - T }) : t("区域 {obj} {w}×{h}", { obj: object, w: R - L, h: B - T });
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
    if (!hits.length) { $("s-hover").textContent = t("此处没有可擦除的{what}格", { what }); drawOverlay(); return; }
    commit(t("擦除{what} {n} 格", { what, n: hits.length }), hits.map((i) => ({ op: "delete", id: i.instance_id, expect: { object_definition: i.object_definition, x: i.x, y: i.y } })));
    return;
  }
  const taken = new Set(stamps.map((i) => `${Math.floor(i.x / CELL)},${Math.floor(i.y / CELL)}`));
  const layer = layerNameOf(layerFor(object));
  const ops: Op[] = [];
  for (let cx = cx0; cx <= cx1; cx++)
    for (let cy = cy0; cy <= cy1; cy++)
      if (!taken.has(`${cx},${cy}`)) ops.push({ op: "add", layer, inst: { object_definition: object, x: cx * CELL, y: cy * CELL } as RoomInstance });
  if (!ops.length) { $("s-hover").textContent = t("所选格子已存在{what}", { what }); drawOverlay(); return; }
  commit(t("涂刷{what} {n} 格", { what, n: ops.length }), ops);
}

// ================= viewport & pointer =================

function redrawZoomDependent() {
  if (!scene || !doc) return;
  // render mode keeps the fixed dark canvas chrome so CLI screenshots never
  // depend on the operator's UI theme
  const tc = renderMode ? THEME_CANVAS.dark : THEME_CANVAS[uiTheme()];
  if (toggles.grid.checked) drawGrid(scene.gridLayer, room(), zoom, true, tc.gridLine, tc.gridMajor);
  drawBounds(scene.boundsLayer, room(), zoom, tc.bounds);
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

// the room as a dark sheet with a soft shadow over the neutral pasteboard;
// the sheet follows the UI theme, the shadow stays (a page lifts off any colour)
function drawArtboard() {
  artboard.clear();
  if (renderMode || !doc) return;
  artboard.rect(3 / zoom, 4 / zoom, room().width, room().height).fill({ color: 0x000000, alpha: 0.35 });
  artboard.rect(0, 0, room().width, room().height).fill(THEME_CANVAS[uiTheme()].sheet);
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
  const tc = THEME_CANVAS[uiTheme()];
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
    ctx.strokeStyle = isMajor ? tc.rulerMajor : tc.rulerMinor;
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(p, RULER); ctx.lineTo(p, RULER - t); }
    else { ctx.moveTo(RULER, p); ctx.lineTo(RULER - t, p); }
    ctx.stroke();
    if (isMajor) {
      ctx.fillStyle = tc.rulerText;
      if (horizontal) ctx.fillText(String(v), p + 3, 10);
      else { ctx.save(); ctx.translate(9, p - 2); ctx.rotate(-Math.PI / 2); ctx.fillText(String(v), 0, 0); ctx.restore(); }
    }
  }
  const cur = horizontal ? rulerCursor?.x : rulerCursor?.y;
  if (cur !== undefined && cur >= 0 && cur <= len) {
    const q = Math.round(cur) + 0.5;
    ctx.strokeStyle = tc.rulerCursor;
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
    if (selection.size === 1 && !readOnly()) {
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
      if (!readOnly()) {
        const orig = instsOf(selection).map((a) => ({ id: a.inst.instance_id, x: a.inst.x, y: a.inst.y, tx: a.inst.x, ty: a.inst.y }));
        drag = { mode: "move", sx, sy, ids: orig.map((o) => o.id), orig, moved: false };
      }
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
    $("s-cell").textContent = t("格 {cx}, {cy}", { cx: Math.floor(cursorWorld.x / CELL), cy: Math.floor(cursorWorld.y / CELL) });
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
      $("s-hover").textContent = `${t("调整尺寸 {w}×{h}", { w: Math.round(v.w), h: Math.round(v.h) })}${snapOn() ? t("（已吸附整格，按住 Alt 自由调整）") : ""}`;
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
        ? `${t("移动 → {x}, {y}", { x: f.tx, y: f.ty })}${on ? t("（吸附格点，Alt 自由）") : ""}`
        : `${t("移动 {n} 个实例", { n: d.orig.length })}${on ? t("（各自吸附格点）") : ""}`;
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
        const what = d.object === COLLISION_PAINT ? t("碰撞矩形") : t("区域 {obj}", { obj: d.object });
        $("s-hover").textContent = `${what} ${r.R - r.L}×${r.B - r.T} → ${layerNameOf(layerFor(d.object))}`;
      } else if (d.mode === "paint") {
        const c = paintCells(d);
        const what = paintLabel(d.object);
        $("s-hover").textContent = `${altHeld ? t("擦除") : t("涂刷")}${what} ${c.cx1 - c.cx0 + 1}×${c.cy1 - c.cy0 + 1} ${t("格")}${altHeld ? "" : t("（按住 Alt 擦除）")}`;
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
      commit(t("调整 {name} 尺寸", { name: n?.inst.object_definition ?? d.id }), [{
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
        const what = d.orig.length === 1 ? String(findInstance(room(), d.orig[0].id)?.inst.object_definition ?? "") : t("{n} 个实例", { n: d.orig.length });
        commit(t("移动 {what}", { what }), ops).then((ok) => { if (!ok) refreshScene(); });
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
  if (selection.size === 1 && tool.kind === "select" && !readOnly()) {
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
  if (!doc || renderMode || readOnly()) return; // a vanilla room has no doc to hold a selection
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
    // Ctrl+K opens the object palette, and doubles as the first half of the VS Code
    // chord for 打开项目 (Ctrl+K Ctrl+O). Both live before the inField/doc guards: they
    // are chrome-level, so they work from a search box and from the welcome page.
    if (ctrl && k === "k") {
      e.preventDefault();
      chordArmed = performance.now();
      if (uiMode === "ready") openPalette();
      return;
    }
    if (ctrl && k === "o" && performance.now() - chordArmed < 2000) {
      e.preventDefault();
      chordArmed = 0;
      $<HTMLDialogElement>("palette-dialog").close(); // Ctrl+K already opened it
      void openProjectDialog("打开项目");
      return;
    }
    // the bottom panel toggles from anywhere, like the other chrome-level chords: it is
    // about the project as a whole, not about the room the focus happens to be in
    if (ctrl && e.shiftKey && k === "m") { e.preventDefault(); bpToggle(); return; }
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
        commit(t("删除 {n} 个实例", { n: ops.length }), ops).then((ok) => { if (ok) selection.clear(); });
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
      commit(t("微调"), ops);
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
  $("s-hover").textContent = t("已复制 {n} 个实例", { n: clipboard.length });
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
  commit(t("粘贴"), ops).then((ok) => {
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
  commit(t("复制"), ops).then((ok) => {
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
    body.innerHTML = `<span class="muted">${t("单击画布中的实例，查看并编辑它的属性。<br>拖动空白处可以框选多个；「图层」页签里拖动行可调整遮挡顺序。")}</span>`;
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
    return `<label>${t(f.label)}</label><input data-k="${f.key}" data-kind="${f.kind}" class="${mixed ? "mixed" : ""}" value="${mixed ? "" : esc(fmt(f.kind, first[f.key]))}" placeholder="${mixed ? t("（多个值）") : ""}" spellcheck="false" />`;
  }).join("");
  const layerOpts = room().layers
    .map((L, i) => (L.layer_type === LayerType.Instances ? `<option value="${i}" ${sameLayer && layerIdx[0] === i ? "selected" : ""}>${esc(L.layer_name)}</option>` : ""))
    .join("");

  const objDef = first.object_definition ?? "";
const head = insts.length === 1
    ? `<div class="insp-title" title="${esc(objDef)}">${esc(objName(objDef) || objDef)} <span class="h-meta">#${first.instance_id}</span></div>`
    : `<div class="insp-title">${t("{n} 个实例", { n: insts.length })}${same("object_definition") ? " · " + esc(objName(objDef) || objDef) : ""}</div>`;

  let facts = "";
  if (insts.length === 1 && n) {
    const obj = first.object_definition ?? "";
    const chain = db.parentChain(obj);
    const flags: string[] = [];
    if (n.customDraw) flags.push(`<span class="flag">${t("自定义 Draw：编辑器按默认绘制")}</span>`);
    if (n.kind === "hidden") flags.push(`<span class="flag info">${t("游戏内不可见")}</span>`);
    if (n.kind === "collision") flags.push(`<span class="flag info">${paintLabel(obj)} ${first.scale_x}×${first.scale_y} ${t("格")}</span>`);
    if (!db.objects[obj]) flags.push(`<span class="flag">${t("原版和 assets.json 里都没有这个对象：AddRoomJson 会静默丢弃这个实例")}</span>`);
    else if (db.modObjects.has(obj)) flags.push(`<span class="flag info">${t("mod 对象（assets.json 注册，生成 C# 先于 AddRoomJson）")}</span>`);
    facts = `<div class="insp-section kv">
        <div class="k">sprite</div><div class="v">${esc(db.objects[obj]?.sprite ?? "—")}</div>
        <div class="k">${t("格")}</div><div class="v">${Math.floor(first.x / CELL)}, ${Math.floor(first.y / CELL)}</div>
        <div class="k">depth</div><div class="v">${n.depth}</div>
        <div class="k">  ${t("来源")}</div><div class="v">${esc(n.depthWhy)}</div>
        <div class="k">${t("可见")}</div><div class="v">${esc(n.visibleWhy)}</div>
        <div class="k">instance_id</div><div class="v">${first.instance_id}${t("（MSL 导入时重编号）")}</div>
      </div>
      <div class="chain">${t("父链：")}${chain.length ? esc(chain.join(" → ")) : t("（无）")}</div>
      <div>${flags.join("")}</div>`;
  }

  body.innerHTML = `${head}
    <div class="form">
      <label>${t("图层")}</label><select data-layer>${sameLayer ? "" : '<option selected disabled>' + t("（多个图层）") + '</option>'}${layerOpts}</select>
      ${inputs}
    </div>
    ${facts}`;

  if (readOnly()) body.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-k], select[data-layer]").forEach((el) => { el.disabled = true; });

  body.querySelectorAll<HTMLInputElement>("input[data-k]").forEach((inp) => {
    const commitField = () => {
      const key = inp.dataset.k as keyof RoomInstance;
      const kind = inp.dataset.kind as FieldKind;
      if (inp.classList.contains("mixed") && inp.value === "") return;
      const p = parseField(kind, inp.value);
      if (!p.ok) { inp.style.borderColor = "var(--bad)"; return; }
      if (insts.every((i) => i[key] === p.v)) return;
      const ops: Op[] = insts.map((i) => ({ op: "set", id: i.instance_id, set: { [key]: p.v } as any, expect: { [key]: i[key] } as any }));
      commit(t("修改 {key}", { key }), ops);
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
    commit(t("换图层 → {layer}", { layer: layerName }), ops);
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
      .map((r: any) => `<option value="${esc(r.name)}">${esc(r.name)} · ${r.w}×${r.h} · ${r.instances} ${t("实例")}</option>`)
      .join("");
  };
  q.oninput = fill;
  await fill();
  dlg.showModal();
  $("nd-ok").onclick = async (e) => {
    e.preventDefault();
    const name = nameInp.value.trim();
    if (!/^r_[A-Za-z0-9_]+$/.test(name)) { await alertDialog(t("房间名格式不正确，应形如 r_sv_something")); return; }
    if (!baseSel.value) { await alertDialog(t("请选择一个原版房间作为基底")); return; }
    try {
      await api("/api/create", "POST", { name, base: baseSel.value, keep: $<HTMLSelectElement>("nd-keep").value, by: BY });
    } catch (err) {
      await alertDialog(t("创建失败：{err}", { err: (err as Error).message }));
      return;
    }
    dlg.close();
    await refreshRooms(name);
    await openRoom(name);
  };
}

// ================= vanilla read-only picker =================

// The dropdown's 原版（只读）group leads here: search the cache, open the pick with
// ?vanilla=1. Nothing is created; the room renders from cache/assets/rooms/<name>.json.
function wireVanillaDialog() {
  const dlg = $("vanilla-dialog") as HTMLDialogElement;
  const q = $<HTMLInputElement>("vd-q");
  const list = $<HTMLSelectElement>("vd-list");
  let t = 0;
  q.oninput = () => { clearTimeout(t); t = window.setTimeout(fillVanillaList, 80); };
  q.onkeydown = (e) => {
    if (e.key === "Enter") { e.preventDefault(); const first = list.querySelector("option"); if (first) openVanillaFromPicker(first.value); }
    if (e.key === "Escape") { e.preventDefault(); dlg.close(); }
  };
  list.ondblclick = () => { if (list.value) openVanillaFromPicker(list.value); };
  $("vd-ok").onclick = (e) => { e.preventDefault(); if (list.value) openVanillaFromPicker(list.value); };
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // backdrop click
}

async function fillVanillaList() {
  const q = $<HTMLInputElement>("vd-q");
  const list = $<HTMLSelectElement>("vd-list");
  const found = await api(`/api/vanilla?q=${encodeURIComponent(q.value)}`);
  list.innerHTML = found
    .map((r: any) => `<option value="${esc(r.name)}">${esc(r.name)} · ${r.w}×${r.h} · ${r.instances} ${t("实例")}</option>`)
    .join("");
  // a list box (size>1) does NOT auto-select the first option on fill -- value stays ""
  // and 打开 silently does nothing. Pin the selection so Enter/双击/按钮 all have a target.
  if (list.options.length) list.selectedIndex = 0;
}

async function openVanillaPicker() {
  await fillVanillaList();
  const dlg = $("vanilla-dialog") as HTMLDialogElement;
  if (!dlg.open) dlg.showModal();
  const q = $<HTMLInputElement>("vd-q");
  q.focus();
  q.select();
}

function openVanillaFromPicker(name: string) {
  ($("vanilla-dialog") as HTMLDialogElement).close();
  void openRoom(name, { vanilla: true });
}

// ================= electron host (native menus) =================
// Electron's preload exposes window.svreHost; plain browsers skip all of this.
// Every menu item is one action id dispatched to the same functions the buttons and
// keys already call -- the native menu is a third input device, never a parallel path.
interface SvreHost {
  isElectron: boolean;
  onMenu(cb: (id: string) => void): void;
  pushState(s: {
    theme: UiTheme; zmode: ZMode; tool: Tool["kind"]; toggles: Record<string, boolean>;
    mode: UiMode; project: ProjectInfo | null; recent: Pick<RecentEntry, "path" | "name" | "exists">[];
    lang: Lang;
  }): void;
  // show a folder in Explorer/Finder (the welcome page's recent rows)
  revealPath?(path: string): Promise<void>;
  // custom titlebar: pop the native menu at the given page coords
  popupMenu?(x: number, y: number): void;
  // ...and run the window controls; the shell answers with svre:win-state
  winControl?(action: "min" | "max" | "close"): void;
  onWinState?(cb: (s: { maximized: boolean }) => void): void;
  // native folder/file pickers; absent in plain browsers (the text inputs suffice there)
  pickDir?(title?: string): Promise<string | null>;
  pickFile?(): Promise<string | null>;
}
const hostBridge = (window as any).svreHost as SvreHost | undefined;
// Menu actions act on a loaded document; init() flips this when the app is actually up.
// The chrome is wired long before that (see bootChrome), so a click can land mid-boot.
let booted = false;

// The window chrome, and it goes up the instant this module runs -- NOT at the end of
// init(). The shell hides the OS caption (titleBarStyle:"hidden"), so this bar is the
// only drag region and the only min/max/close the window has: it must not sit behind
// asset loading, a 503 backend or a pixi failure. Whatever init() does, the user can
// still move, maximise and close the window.
function bootChrome() {
  if (!hostBridge) return;
  document.body.classList.add("electron"); // hides the controls that moved into menus
  hostBridge.onMenu((id) => menuAction(id));
  // custom titlebar's ☰ pops the same native menu at the button's bottom-left corner
  const tb = $("tb-menu");
  tb.addEventListener("click", () => {
    const r = tb.getBoundingClientRect();
    hostBridge.popupMenu?.(Math.round(r.left), Math.round(r.bottom));
  });
  // window controls; the max button icon/tooltip mirrors the shell's state pushes
  $("tb-min").addEventListener("click", () => hostBridge.winControl?.("min"));
  const tbMax = $("tb-max");
  tbMax.addEventListener("click", () => hostBridge.winControl?.("max"));
  $("tb-close").addEventListener("click", () => hostBridge.winControl?.("close"));
  hostBridge.onWinState?.((s) => {
    tbMax.classList.toggle("maxed", !!s.maximized);
    tbMax.title = s.maximized ? t("还原") : t("最大化");
  });
  // the page keeps document.title at "<room> — Stoneshard Room Editor"; mirror it
  const tbTitle = document.querySelector<HTMLElement>("#titlebar .tb-title");
  const titleEl = document.querySelector("title");
  if (tbTitle && titleEl) {
    const syncTitle = () => { tbTitle.textContent = document.title; };
    new MutationObserver(syncTitle).observe(titleEl, { childList: true });
    syncTitle();
  }
  pushMenuState(); // seat the native menu's checkmarks before the data even starts loading
}

// bootChrome() runs here, at module scope: before init(), before any await, and before
// anything that can throw. Do not move it into init() -- that is the bug this fixes.
bootChrome();

// Recent entries travel as one string (the renderer only gets a single channel per menu
// item) and a path contains both ':' and '\', so the separator has to be a character no
// path can hold.
const RECENT_MENU_PREFIX = "project.openRecent\u0000";

function menuAction(id: string): boolean {
  // Project management and the machine setup are CHROME-level: they must work with no
  // document at all, which is exactly the state the welcome page is in. So they are
  // handled before the booted/ready gate, not after it.
  if (id.startsWith(RECENT_MENU_PREFIX)) { void openProject(id.slice(RECENT_MENU_PREFIX.length)); return true; }
  // Language is chrome-level too: it must work on the welcome page, where the editor-only
  // re-renders below do not exist. A reload re-localizes everything -- the browser dropdown
  // re-paints in place, but the native menu has no page context to reuse, so reload is the
  // uniform, always-safe path (?lang= is read by api() at call time).
  if (id.startsWith("lang.set.")) {
    const code = id.slice("lang.set.".length) as Lang;
    if (code !== "zh" && code !== "en" && code !== "ru") return false;
    setLang(code);
    location.reload();
    return true;
  }
  switch (id) {
    case "project.new": void openProjectDialog("新建项目"); return true;
    case "project.open": void openProjectDialog("打开项目"); return true;
    case "project.close": void closeProject(); return true;
    case "help.setup": void openMachineSetup(); return true;
  }
  if (!booted || uiMode !== "ready") {
    // booted flips at different points per mode: welcome sets it as soon as the page is
    // up (there is no data to wait for), the editor only after the room is on screen.
    toast(t(booted ? "先打开一个项目" : "正在启动，请稍候…"));
    return false;
  }
  const stage = $("stage");
  if (id.startsWith("view.toggle.")) {
    const key = id.slice("view.toggle.".length) as keyof typeof toggles;
    if (!(key in toggles)) return false;
    toggles[key].checked = !toggles[key].checked;
    applyVisibility();
    return true;
  }
  if (id.startsWith("tool.")) {
    pickTool(id.slice(5) as Tool["kind"]);
    return true;
  }
  switch (id) {
    case "view.panel.problems": bpShow("problems"); return true;
    case "view.panel.log": bpShow("log"); return true;
    case "view.panel.toggle": bpToggle(); return true;
    case "file.new": openNewDialog(); return true;
    case "file.vanilla": openVanillaPicker(); return true;
    case "file.importSprite": openSpriteImport(); return true;
    case "file.compile": void compileDoc(); return true;
    case "edit.undo": void undoRedo("undo"); return true;
    case "edit.redo": void undoRedo("redo"); return true;
    case "edit.find": {
      showTab("insts");
      const q = $<HTMLInputElement>("insts-q");
      const panel = q.closest(".dock-panel");
      if (panel?.classList.contains("collapsed")) panel.querySelector<HTMLElement>("[data-collapse]")?.click();
      q.focus();
      q.select();
      return true;
    }
    case "view.theme.light": setUiTheme("light"); return true;
    case "view.theme.dark": setUiTheme("dark"); return true;
    case "view.zmode.game": setZMode("game"); return true;
    case "view.zmode.static": setZMode("static"); return true;
    case "view.zoomIn": zoomStep(1); return true;
    case "view.zoomOut": zoomStep(-1); return true;
    case "view.fit": fit(); return true;
    case "view.one": zoomAt(1, stage.clientWidth / 2, stage.clientHeight / 2); return true;
  }
  return false;
}

// the native menu's checkmarks/radios are only honest when rebuilt on every change
// (it also carries the project state: the shell builds 最近打开 from it rather than
// keeping a copy of its own, which is what went stale before)
function pushMenuState() {
  hostBridge?.pushState({
    theme: uiTheme(),
    zmode: zMode,
    tool: tool.kind,
    toggles: Object.fromEntries(Object.entries(toggles).map(([k, el]) => [k, el.checked])),
    mode: uiMode,
    project: projectInfo,
    recent: recentList.map((r) => ({ path: r.path, name: r.name, exists: r.exists })),
    lang: getLang(),
  });
}

// ================= first-run setup wizard =================
// The asset cache is never distributed (copyright): every install extracts it from
// the user's own Stoneshard data file. A degraded backend says so via /api/setup;
// this wizard walks workdir -> data file -> extract -> version check, then reloads
// into the healthy backend. In-page UI only (Electron never answers native renderer
// dialogs -- they would wedge the page).
interface SetupState {
  // the three-state model (see UiMode): the server decides, this side only branches
  mode: UiMode;
  reasons: string[]; // MACHINE-level gaps only: config | cache | create
  project: ProjectInfo | null;
  forced: boolean; // a re-run the user asked for (game update): nothing is missing, still show
  running: boolean;
  current: { modDir: string; assetsDir: string; vanillaWin: string; sourceDir: string };
  sourceGml: number; // gml_Object_*.gml files in current.sourceDir (0 = not a source tree)
  detected: { path: string; kind: "vallina" | "data"; source: string }[];
  utmtCli: string | null;
  // the UTMT CLI the extract runs on: where it is, where a download would go, and what
  // would be downloaded (an install with no vendor/utmt/ has nothing to extract with)
  utmt: {
    cli: string | null;
    dir: string;
    installed: boolean; // our own download is there (vs. one from the config or the bundle)
    version: string | null;
    running: boolean;
    release: { version: string; url: string; bytes: number };
  };
  expected: { game: string; objects: number; sprites: number; rooms: number; create: number } | null;
}

const setupLog: string[] = [];

// step 3 and 4 share the run panel (log + phase + done/retry), so which job owns it has
// to survive outside runSetupIfNeeded: the events that finish a job arrive later, on the
// store channel
// no "moddir" step any more: choosing a folder is 打开项目, not a step in a linear wizard
type SetupStep = "win" | "create" | "run";
type SetupJob = "extract" | "create";
let setupRunJob: SetupJob = "extract";

// The UTMT CLI panel (step 2): the export cannot run without the CLI and a clone without
// vendor/utmt/ has none, so the wizard offers to fetch the pinned release. It is not one of
// the two long jobs above -- no run panel, no setupRunJob -- just a status line and a button.
let setupUtmt: SetupState["utmt"] | null = null;

// the full state, as the server reports it
function renderSetupUtmt(st: SetupState["utmt"], status?: string) {
  setupUtmt = st;
  paintSetupUtmt(status);
}

// a live event (the download's own progress): patched onto the state the panel was built from
function patchSetupUtmt(patch: Partial<SetupState["utmt"]>, status?: string) {
  if (!setupUtmt) return; // the wizard is not on the step that shows it
  setupUtmt = { ...setupUtmt, ...patch };
  paintSetupUtmt(status);
}

function paintSetupUtmt(status?: string) {
  const st = setupUtmt;
  const box = $("setup-utmt");
  if (!st) return;
  box.textContent = "";
  const row = document.createElement("div");
  row.className = "setup-row";
  const info = document.createElement("div");
  // a missing CLI is a real blocker (unlike a version difference), so it reads as one
  info.className = (!st.cli && !st.running) || status?.startsWith("✗") ? "warn" : "muted";
  info.textContent =
    status ??
    (st.running
      ? t("正在下载…")
      : st.cli
        ? t("✓ 提取工具：{cli}", { cli: st.cli })
        : t("还没找到 UndertaleModCli.exe：提取需要它（下载后会自动装到下面的目录）"));
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "setup-utmt-get";
  btn.disabled = st.running;
  btn.textContent = st.cli ? t("重新下载安装…") : t("下载并安装（约 {mb} MB）", { mb: Math.round(st.release.bytes / 1048576) });
  btn.onclick = () => void downloadUtmt();
  row.append(info, btn);
  box.append(row);
  // when there is no CLI at all, name the source: it is 60 MB from github.com, and a user
  // behind a wall needs to know what to fetch by hand (or which mirror to set SVRE_UTMT_URL to)
  const hint = document.createElement("div");
  hint.className = "muted";
  hint.textContent = st.cli
    ? st.version
      ? t("已安装 v{ver} · {dir}", { ver: st.version, dir: st.dir })
      : ""
    : t("来源：UTMT v{ver} {url}", { ver: st.release.version, url: st.release.url });
  if (hint.textContent) box.append(hint);
}

async function downloadUtmt() {
  patchSetupUtmt({ running: true }, t("正在连接…"));
  try {
    await api("/api/setup/utmt", "POST", {});
  } catch (e) {
    patchSetupUtmt({ running: false }, t("✗ 无法开始下载：{err}", { err: (e as ApiError).message }));
  }
}

// the download reports on its own events (job "utmt"); the run panel belongs to the other jobs
function onUtmtEvent(e: SetupEvent) {
  if (!setupUtmt) return; // the wizard is not on the step that shows it
  if (e.phase === "done") {
    void (api("/api/setup") as Promise<SetupState>)
      .then((s) => renderSetupUtmt(s.utmt, t("✓ UTMT CLI v{ver} 已就绪", { ver: s.utmt.version ?? "" })))
      .catch(() => {});
    return;
  }
  const failed = e.phase === "error";
  patchSetupUtmt(
    { running: !failed },
    failed ? t("✗ 下载失败：{detail}", { detail: e.detail ?? t("未知原因") }) : e.phase === "unpack" ? t("解压并安装…") : t("下载中…{status}", { status: e.status ? ` ${e.status}` : "" }),
  );
}

function showSetupStep(k: SetupStep) {
  const steps: Record<SetupStep, string> = { win: "setup-step-win", create: "setup-step-create", run: "setup-step-run" };
  for (const [name, id] of Object.entries(steps)) $(id).hidden = name !== k;
}

// the run panel is shared by the two long steps; it says which one it is doing
function startSetupRun(job: SetupJob) {
  setupRunJob = job;
  // The extract writes straight into the live cache (no staging dir), so from here on
  // nothing may touch the editor: the dialog goes modal-blocking and stays that way until
  // the page reloads into the rebuilt cache. (Another tab of the same server can still
  // edit its rooms -- harmless -- but it may draw half-written texture pages until it
  // reloads; the damage is cosmetic and gone after any reload.)
  setupBlocking = true;
  $("setup-close").hidden = true;
  setupLog.length = 0;
  $("setup-log").textContent = "";
  $("setup-result").innerHTML = "";
  $("setup-run-title").textContent = job === "extract" ? t("2 · 提取资产缓存") : t("3 · 扫描反编译源码");
  $("setup-phase").textContent = job === "extract" ? t("正在启动 UTMT CLI…") : t("正在扫描反编译源码…");
  $("setup-retry").hidden = true;
  $("setup-done").hidden = true;
  showSetupStep("run");
}

// The MACHINE-level wizard: game data file -> extract -> depth facts. There is no workdir
// step any more -- choosing a folder is what 打开项目 does, and it is not a step in a
// linear wizard. `blocking` is what the server's `reasons` say: a missing cache blocks
// everything, so the dialog refuses to close; a healthy machine's by-hand visit does not.
let setupBlocking = true;

// Esc must not dismiss a blocking wizard: the asset cache is missing or half-written, and
// there is no editor behind the dialog to fall back to. (`setupBlocking` is decided in
// showSetupDialog; this listener is unconditional because the flag has to be readable at
// cancel time, not at attach time.)
$("setup-dialog").addEventListener("cancel", (e) => { if (setupBlocking) e.preventDefault(); });

async function showSetupDialog(st: SetupState) {
  const dlg = $<HTMLDialogElement>("setup-dialog");
  setupBlocking = st.reasons.length > 0;
  if (!st.project) uiMode = "welcome";
  // only while the dialog really blocks: a dismissible one may have a live editor behind it,
  // and stomping that editor's status line would be a lie
  if (setupBlocking) $("load-state").textContent = t("等待本机设置…");
  // The success exit reloads (the backend just became healthy and every cache in this tab
  // predates it). The by-hand visit on a healthy machine can also simply be dismissed.
  const done = $<HTMLButtonElement>("setup-done");
  done.textContent = projectInfo ? t("进入编辑器") : t("完成");
  done.onclick = () => hardReset();
  $<HTMLButtonElement>("setup-close").hidden = setupBlocking;

  // ---- step 1: the game data file ----
  $("setup-expected").textContent = st.expected
    ? t("{game}（{rooms} 房间 / {objects} 对象 / {sprites} sprite）", { game: st.expected.game, rooms: st.expected.rooms, objects: st.expected.objects, sprites: st.expected.sprites })
    : t("未知（缺 extract/fingerprint.json）");
  const winInput = $<HTMLInputElement>("setup-win");
  winInput.value = st.current.vanillaWin ?? "";
  const det = $("setup-detected");
  det.innerHTML = "";
  if (!st.detected.length) det.innerHTML = `<div class="muted">${t("没有自动检测到 Stoneshard 安装，请手动选择或填写路径。")}</div>`;
  for (const c of st.detected) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "setup-detect";
    b.innerHTML = `<b>${c.kind === "vallina" ? t("原版备份") : t("游戏数据")}</b><span>${esc(c.path)}</span>`;
    if (winInput.value === c.path) b.classList.add("sel");
    b.onclick = () => {
      winInput.value = c.path;
      det.querySelectorAll(".setup-detect.sel").forEach((el) => el.classList.remove("sel"));
      b.classList.add("sel");
    };
    det.appendChild(b);
  }
  const winPick = $<HTMLButtonElement>("setup-win-pick");
  winPick.hidden = !hostBridge?.pickFile;
  winPick.onclick = async () => {
    const p = await hostBridge!.pickFile!();
    if (p) winInput.value = p;
  };
  renderSetupUtmt(st.utmt); // step 2 shows which CLI the extract would use, and offers one
  $<HTMLButtonElement>("setup-extract").onclick = async () => {
    const win = winInput.value.trim();
    if (!win) return alertDialog(t("先选择或填写数据文件路径"));
    startSetupRun("extract");
    try {
      await api("/api/setup/extract", "POST", { vanillaWin: win });
    } catch (e) {
      onSetupEvent({ phase: "error", detail: (e as ApiError).message, job: "extract" });
    }
  };

  // ---- step 3: the decompiled source tree (create.json -- the facts data.win lacks) ----
  const srcInput = $<HTMLInputElement>("setup-source");
  srcInput.value = st.current.sourceDir ?? "";
  const srcHint = $("setup-source-hint");
  const srcHintText = (n: number, dir: string) =>
    n
      ? t("✓ 找到 {n} 个 gml_Object_*.gml", { n })
      : dir
        ? t("这个目录里没有 gml_Object_*.gml——UTMT 的「Decompile all code」导出的是整个源码目录")
        : t("还没有配置过源码目录：UTMT「Decompile all code」导出一份，填这里（可先跳过；之后从菜单「帮助 → 本机设置…」重来）");
  srcHint.textContent = srcHintText(st.sourceGml, st.current.sourceDir);
  const srcPick = $<HTMLButtonElement>("setup-source-pick");
  srcPick.hidden = !hostBridge?.pickDir;
  srcPick.onclick = async () => {
    const p = await hostBridge!.pickDir!();
    if (p) {
      srcInput.value = p;
      srcHint.textContent = t("选择后由后端校验…");
    }
  };
  $<HTMLButtonElement>("setup-create-run").onclick = async () => {
    const src = srcInput.value.trim();
    if (!src) return alertDialog(t("先选择或填写反编译源码目录"));
    startSetupRun("create");
    try {
      await api("/api/setup/create", "POST", { sourceDir: src });
    } catch (e) {
      onSetupEvent({ phase: "error", detail: (e as ApiError).message, job: "create" });
    }
  };
  // the escape hatch: no source tree on this machine. The editor still works -- the canvas
  // falls back to layer depth -- so this must not be a dead end for the user
  $<HTMLButtonElement>("setup-create-skip").onclick = async () => {
    if (!(await confirmDialog(t("跳过深度事实扫描？\n\n对象自己写在 Create 里的 depth 代码（如 depth = -y + 18）读不到，画布会按图层深度排，遮挡顺序可能与游戏内不一致（编辑器会持续提示）。\n\n之后随时可以用 UTMT 导出源码重来：菜单「帮助 → 本机设置…」。")))) return;
    try {
      await api("/api/setup/create", "POST", { skip: true });
    } catch (e) {
      return alertDialog((e as ApiError).message);
    }
    hardReset(); // healthy now, with the caveat banner
  };

  // ---- progress panel (shared by the two long steps; events arrive on the store channel) ----
  $<HTMLButtonElement>("setup-retry").onclick = () => showSetupStep(setupRunJob === "extract" ? "win" : "create");
  const close = $<HTMLButtonElement>("setup-close");
  close.textContent = t("关闭");
  close.onclick = () => dlg.close();

  if (st.running) {
    setupRunJob = st.reasons.includes("create") && !st.reasons.includes("cache") ? "create" : "extract";
    showSetupStep("run");
  }
  // A re-run the user asked for, or a missing cache: the data file is what a game update
  // changes, so that is where a round starts.
  else if (st.forced || st.reasons.includes("cache")) showSetupStep("win");
  else if (st.reasons.includes("create")) showSetupStep("create");
  // nothing is actually missing: this is a by-hand visit (菜单 帮助 → 本机设置…) on a
  // healthy machine, and the data file is still the thing that goes stale
  else showSetupStep("win");
  dlg.showModal();
  if (!setupBlocking) return; // dismissible: the caller keeps going (or is the welcome page)
  // Blocking: only the done button leaves, and it reloads into a healthy backend
  await new Promise<void>(() => {});
}

interface SetupEvent {
  phase?: string;
  line?: string;
  status?: string;
  detail?: string;
  mismatches?: string[];
  count?: number;
  job?: SetupJob | "utmt";
}

function onSetupEvent(e: SetupEvent) {
  const dlg = $<HTMLDialogElement>("setup-dialog");
  if (!dlg.open) return;
  if (e.job === "utmt") return onUtmtEvent(e); // its own panel; the run panel is not involved
  if (e.job) setupRunJob = e.job; // a run started elsewhere (another tab) owns the panel now
  if (e.line) {
    setupLog.push(e.line);
    if (setupLog.length > 400) setupLog.splice(0, setupLog.length - 400);
    const log = $("setup-log");
    log.textContent = setupLog.join("\n");
    log.scrollTop = log.scrollHeight;
  }
  const phases: Record<string, string> = {
    assets: "第 1/2 步：导出对象 / sprite / 贴图页…",
    rooms: "第 2/2 步：导出全部房间…",
    create: "扫描反编译源码，重建深度事实…",
    check: "校验版本指纹…",
  };
  if (e.phase && phases[e.phase]) $("setup-phase").textContent = t(phases[e.phase]);
  if (e.phase === "done") {
    $("setup-phase").textContent = t("完成");
    const scan = setupRunJob === "create";
    // the pinned fingerprint belongs to whoever builds the editor: a different game version
    // is expected (Stoneshard gets updated), so the comparison is stated as a fact about the
    // reference, never as a warning about the user's copy
    const done = `${scan ? t("深度事实扫描完成（{n} 条）", { n: e.count ?? 0 }) : t("提取完成")}`;
    $("setup-result").innerHTML = e.mismatches?.length
      ? `<div class="ok">✓ ${done}。</div><div class="info">${t("与开发侧参考版本的统计不同（仅提示，不影响使用）：")}<br>${e.mismatches.map(esc).join("<br>")}<br>${
          scan
            ? t("源码树与参考版本不同时，深度事实按这份源码算——游戏更新后重新导出源码即可。")
            : t("游戏更新后房间基底按这份 data 文件算——下面继续按同一份数据走。")
        }</div>`
      : `<div class="ok">✓ ${done}，${t("与开发侧参考版本的统计一致。")}</div>`;
    if (!scan) {
      // the cache is built in two passes: with the export done, the source scan is what is
      // still owed -- go straight there rather than offering "enter the editor" on a
      // half-built cache (which would boot into the fallback the user never chose)
      void (api("/api/setup") as Promise<SetupState>).then((s) => {
        if (s.reasons.includes("create")) {
          $<HTMLInputElement>("setup-source").value = s.current.sourceDir ?? "";
          $("setup-source-hint").textContent = s.sourceGml
            ? t("✓ 找到 {n} 个 gml_Object_*.gml", { n: s.sourceGml })
            : t("这个目录里没有 gml_Object_*.gml——UTMT「Decompile all code」导出的是整个源码目录");
          setupRunJob = "create";
          showSetupStep("create");
        } else $("setup-done").hidden = false;
      }).catch(() => { $("setup-done").hidden = false; });
      return;
    }
    $("setup-done").hidden = false;
  }
  if (e.phase === "error") {
    $("setup-phase").textContent = t("失败");
    $("setup-result").innerHTML = `<div class="warn">${t(setupRunJob === "create" ? "✗ 扫描失败：{detail}" : "✗ 提取失败：{detail}", { detail: esc(e.detail ?? t("未知错误")) })}</div>`;
    $("setup-retry").hidden = false;
  }
}

// ================= websocket =================

function wireWs() {
  const hot = (import.meta as any).hot;
  if (hot) {
    hot.on("svre:event", (e: any) => void onStoreEvent(e));
    pushLog({ at: new Date().toISOString(), kind: "local", text: t("已连接，开始记录服务端事件"), n: 1 });
  } else {
    // no vite channel outside the dev server (electron prod): the standalone
    // backend emits the same events over SSE
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      try { void onStoreEvent(JSON.parse(m.data)); } catch { /* malformed event: ignore */ }
    };
    // A dropped stream used to be completely silent -- the page just stopped hearing
    // about other editors. The log is the one place that can say so.
    es.onopen = () => pushLog({ at: new Date().toISOString(), kind: "local", text: t("已连接，开始记录服务端事件"), n: 1 });
    es.onerror = () => pushLog({ at: new Date().toISOString(), kind: "local", text: t("与服务端的连接中断，正在重连…"), n: 1 });
  }
}

async function onStoreEvent(e: any) {
  recordLog(e); // before the early-returns below: most events are dropped, not acted on
  // Anything that can change the project's shape or a room's contents invalidates the
  // diagnostics. Not `selection` (a cursor moving is not a problem) and not `setup`
  // (machine-level, and it is what the setup dialog is watching).
  if (e?.type !== "selection" && e?.type !== "setup") refreshDiagnostics();
  // The project axis comes FIRST: every check below assumes the document we hold still
  // belongs to the project on the server, which is exactly what this event invalidates.
  if (e?.type === "project") {
    if (switching) return; // we asked for this switch; our own hardReset is already on its way
    if (e.mode !== "welcome") toast(t("项目已在另一处切换，正在重新加载…"));
    hardReset();
    return;
  }
  if (e?.type === "setup") { onSetupEvent(e); return; }
  if (e?.type === "created") { await refreshRooms(); return; }
  if (e?.type === "assets") {
    if (e.by === BY) return; // our own import already refreshed in submitSpriteImport
    await db.reloadModAssets();
    if ($<HTMLDialogElement>("palette-dialog").open) renderPalette();
    toast(`${whoText(e.by)}${t("导入了 {obj}，对象库已刷新", { obj: e.object ?? "mod sprite" })}`);
    return;
  }
  if (!doc || e?.room !== doc.name || doc.vanilla) return; // vanilla views track no project events
  switch (e.type) {
    case "change":
      if (e.entry?.by === BY) break; // our own commit already replayed it
      toast(t("{who}：{label}（r{rev}）", { who: whoText(e.entry?.by), label: e.entry?.label ?? t("修改了房间"), rev: e.entry?.rev }));
      await syncDoc();
      break;
    case "undo":
      if (e.by === BY) break;
      toast(t("{who} 撤销了 r{rev}", { who: whoText(e.by), rev: e.undone }));
      await syncDoc();
      break;
    case "compiled":
      doc.compiledRev = e.rev;
      doc.dirty = false;
      updateChrome();
      break;
    case "notes":
      if (e.by === BY) break;
      toast(t("{who} 修改了便签", { who: whoText(e.by) }));
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
      toast(t("工程文件在磁盘上发生变化（git 操作或其他服务），已重新加载"));
      await syncDoc();
      break;
  }
}

const whoText = (by?: string) => (by === BY ? t("你") : by ? `${by}` : t("有人"));

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
  menu(id: string) { return menuAction(id); },
  get electron() { return !!hostBridge; },
  // the project axis, for the e2e that drives welcome/switch/close
  get mode() { return uiMode; },
  get project() { return projectInfo ? { ...projectInfo } : null; },
  get recent() { return recentList.map((r) => ({ ...r })); },
  openProject(path: string, force = false) { return openProject(path, force); },
  closeProject() { return closeProject(); },
  refreshProjects() { return refreshProjects(); },
  get readOnly() { return readOnly(); },
  get theme() { return uiTheme(); },
  get canvasColors() { return { ...THEME_CANVAS[uiTheme()] }; },
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
  $("load-state").textContent = t("出错：{err}", { err: e.message });
});
