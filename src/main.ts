import "./style.css";
import { Application, Container, Graphics } from "pixi.js";
import { AssetDb } from "./assets";
import { CELL, LayerType, parseRoom, type Room } from "./room";
import { buildScene, drawBounds, drawGrid, type InstanceNode, type RoomScene } from "./render";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[c]};`);

const db = new AssetDb();
const app = new Application();
const world = new Container(); // pan/zoom lives here
const overlay = new Graphics(); // screen-space hover/selection outlines

let room: Room | null = null;
let scene: RoomScene | null = null;
let zoom = 1;
let hovered: InstanceNode | null = null;
let selected: InstanceNode | null = null;
const layerOff = new Set<number>();

const toggles = {
  hidden: $<HTMLInputElement>("t-hidden"),
  collision: $<HTMLInputElement>("t-collision"),
  markers: $<HTMLInputElement>("t-markers"),
  grid: $<HTMLInputElement>("t-grid"),
};

async function init() {
  const host = $("stage");
  await app.init({ resizeTo: host, background: 0x0d0e11, antialias: false, roundPixels: true, autoDensity: true, resolution: devicePixelRatio });
  host.appendChild(app.canvas);
  app.stage.addChild(world, overlay);

  $("load-state").textContent = "加载资产…";
  await db.load();
  $("load-state").textContent = `${Object.keys(db.objects).length} 对象 · ${Object.keys(db.sprites).length} sprite`;

  const rooms: { file: string; bytes: number }[] = await fetch("/api/rooms").then((r) => r.json());
  const sel = $<HTMLSelectElement>("room-select");
  sel.innerHTML = rooms.map((r) => `<option value="${esc(r.file)}">${esc(r.file.replace(/\.gml$/, ""))}</option>`).join("");
  sel.onchange = () => openRoom(sel.value);
  const initial = new URLSearchParams(location.search).get("room") ?? rooms[0]?.file;
  if (initial) {
    sel.value = initial;
    await openRoom(initial);
  }

  for (const t of Object.values(toggles)) t.onchange = applyVisibility;
  $("b-fit").onclick = fit;
  $("b-1x").onclick = () => zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
  wireViewport(host);
}

async function openRoom(file: string) {
  $("load-state").textContent = `打开 ${file}…`;
  const text = await fetch(`/api/room/${encodeURIComponent(file)}`).then((r) => r.text());
  room = parseRoom(text);
  if (scene) {
    world.removeChild(scene.root);
    scene.root.destroy({ children: true });
  }
  scene = await buildScene(db, room);
  world.addChild(scene.root);
  hovered = selected = null;
  layerOff.clear();
  renderLayerList();
  applyVisibility();
  fit();
  inspect(null);
  history.replaceState(null, "", `?room=${encodeURIComponent(file)}`);
  const counts = scene.nodes.reduce<Record<string, number>>((a, n) => ((a[n.kind] = (a[n.kind] ?? 0) + 1), a), {});
  $("load-state").textContent = `${room.name} · ${room.width}×${room.height} · 可见 ${counts.drawn ?? 0} · 隐形 ${counts.hidden ?? 0} · 碰撞 ${counts.collision ?? 0} · 标记 ${counts.marker ?? 0}`;
}

function applyVisibility() {
  if (!scene || !room) return;
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

function renderLayerList() {
  if (!room || !scene) return;
  const list = $("layer-list");
  const typeName: Record<number, string> = { 0: "path", 1: "背景", 2: "实例", 3: "资产", 4: "瓦片" };
  list.innerHTML = room.layers
    .map((L, i) => {
      const n = L.layer_type === LayerType.Instances ? L.layer_data.instances.length : "";
      return `<li data-i="${i}" class="${layerOff.has(i) ? "off" : ""}">
        <span class="eye">${layerOff.has(i) ? "◌" : "●"}</span>
        <span class="name">${esc(L.layer_name)}${L.is_visible ? "" : ' <span class="tag">游戏内隐藏</span>'}</span>
        <span class="meta">${typeName[L.layer_type] ?? L.layer_type} ${n} · d${L.layer_depth}</span></li>`;
    })
    .join("");
  list.querySelectorAll("li").forEach((li) => {
    li.addEventListener("click", () => {
      const i = Number((li as HTMLElement).dataset.i);
      layerOff.has(i) ? layerOff.delete(i) : layerOff.add(i);
      renderLayerList();
      applyVisibility();
    });
  });
}

// ---------- viewport ----------

function redrawZoomDependent() {
  if (!scene || !room) return;
  if (toggles.grid.checked) drawGrid(scene.gridLayer, room, zoom);
  drawBounds(scene.boundsLayer, room, zoom);
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
  if (!room) return;
  const host = $("stage");
  const z = Math.min(host.clientWidth / room.width, host.clientHeight / room.height) * 0.94;
  // snap to a pixel-friendly step so the art stays crisp
  zoom = z >= 1 ? Math.floor(z * 2) / 2 : z;
  world.scale.set(zoom);
  world.position.set(Math.round((host.clientWidth - room.width * zoom) / 2), Math.round((host.clientHeight - room.height * zoom) / 2));
  redrawZoomDependent();
}

function wireViewport(host: HTMLElement) {
  let drag: { x: number; y: number; wx: number; wy: number; moved: boolean } | null = null;

  host.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = host.getBoundingClientRect();
    zoomAt(zoom * Math.pow(1.0015, -e.deltaY), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });

  host.addEventListener("pointerdown", (e) => {
    host.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, wx: world.x, wy: world.y, moved: false };
  });
  host.addEventListener("pointermove", (e) => {
    const r = host.getBoundingClientRect();
    const sx = e.clientX - r.left, sy = e.clientY - r.top;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.moved) {
        host.classList.add("panning");
        world.position.set(drag.wx + dx, drag.wy + dy);
        drawOverlay();
      }
    }
    const wx = (sx - world.x) / zoom, wy = (sy - world.y) / zoom;
    $("s-pos").textContent = `x ${Math.floor(wx)}  y ${Math.floor(wy)}`;
    $("s-cell").textContent = `格 ${Math.floor(wx / CELL)}, ${Math.floor(wy / CELL)}`;
    const h = pick(e.clientX - r.left, e.clientY - r.top);
    if (h !== hovered) {
      hovered = h;
      $("s-hover").textContent = h ? `${h.inst.object_definition}  @${h.inst.x},${h.inst.y}  depth ${h.depth}  [${h.layer.layer_name}]` : "—";
      drawOverlay();
    }
  });
  host.addEventListener("pointerup", (e) => {
    host.classList.remove("panning");
    if (drag && !drag.moved) {
      const r = host.getBoundingClientRect();
      selected = pick(e.clientX - r.left, e.clientY - r.top);
      inspect(selected);
      drawOverlay();
    }
    drag = null;
  });

  window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === "f" || e.key === "F") fit();
    if (e.key === "1") zoomAt(1, host.clientWidth / 2, host.clientHeight / 2);
    if (e.key === "g" || e.key === "G") { toggles.grid.checked = !toggles.grid.checked; applyVisibility(); }
    if (e.key === "Escape") { selected = null; inspect(null); drawOverlay(); }
  });
}

// topmost visible instance under a screen point: overlays first, then the game picture by draw order
function pick(sx: number, sy: number): InstanceNode | null {
  if (!scene) return null;
  const hits = scene.nodes.filter((n) => {
    if (!n.view.visible) return false;
    const b = n.view.getBounds();
    return sx >= b.x && sx < b.x + b.width && sy >= b.y && sy < b.y + b.height;
  });
  hits.sort((a, b) => b.view.zIndex - a.view.zIndex);
  return hits[0] ?? null;
}

function drawOverlay() {
  overlay.clear();
  const box = (n: InstanceNode, color: number, w: number) => {
    const b = n.view.getBounds();
    overlay.rect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.width), Math.round(b.height)).stroke({ color, width: w });
  };
  if (hovered && hovered !== selected && hovered.view.visible) box(hovered, 0xffffff, 1);
  if (selected && selected.view.visible) box(selected, 0x6cb6ff, 2);
}

function inspect(n: InstanceNode | null) {
  const body = $("inspect-body");
  if (!n) {
    body.innerHTML = `<span class="muted">点选一个实例</span>`;
    return;
  }
  const i = n.inst;
  const obj = i.object_definition ?? "";
  const def = db.objects[obj];
  const chain = db.parentChain(obj);
  const row = (k: string, v: unknown) => `<div class="k">${k}</div><div class="v">${esc(v)}</div>`;
  const flags: string[] = [];
  if (n.customDraw) flags.push(`<span class="flag">自定义 Draw：编辑器按默认绘制</span>`);
  if (n.kind === "hidden") flags.push(`<span class="flag info">游戏内不可见</span>`);
  if (n.kind === "collision") flags.push(`<span class="flag info">碰撞戳 ${i.scale_x}×${i.scale_y} 格</span>`);
  if (i.creation_code) flags.push(`<span class="flag info">有 creation code</span>`);
  body.innerHTML = `
    <div class="kv">
      ${row("对象", obj)}
      ${row("sprite", def?.sprite ?? "—")}
      ${row("图层", `${n.layer.layer_name} (#${n.instIndex})`)}
      ${row("位置", `${i.x}, ${i.y}`)}
      ${row("格", `${Math.floor(i.x / CELL)}, ${Math.floor(i.y / CELL)}`)}
      ${row("缩放", `${i.scale_x} × ${i.scale_y}`)}
      ${row("旋转", i.rotation)}
      ${row("帧", `${i.image_index}  speed ${i.image_speed}`)}
      ${row("颜色", "0x" + (i.color >>> 0).toString(16).toUpperCase().padStart(8, "0"))}
      ${row("depth", `${n.depth}`)}
      ${row("  来源", n.depthWhy)}
      ${row("可见", n.visibleWhy)}
      ${row("creation", i.creation_code ?? "—")}
      ${row("pre-create", i.pre_create_code ?? "—")}
    </div>
    <div class="chain">父链：${chain.length ? esc(chain.join(" → ")) : "（无）"}</div>
    <div>${flags.join("")}</div>`;
}

// scripting hook for headless checks (Playwright): centre world point (wx, wy) at zoom z
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
};

init().catch((e) => {
  console.error(e);
  $("load-state").textContent = `出错：${e.message}`;
});
