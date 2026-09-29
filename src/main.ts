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
import { buildScene, drawBounds, drawGrid, markerView, spriteView, type InstanceNode, type RoomScene } from "./render";
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
type Tool = { kind: "select" } | { kind: "hand" } | { kind: "note" } | { kind: "place"; object: string };
let tool: Tool = { kind: "select" };
let lastPlaced: string | null = null; // the P key re-arms the last palette pick
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
const snapDelta = (d: number) => (snapOn() ? Math.round(d / CELL) * CELL : Math.round(d));
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
  wireToolbox();
  wireTabs();
  wireDock();
  wirePalette();
  wireViewport(host);
  wireKeys(host);
  wireWs();

  const initial = params.get("room");
  if (renderMode) {
    // svre render: bare canvas, overlays from the URL, ready flag for the screenshotter
    for (const k of ["grid", "collision", "hidden", "markers", "notes"] as const)
      toggles[k].checked = params.get(k) === "1";
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
      const marks = `${r.hasProject ? "" : " · 未导入"}${r.dirty ? " ●" : ""}${r.drift ? " ⚠漂移" : ""}`;
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
    if (opts.silent || !confirm(`${name} 还没有工程。从 Codes/${name}.gml 导入（基底自动推断）？`)) {
      $<HTMLSelectElement>("room-select").value = doc?.name ?? "";
      return;
    }
    try {
      const r = await api("/api/import", "POST", { name, by: BY });
      toast(`已导入 ${name}：基底 ${r.base}，${r.ops} 个操作`);
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
      toast(`冲突：${e.message} — 已刷新到最新状态`);
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
    toast(`已编译 ${r.file}（rev ${r.rev}） → ${r.roomsCs}${lintFindings.length ? ` · ⚠ ${lintFindings.length} 条规则提示` : ""}`);
    await syncDoc();
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (Array.isArray(e.detail)) {
        alert(`日志在基底上重放不通过，先修这些问题：\n\n${(e.detail as ReplayProblem[]).map((p) => `rev ${p.rev}: ${p.message}`).join("\n")}`);
      } else if (confirm(`${e.message}\n\n确定 = 采纳磁盘上的外部改动（记成一条 external 日志）\n取消 = 不动`)) {
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
    toast(r.ops ? `已采纳外部改动：${r.ops} 个操作记入日志` : "磁盘文件与当前状态一致");
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
  const next = await buildScene(db, room());
  if (scene) {
    world.removeChild(scene.root);
    scene.root.destroy({ children: true });
  }
  scene = next;
  resizeGate.clear(); // gates are per instance; classification re-asks the sprite cache
  world.addChild(scene.root);
  world.addChild(ghostLayer); // keep the ghost on top
  nodeById = new Map(scene.nodes.map((n) => [n.inst.instance_id, n]));
  if (hovered !== null && !nodeById.has(hovered)) hovered = null;
  applyVisibility();
  renderLayerList();
  renderHistory();
  drawNotes();
  inspect();
  postSelection();
}

function applyVisibility() {
  if (!scene || !doc) return;
  for (const n of scene.nodes) {
    let on = !layerOff.has(n.layerIndex);
    if (n.kind === "hidden") on &&= toggles.hidden.checked;
    if (n.kind === "collision") on &&= toggles.collision.checked;
    if (n.kind === "marker") on &&= toggles.markers.checked;
    n.view.visible = on;
    if (n.kind === "hidden") n.view.alpha = 0.45;
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
    `${esc(room().name)} · rev ${doc.rev}${doc.compiledRev !== null ? ` → 编译于 ${doc.compiledRev}` : " · 从未编译"}` +
    ` · ${room().width}×${room().height} · 可见 ${counts.drawn ?? 0} · 隐形 ${counts.hidden ?? 0} · 碰撞 ${counts.collision ?? 0} · 标记 ${counts.marker ?? 0}` +
    (lintFindings.length ? ` · <span style="color:var(--warn)" title="${esc(lintFindings.map((f) => f.message).join("\n"))}">⚠ ${lintFindings.length} 条规则提示</span>` : "");

  // badge = entries arrived since the history tab was last open
  const unseen = doc.log.filter((e) => e.rev > lastSeenRev).length;
  $("history-badge").textContent = unseen ? String(unseen) : "";

  // banner: drift and a changed base are the two states that need a decision
  const entry = rooms.find((r) => r.name === doc!.name);
  const banner = $("banner");
  let html = "";
  if (doc.drift)
    html = `⚠ 磁盘上的 rooms/${esc(doc.name)}.compiled.json 在上次编译后被外部改过（生成器？手工？）。编译前要么采纳它，要么强制覆盖。<button data-act="adopt">采纳外部改动</button>`;
  else if (doc.baseChanged)
    html = `⚠ 基底房间变了（游戏更新？）。日志仍照常重放${doc.problems.length ? `，但有 ${doc.problems.length} 个操作对不上` : ""}。`;
  else if (doc.problems.length)
    html = `⚠ ${doc.problems.length} 个日志条目在基底上重放失败，编译会被拒绝。`;
  else if (entry?.generatedBy.length)
    html = `这个房间曾被 ${esc(entry.generatedBy.join("、"))} 生成。工程已接管内容——别再跑生成器，它会盖掉编译产物。`;
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
      return `<li data-i="${i}" class="${cls}" title="${inst ? "单击设为当前图层（新对象放这里）" : "非实例图层，只读"}">
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

// ---------------- toolbox & dock ----------------

function wireToolbox() {
  document.querySelectorAll<HTMLButtonElement>("#toolbox button[data-tool]").forEach((b) => {
    b.onclick = () => pickTool(b.dataset.tool as Tool["kind"]);
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
  $("tab-layers").hidden = tab !== "layers";
  $("tab-palette").hidden = tab !== "palette";
  $("tab-history").hidden = tab !== "history";
  if (tab === "palette") $<HTMLInputElement>("palette-q").focus();
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
      return `<li data-rev="${e.rev}" class="${e.undoOf !== undefined ? "undo" : ""}" title="点击高亮这次改动碰到的实例">
        <div class="h-top">${whoBadge(e.by)}<span class="h-label">${esc(e.label || "(未命名)")}</span><span class="h-meta">r${e.rev} · ${time}</span></div>
        <div class="h-meta">${e.ops} 个操作${e.ids.length ? ` · id ${e.ids.slice(0, 8).join(",")}${e.ids.length > 8 ? "…" : ""}` : ""}</div>
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
  const text = prompt(`便签 @ ${Math.round(wx)},${Math.round(wy)}（人类和 agent 都会看到）`, "");
  if (!text?.trim()) return;
  await api(`/api/doc/${doc.name}/notes`, "POST", { by: BY, x: Math.round(wx), y: Math.round(wy), text: text.trim() });
  doc = await api(`/api/doc/${doc.name}`);
  renderHistory();
  drawNotes();
}

// ---------------- palette & placement ----------------

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
    if (e.key === "Escape") { q.blur(); setTool({ kind: "select" }); }
  };
  renderPalette();
}

function renderPalette() {
  const names = searchObjects(db, $<HTMLInputElement>("palette-q").value, family);
  const list = $("palette-list");
  list.innerHTML = names
    .map((n) => {
      const d = db.objects[n];
      const chain = db.parentChain(n).slice(0, 3).join(" → ");
      const on = tool.kind === "place" && tool.object === n ? "on" : "";
      return `<li data-o="${esc(n)}" class="${on}">${thumbHtml(db, n)}<div style="min-width:0"><div class="pname">${esc(n)}</div><div class="pmeta">${esc(d.sprite ?? "无 sprite")}${chain ? " · " + esc(chain) : ""}</div></div></li>`;
    })
    .join("") || `<li class="muted" style="padding:10px">没有匹配的对象</li>`;
  list.querySelectorAll<HTMLElement>("li[data-o]").forEach((li) => {
    li.onclick = () => setTool({ kind: "place", object: li.dataset.o! });
  });
}

function toolCursor() {
  if (spaceHeld || tool.kind === "hand") return "grab";
  if (tool.kind === "place" || tool.kind === "note") return "crosshair";
  return "";
}

function setTool(t: Tool) {
  tool = t;
  if (t.kind === "place") lastPlaced = t.object;
  ghostLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  $("s-tool").textContent =
    t.kind === "place" ? `放置 ${t.object}（单击放置，Esc 结束）`
    : t.kind === "hand" ? "抓手（拖动平移）"
    : t.kind === "note" ? "便签（单击留便签）"
    : "选择";
  $("opt-tool").textContent = t.kind === "place" ? `放置：${t.object}` : { select: "选择", hand: "抓手", note: "便签" }[t.kind];
  $("stage").style.cursor = toolCursor();
  document.querySelectorAll<HTMLButtonElement>("#toolbox button[data-tool]").forEach((b) => {
    const on = b.dataset.tool === t.kind;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  document.querySelectorAll<HTMLElement>("#palette-list li[data-o]").forEach((li) => {
    li.classList.toggle("on", t.kind === "place" && li.dataset.o === t.object);
  });
  if (t.kind === "place") buildGhost(t.object);
  requestRender();
}

// toolbox buttons and V/H/P/N land here; P without a pick yet just opens the palette
function pickTool(kind: Tool["kind"]) {
  if (kind === "place") {
    if (!lastPlaced) { showTab("palette"); return; }
    setTool({ kind: "place", object: lastPlaced });
  } else setTool({ kind });
}

async function buildGhost(object: string) {
  const spr = db.objects[object]?.sprite;
  const v = (spr && (await spriteView(db, spr, 0))) || markerView(object.replace(/^o_/, ""));
  if (tool.kind !== "place" || tool.object !== object) return; // tool changed meanwhile
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
  if (!doc || tool.kind !== "place") return;
  const L = room().layers[activeLayer];
  if (L?.layer_type !== LayerType.Instances) {
    alert("先在图层面板里选一个实例图层");
    return;
  }
  const object = tool.object;
  commit(`放置 ${object}`, [{ op: "add", layer: L.layer_name!, inst: { object_definition: object, x: snapPoint(wx), y: snapPoint(wy) } as RoomInstance }]).then(
    (ok) => {
      if (!ok || !doc) return;
      // select what we just placed (the id came back in the logged ops)
      selection.clear();
      for (const id of doc.log[doc.log.length - 1]?.ids ?? []) selection.add(id);
      inspect();
      drawOverlay();
    },
  );
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
  | { mode: "move"; sx: number; sy: number; ids: number[]; orig: { id: number; x: number; y: number }[]; dx: number; dy: number; moved: boolean }
  | { mode: "resize"; sx: number; sy: number; id: number; handle: string; lb: { x: number; y: number; w: number; h: number }; box: { x: number; y: number; w: number; h: number }; unit: number; orig: { x: number; y: number; scale_x: number; scale_y: number }; moved: boolean }
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

// fixed edges come from the box at drag start; the moving edge follows the pointer
// (snapped). New scale keeps the sprite's sign; x/y shift so the fixed edges stay put.
function resizeCompute(d: Extract<Drag, { mode: "resize" }>, wx: number, wy: number) {
  const snapE = (v: number) => (snapOn() ? Math.round(v / d.unit) * d.unit : Math.round(v));
  let L = d.box.x, T = d.box.y, R = L + d.box.w, B = T + d.box.h;
  if (d.handle.includes("e")) R = Math.max(L + d.unit, snapE(wx));
  if (d.handle.includes("w")) L = Math.min(R - d.unit, snapE(wx));
  if (d.handle.includes("s")) B = Math.max(T + d.unit, snapE(wy));
  if (d.handle.includes("n")) T = Math.min(B - d.unit, snapE(wy));
  const gx = Math.sign(d.orig.scale_x) || 1, gy = Math.sign(d.orig.scale_y) || 1;
  const scale_x = (gx * (R - L)) / d.lb.w, scale_y = (gy * (B - T)) / d.lb.h;
  // origins can sit off-cell (oCameraStatic is centred), which leaves x/y fractional
  // when an edge is pinned to the grid -- the room format stores integers
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
    if (tool.kind === "place") {
      const w = toWorld(sx, sy);
      placeAt(w.x, w.y);
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
            unit: lb.width % CELL === 0 && lb.height % CELL === 0 ? CELL : 1,
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
      inspect();
      const orig = instsOf(selection).map((a) => ({ id: a.inst.instance_id, x: a.inst.x, y: a.inst.y }));
      drag = { mode: "move", sx, sy, ids: orig.map((o) => o.id), orig, dx: 0, dy: 0, moved: false };
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
    if (tool.kind === "place") moveGhost();

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
      $("s-hover").textContent = `调整尺寸 ${Math.round(v.w)}×${Math.round(v.h)}${snapOn() ? `（吸附 ${d.unit}px，Alt 自由）` : ""}`;
      drawOverlay();
      return;
    }
    if (drag?.mode === "move") {
      const d = drag;
      const rdx = (sx - d.sx) / zoom, rdy = (sy - d.sy) / zoom;
      if (!d.moved && Math.abs(sx - d.sx) + Math.abs(sy - d.sy) < 4) return;
      d.moved = true;
      d.dx = snapDelta(rdx);
      d.dy = snapDelta(rdy);
      // live preview: move the views, not the data (the ops are sent on release)
      for (const o of d.orig) {
        const n = nodeById.get(o.id);
        if (n) n.view.position.set(o.x + d.dx, o.y + d.dy);
      }
      $("s-hover").textContent = `移动 Δ${d.dx}, ${d.dy}${snapOn() ? "（吸附 26px，按住 Alt 自由）" : ""}`;
      drawOverlay();
      return;
    }
    if (drag?.mode === "marquee") {
      drag.ex = sx; drag.ey = sy;
      if (Math.abs(sx - drag.sx) + Math.abs(sy - drag.sy) > 3) drag.moved = true;
      drawOverlay();
      return;
    }
    const h = tool.kind === "hand" ? null : pick(sx, sy);
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
    } else if (d.mode === "move" && d.moved && (d.dx || d.dy)) {
      const ops: Op[] = d.orig.map((o) => ({
        op: "set",
        id: o.id,
        set: { x: o.x + d.dx, y: o.y + d.dy },
        expect: { x: o.x, y: o.y },
      }));
      const what = d.orig.length === 1 ? String(findInstance(room(), d.orig[0].id)?.inst.object_definition ?? "") : `${d.orig.length} 个实例`;
      commit(`移动 ${what}`, ops).then((ok) => { if (!ok) refreshScene(); });
    } else if (d.mode === "move" && d.moved) {
      refreshScene(); // snapped back to zero: restore the previewed views
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
      if (!best || n.view.zIndex > best.view.zIndex) best = n;
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
    if (ctrl && k === "k") { e.preventDefault(); showTab("palette"); return; }
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
  if (!doc || at.length === 0) {
    body.innerHTML = `<span class="muted">点选一个实例；Shift 加选，空白处拖动框选。<br><br>工具：V 选择 · H 抓手 · P 放置 · N 便签。<br>从「对象」页签挑一个对象即可放置；右键单击留便签。</span>`;
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
    if (n.kind === "collision") flags.push(`<span class="flag info">碰撞戳 ${first.scale_x}×${first.scale_y} 格</span>`);
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
    if (!/^r_[A-Za-z0-9_]+$/.test(name)) { alert("房间名形如 r_sv_something"); return; }
    if (!baseSel.value) { alert("选一个原版房间做基底"); return; }
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
        toast(`${whoText(e.entry?.by)}：${e.entry?.label ?? "改了房间"}（r${e.entry?.rev}）`);
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
        toast(`${whoText(e.by)} 改了便签`);
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
        toast("工程文件在磁盘上变了（git？另一个服务？），已重新加载");
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
  gateOf(id: number) { return resizeGate.get(id) ?? null; },
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
