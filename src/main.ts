import "./style.css";
import { Application, Container, Graphics } from "pixi.js";
import { AssetDb } from "./assets";
import { CELL, LayerType, type RoomInstance } from "./room";
import { buildScene, drawBounds, drawGrid, markerView, spriteView, type InstanceNode, type RoomScene } from "./render";
import { RoomDoc, addCmd, cloneInstance, deleteCmd, moveCmd, newInstance, patchCmd, relayerCmd, type InstPatch } from "./doc";
import { FAMILIES, searchObjects, thumbHtml, type Family } from "./palette";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

const db = new AssetDb();
const app = new Application();
const world = new Container(); // pan/zoom lives here
const ghostLayer = new Container(); // placement preview, in world space
const overlay = new Graphics(); // screen-space outlines and marquee

interface RoomEntry { file: string; bytes: number; generatedBy: string[] }

let rooms: RoomEntry[] = [];
let file = "";
let doc: RoomDoc | null = null;
let scene: RoomScene | null = null;
let nodeOf = new Map<RoomInstance, InstanceNode>();
let zoom = 1;
let hovered: InstanceNode | null = null;
const selection = new Set<RoomInstance>();
let activeLayer = -1;
const layerOff = new Set<number>();
let tool: { kind: "select" } | { kind: "place"; object: string } = { kind: "select" };
let clipboard: { layerName: string | null; inst: RoomInstance }[] = [];
let cursorWorld = { x: 0, y: 0 };
let spaceHeld = false;
let altHeld = false;
let family: Family = FAMILIES[0];

const toggles = {
  snap: $<HTMLInputElement>("t-snap"),
  hidden: $<HTMLInputElement>("t-hidden"),
  collision: $<HTMLInputElement>("t-collision"),
  markers: $<HTMLInputElement>("t-markers"),
  grid: $<HTMLInputElement>("t-grid"),
};

const room = () => doc!.room;
const snapOn = () => toggles.snap.checked && !altHeld;
const snapDelta = (d: number) => (snapOn() ? Math.round(d / CELL) * CELL : Math.round(d));
const snapPoint = (v: number) => (snapOn() ? Math.floor(v / CELL) * CELL : Math.round(v));

// ================= boot =================

async function init() {
  const host = $("stage");
  await app.init({ resizeTo: host, background: 0x0d0e11, antialias: false, roundPixels: true, autoDensity: true, resolution: devicePixelRatio });
  host.appendChild(app.canvas);
  ghostLayer.alpha = 0.65;
  app.stage.addChild(world, overlay);

  $("load-state").textContent = "加载资产…";
  await db.load();

  rooms = await fetch("/api/rooms").then((r) => r.json());
  const sel = $<HTMLSelectElement>("room-select");
  sel.innerHTML = rooms.map((r) => `<option value="${esc(r.file)}">${esc(r.file.replace(/\.gml$/, ""))}</option>`).join("");
  sel.onchange = async () => {
    if (!(await confirmDiscard())) { sel.value = file; return; }
    await openRoom(sel.value);
  };

  for (const t of Object.values(toggles)) t.onchange = applyVisibility;
  $("b-fit").onclick = fit;
  $("b-1x").onclick = () => zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
  $("b-save").onclick = save;
  $("b-undo").onclick = () => doc?.undo();
  $("b-redo").onclick = () => doc?.redo();
  wireTabs();
  wirePalette();
  wireViewport(host);
  wireKeys(host);
  window.addEventListener("beforeunload", (e) => { if (doc?.dirty) e.preventDefault(); });

  const initial = new URLSearchParams(location.search).get("room") ?? rooms[0]?.file;
  if (initial) {
    sel.value = initial;
    await openRoom(initial);
  }
}

async function confirmDiscard(): Promise<boolean> {
  return !doc?.dirty || confirm("当前房间有未保存的修改，确定放弃？");
}

async function openRoom(f: string) {
  $("load-state").textContent = `打开 ${f}…`;
  const res = await fetch(`/api/room/${encodeURIComponent(f)}`);
  const text = await res.text();
  file = f;
  doc = new RoomDoc(text, res.headers.get("X-Svre-Hash") ?? "");
  doc.onChange = () => { refreshScene().then(updateChrome); };
  selection.clear();
  hovered = null;
  layerOff.clear();
  activeLayer = guessActiveLayer();
  setTool({ kind: "select" });
  await refreshScene();
  fit();
  updateChrome();
  history.replaceState(null, "", `?room=${encodeURIComponent(f)}`);

  const gen = rooms.find((r) => r.file === f)?.generatedBy ?? [];
  const banner = $("banner");
  banner.hidden = gen.length === 0;
  banner.textContent = gen.length
    ? `⚠ 这个文件由 ${gen.join("、")} 生成。重新运行生成器会覆盖在这里保存的修改——要么把改动搬进生成器，要么从此改由编辑器维护、别再跑生成器。`
    : "";
}

// the layer new things go to: the one holding most visible drawn instances, else the first instance layer
function guessActiveLayer(): number {
  const r = room();
  const prefer = ["ForegroundInstances", "Entity", "StuffInstances", "Instances"];
  for (const n of prefer) {
    const i = r.layers.findIndex((L) => L.layer_name === n && L.layer_type === LayerType.Instances);
    if (i >= 0) return i;
  }
  return r.layers.findIndex((L) => L.layer_type === LayerType.Instances);
}

// ================= scene =================

async function refreshScene() {
  if (!doc) return;
  const next = await buildScene(db, room());
  if (scene) {
    world.removeChild(scene.root);
    scene.root.destroy({ children: true });
  }
  scene = next;
  world.addChild(scene.root);
  world.addChild(ghostLayer); // keep the ghost on top
  nodeOf = new Map(scene.nodes.map((n) => [n.inst, n]));
  // drop selected instances that no longer exist (deleted / undone add)
  for (const i of [...selection]) if (!nodeOf.has(i)) selection.delete(i);
  if (hovered && !nodeOf.has(hovered.inst)) hovered = null;
  else if (hovered) hovered = nodeOf.get(hovered.inst)!;
  applyVisibility();
  renderLayerList();
  inspect();
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
  redrawZoomDependent();
}

function updateChrome() {
  if (!doc) return;
  const dirty = doc.dirty;
  $<HTMLButtonElement>("b-save").disabled = !dirty;
  $<HTMLButtonElement>("b-save").classList.toggle("primary", dirty);
  $<HTMLButtonElement>("b-undo").disabled = !doc.canUndo;
  $<HTMLButtonElement>("b-redo").disabled = !doc.canRedo;
  $("b-undo").title = doc.canUndo ? `撤销：${doc.undoLabel} (Ctrl+Z)` : "撤销 (Ctrl+Z)";
  $("b-redo").title = doc.canRedo ? `重做：${doc.redoLabel} (Ctrl+Y)` : "重做 (Ctrl+Y)";
  document.title = `${dirty ? "● " : ""}${room().name} — SV Room Editor`;
  const counts = scene!.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  $("load-state").innerHTML = `${esc(room().name)} · ${room().width}×${room().height} · 可见 ${counts.drawn ?? 0} · 隐形 ${counts.hidden ?? 0} · 碰撞 ${counts.collision ?? 0} · 标记 ${counts.marker ?? 0}${dirty ? '<span class="dirty-dot">● 未保存</span>' : ""}`;
}

async function save() {
  if (!doc || !doc.dirty) return;
  const body = doc.serialize();
  const res = await fetch(`/api/room/${encodeURIComponent(file)}`, { method: "PUT", headers: { "X-Svre-Base": doc.baseHash }, body });
  if (res.status === 409) {
    const reload = confirm("磁盘上的文件在你打开之后被改过了（另一个会话，或者生成器又跑了一次），这次没有保存。\n\n确定 = 放弃编辑器里的修改，重新加载磁盘版本\n取消 = 留在编辑器里，什么都不写");
    if (reload) { doc.markSaved(doc.baseHash); await openRoom(file); }
    return;
  }
  if (!res.ok) { alert(`保存失败：${await res.text()}`); return; }
  const { hash } = await res.json();
  doc.markSaved(hash);
  updateChrome();
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
        <span class="eye" data-eye="${i}" title="显示/隐藏">${layerOff.has(i) ? "◌" : "●"}</span>
        <span class="name">${esc(L.layer_name)}${L.is_visible ? "" : ' <span class="tag">游戏内隐藏</span>'}</span>
        <span class="meta">${typeName[L.layer_type] ?? L.layer_type} ${n} · d${L.layer_depth}</span></li>`;
    })
    .join("");
  list.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", (e) => {
      const i = Number((li as HTMLElement).dataset.i);
      if ((e.target as HTMLElement).dataset.eye !== undefined) {
        layerOff.has(i) ? layerOff.delete(i) : layerOff.add(i);
        applyVisibility();
      } else if (room().layers[i].layer_type === LayerType.Instances) {
        activeLayer = i;
      }
      renderLayerList();
    });
  });
}

function wireTabs() {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    b.onclick = () => showTab(b.dataset.tab!);
  });
}
function showTab(tab: string) {
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((x) => x.classList.toggle("on", x.dataset.tab === tab));
  $("tab-layers").hidden = tab !== "layers";
  $("tab-palette").hidden = tab !== "palette";
  if (tab === "palette") $<HTMLInputElement>("palette-q").focus();
}

// ================= palette & placement =================

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

function setTool(t: typeof tool) {
  tool = t;
  ghostLayer.removeChildren().forEach((c) => c.destroy({ children: true }));
  $("s-tool").textContent = t.kind === "place" ? `放置 ${t.object}（单击放置，Esc 结束）` : "选择";
  $("stage").style.cursor = t.kind === "place" ? "crosshair" : "";
  document.querySelectorAll<HTMLElement>("#palette-list li[data-o]").forEach((li) => {
    li.classList.toggle("on", t.kind === "place" && li.dataset.o === t.object);
  });
  if (t.kind === "place") buildGhost(t.object);
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
}

function placeAt(wx: number, wy: number) {
  if (!doc || tool.kind !== "place") return;
  if (room().layers[activeLayer]?.layer_type !== LayerType.Instances) {
    alert("先在图层面板里选一个实例图层");
    return;
  }
  const inst = newInstance(doc, tool.object, snapPoint(wx), snapPoint(wy));
  doc.run(addCmd([{ layer: activeLayer, inst }], `放置 ${tool.object}`));
  selection.clear();
  selection.add(inst);
}

// ================= viewport & pointer =================

function redrawZoomDependent() {
  if (!scene || !doc) return;
  if (toggles.grid.checked) drawGrid(scene.gridLayer, room(), zoom);
  drawBounds(scene.boundsLayer, room(), zoom);
  drawOverlay();
  $("s-zoom").textContent = `${Math.round(zoom * 100)}%`;
}

function zoomAt(z: number, sx: number, sy: number) {
  z = Math.min(16, Math.max(0.1, z));
  const wx = (sx - world.x) / zoom, wy = (sy - world.y) / zoom;
  zoom = z;
  world.scale.set(zoom);
  world.position.set(Math.round(sx - wx * zoom), Math.round(sy - wy * zoom));
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

type Drag =
  | { mode: "pan"; sx: number; sy: number; wx: number; wy: number }
  | { mode: "move"; sx: number; sy: number; insts: RoomInstance[]; orig: { x: number; y: number }[]; dx: number; dy: number; moved: boolean }
  | { mode: "marquee"; sx: number; sy: number; ex: number; ey: number; additive: boolean; moved: boolean };
let drag: Drag | null = null;

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
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceHeld)) {
      drag = { mode: "pan", sx: e.clientX, sy: e.clientY, wx: world.x, wy: world.y };
      host.classList.add("panning");
      return;
    }
    if (e.button !== 0 || !doc) return;
    if (tool.kind === "place") {
      const w = toWorld(sx, sy);
      placeAt(w.x, w.y);
      return;
    }
    const hit = pick(sx, sy);
    if (hit) {
      if (e.shiftKey || e.ctrlKey) {
        selection.has(hit.inst) ? selection.delete(hit.inst) : selection.add(hit.inst);
        inspect();
        drawOverlay();
        return;
      }
      if (!selection.has(hit.inst)) { selection.clear(); selection.add(hit.inst); }
      activeLayer = hit.layerIndex;
      renderLayerList();
      inspect();
      const insts = [...selection];
      drag = { mode: "move", sx, sy, insts, orig: insts.map((i) => ({ x: i.x, y: i.y })), dx: 0, dy: 0, moved: false };
    } else {
      drag = { mode: "marquee", sx, sy, ex: sx, ey: sy, additive: e.shiftKey || e.ctrlKey, moved: false };
    }
    drawOverlay();
  });

  host.addEventListener("pointermove", (e) => {
    const { sx, sy } = local(e);
    altHeld = e.altKey;
    cursorWorld = toWorld(sx, sy);
    $("s-pos").textContent = `x ${Math.floor(cursorWorld.x)}  y ${Math.floor(cursorWorld.y)}`;
    $("s-cell").textContent = `格 ${Math.floor(cursorWorld.x / CELL)}, ${Math.floor(cursorWorld.y / CELL)}`;
    if (tool.kind === "place") moveGhost();

    if (drag?.mode === "pan") {
      world.position.set(drag.wx + e.clientX - drag.sx, drag.wy + e.clientY - drag.sy);
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
      // live preview: move the views, not the data (the command does that on release)
      d.insts.forEach((inst, k) => {
        const n = nodeOf.get(inst);
        if (n) n.view.position.set(d.orig[k].x + d.dx, d.orig[k].y + d.dy);
      });
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
    const h = pick(sx, sy);
    if (h !== hovered) {
      hovered = h;
      $("s-hover").textContent = h ? `${h.inst.object_definition}  @${h.inst.x},${h.inst.y}  depth ${h.depth}  [${h.layer.layer_name}]` : "—";
      drawOverlay();
    }
  });

  host.addEventListener("pointerup", () => {
    host.classList.remove("panning");
    const d = drag;
    drag = null;
    if (!d || !doc) return;
    if (d.mode === "move" && d.moved && (d.dx || d.dy)) {
      doc.run(moveCmd(d.insts, d.dx, d.dy));
    } else if (d.mode === "move" && d.moved) {
      refreshScene(); // snapped back to zero: restore the previewed views
    } else if (d.mode === "marquee") {
      if (!d.additive) selection.clear();
      if (d.moved) {
        const x0 = Math.min(d.sx, d.ex), x1 = Math.max(d.sx, d.ex), y0 = Math.min(d.sy, d.ey), y1 = Math.max(d.sy, d.ey);
        for (const n of scene!.nodes) {
          if (!n.view.visible) continue;
          const b = n.view.getBounds();
          if (b.x < x1 && b.x + b.width > x0 && b.y < y1 && b.y + b.height > y0) selection.add(n.inst);
        }
      }
      inspect();
      drawOverlay();
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

function drawOverlay() {
  overlay.clear();
  const box = (n: InstanceNode, color: number, w: number) => {
    if (!n.view.visible) return;
    const b = n.view.getBounds();
    overlay.rect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.width), Math.round(b.height)).stroke({ color, width: w });
  };
  if (hovered && !selection.has(hovered.inst)) box(hovered, 0xffffff, 1);
  for (const inst of selection) {
    const n = nodeOf.get(inst);
    if (n) box(n, 0x6cb6ff, 2);
  }
  if (drag?.mode === "marquee" && drag.moved) {
    const x = Math.min(drag.sx, drag.ex), y = Math.min(drag.sy, drag.ey);
    overlay.rect(x, y, Math.abs(drag.ex - drag.sx), Math.abs(drag.ey - drag.sy))
      .fill({ color: 0x6cb6ff, alpha: 0.08 }).stroke({ color: 0x6cb6ff, width: 1 });
  }
}

// ================= keyboard =================

function wireKeys(host: HTMLElement) {
  window.addEventListener("keyup", (e) => {
    if (e.key === " ") { spaceHeld = false; host.style.cursor = tool.kind === "place" ? "crosshair" : ""; }
    if (e.key === "Alt") { altHeld = false; moveGhost(); }
  });
  window.addEventListener("keydown", (e) => {
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();

    if (ctrl && k === "s") { e.preventDefault(); save(); return; }
    if (ctrl && k === "k") { e.preventDefault(); showTab("palette"); return; }
    if (inField) return;
    if (!doc) return;

    if (e.key === "Alt") { e.preventDefault(); altHeld = true; moveGhost(); return; }
    if (e.key === " ") { e.preventDefault(); spaceHeld = true; host.style.cursor = "grab"; return; }
    if (ctrl && k === "z" && !e.shiftKey) { e.preventDefault(); doc.undo(); return; }
    if ((ctrl && k === "y") || (ctrl && e.shiftKey && k === "z")) { e.preventDefault(); doc.redo(); return; }
    if (ctrl && k === "a") {
      e.preventDefault();
      selection.clear();
      for (const n of scene!.nodes) if (n.view.visible && n.layerIndex === activeLayer) selection.add(n.inst);
      inspect(); drawOverlay();
      return;
    }
    if (ctrl && k === "c") { copySelection(); return; }
    if (ctrl && k === "v") { e.preventDefault(); paste(); return; }
    if (ctrl && k === "d") { e.preventDefault(); duplicate(); return; }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selection.size) { e.preventDefault(); doc.run(deleteCmd([...selection])); }
      return;
    }
    if (e.key.startsWith("Arrow") && selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? CELL : 1;
      const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
      const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
      doc.run(moveCmd([...selection], dx, dy, "微调"));
      return;
    }
    if (e.key === "Escape") {
      if (tool.kind === "place") setTool({ kind: "select" });
      else { selection.clear(); inspect(); drawOverlay(); }
      return;
    }
    if (k === "f") fit();
    if (k === "1") zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
    if (k === "g") { toggles.grid.checked = !toggles.grid.checked; applyVisibility(); }
    if (k === "s" && !ctrl) { toggles.snap.checked = !toggles.snap.checked; }
    if (k === "h") { toggles.hidden.checked = !toggles.hidden.checked; applyVisibility(); }
  });
}

function copySelection() {
  if (!doc || !selection.size) return;
  clipboard = [...selection].map((inst) => {
    const at = doc!.locate(inst);
    return { layerName: at ? room().layers[at.layer].layer_name : null, inst: JSON.parse(JSON.stringify(inst)) };
  });
  $("s-hover").textContent = `已复制 ${clipboard.length} 个实例`;
}

// paste so the clipboard's top-left instance lands on the cursor cell; each copy goes back
// to a layer of the same name if this room has one, else the active layer
function paste() {
  if (!doc || !clipboard.length) return;
  const minX = Math.min(...clipboard.map((c) => c.inst.x)), minY = Math.min(...clipboard.map((c) => c.inst.y));
  const dx = snapPoint(cursorWorld.x) - minX, dy = snapPoint(cursorWorld.y) - minY;
  const entries = clipboard.map((c) => {
    const li = room().layers.findIndex((L) => L.layer_name === c.layerName && L.layer_type === LayerType.Instances);
    return { layer: li >= 0 ? li : activeLayer, inst: cloneInstance(doc!, c.inst, dx, dy) };
  });
  doc.run(addCmd(entries, "粘贴"));
  selection.clear();
  entries.forEach((en) => selection.add(en.inst));
}

function duplicate() {
  if (!doc || !selection.size) return;
  const entries = [...selection].map((inst) => ({ layer: doc!.locate(inst)!.layer, inst: cloneInstance(doc!, inst, CELL, CELL) }));
  doc.run(addCmd(entries, "复制"));
  selection.clear();
  entries.forEach((en) => selection.add(en.inst));
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
  if (!doc || selection.size === 0) {
    body.innerHTML = `<span class="muted">点选一个实例；Shift 加选，空白处拖动框选。<br><br>从「对象」页签挑一个对象即可放置。</span>`;
    return;
  }
  const insts = [...selection];
  const first = insts[0];
  const n = nodeOf.get(first);
  const same = (k: keyof RoomInstance) => insts.every((i) => i[k] === first[k]);
  const layerIdx = insts.map((i) => doc!.locate(i)?.layer ?? -1);
  const sameLayer = layerIdx.every((l) => l === layerIdx[0]);

  const inputs = FIELDS.map((f) => {
    const mixed = !same(f.key);
    return `<label>${f.label}</label><input data-k="${f.key}" data-kind="${f.kind}" class="${mixed ? "mixed" : ""}" value="${mixed ? "" : esc(fmt(f.kind, first[f.key]))}" placeholder="${mixed ? "（多个值）" : ""}" spellcheck="false" />`;
  }).join("");
  const layerOpts = room().layers
    .map((L, i) => (L.layer_type === LayerType.Instances ? `<option value="${i}" ${sameLayer && layerIdx[0] === i ? "selected" : ""}>${esc(L.layer_name)}</option>` : ""))
    .join("");

  const head = insts.length === 1
    ? `<div class="insp-title">${esc(first.object_definition)}</div>`
    : `<div class="insp-title">${insts.length} 个实例${same("object_definition") ? " · " + esc(first.object_definition) : ""}</div>`;

  let facts = "";
  if (insts.length === 1 && n) {
    const obj = first.object_definition ?? "";
    const chain = db.parentChain(obj);
    const flags: string[] = [];
    if (n.customDraw) flags.push(`<span class="flag">自定义 Draw：编辑器按默认绘制</span>`);
    if (n.kind === "hidden") flags.push(`<span class="flag info">游戏内不可见</span>`);
    if (n.kind === "collision") flags.push(`<span class="flag info">碰撞戳 ${first.scale_x}×${first.scale_y} 格</span>`);
    if (!db.objects[obj]) flags.push(`<span class="flag">原版里没有这个对象：AddRoomJson 会静默丢弃这个实例</span>`);
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
    const commit = () => {
      const key = inp.dataset.k as keyof RoomInstance;
      const kind = inp.dataset.kind as FieldKind;
      if (inp.classList.contains("mixed") && inp.value === "") return;
      const p = parseField(kind, inp.value);
      if (!p.ok) { inp.style.borderColor = "var(--bad)"; return; }
      if (insts.every((i) => i[key] === p.v)) return;
      doc!.run(patchCmd(insts, { [key]: p.v } as InstPatch, `修改 ${key}`));
    };
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { commit(); inp.blur(); }
      if (e.key === "Escape") { inspect(); }
    });
    inp.addEventListener("change", commit);
  });
  body.querySelector<HTMLSelectElement>("select[data-layer]")!.onchange = (e) => {
    const to = Number((e.target as HTMLSelectElement).value);
    doc!.run(relayerCmd(insts, to));
    activeLayer = to;
  };
}

// scripting hook for headless checks (Playwright)
(window as any).svre = {
  focus(wx: number, wy: number, z: number) {
    const host = $("stage");
    zoom = z;
    world.scale.set(z);
    world.position.set(Math.round(host.clientWidth / 2 - wx * z), Math.round(host.clientHeight / 2 - wy * z));
    redrawZoomDependent();
  },
  set(name: keyof typeof toggles, on: boolean) {
    toggles[name].checked = on;
    applyVisibility();
  },
  get doc() { return doc; },
  get selection() { return [...selection]; },
  serialize: () => doc?.serialize(),
  screen(wx: number, wy: number) { return { x: world.x + wx * zoom, y: world.y + wy * zoom }; },
};

init().catch((e) => {
  console.error(e);
  $("load-state").textContent = `出错：${e.message}`;
});
