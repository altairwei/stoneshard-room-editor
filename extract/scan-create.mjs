// Static scan of every object's effective Create and Draw events for the things the
// editor needs to draw a room the way the game does, and that the room data does not hold:
//
//   depth    room instances start at their layer's depth, but many objects move
//            themselves in Create -- `depth = -y + 18` (o_barrier and its whole
//            family), `depth = -10000`, ... That is what actually decides draw order.
//   visible  some objects hide themselves in Create regardless of the object flag.
//   draw     a Draw event replaces the default draw_self. Doors, ladders and the house
//            furnace draw ONLY their hover highlight (scr_highlight) -- their picture is
//            baked into the wall/background sprites, so drawing their sprite would be
//            wrong twice over. Classified from the effective Draw_0 chain:
//              self    draws its own sprite (draw_self / draw_sprite*(sprite_index ...))
//              hl      only hover highlight -> nothing in the resting picture
//              custom  draws something else; editor draws the sprite and flags it
//              baked   scr_bgRenderAdd: stamps itself into o_background_render's surface
//                      (depth 135 for index 0, 125 for index 1 -- o_controller_Create_0)
//              unit    scr_unitRenderDraw: drawn by the unit atlas renderer = its sprite
//              none    Draw exists but draws nothing
//            `event_perform_object(X, ev_draw, ...)` splices X's Draw chain in.
//
// The event that runs for an object is its own, or the nearest ancestor's when it has
// none; `event_inherited()` splices the parent's in at that point. We replay that chain
// over the decompiled source and keep the last assignment. Only top-level statements
// count for Create (decompiled GML indents block bodies), and only the depth shapes that
// cover >95% of the game: `-y [+-] N`, `N`, `-N`. Anything else is reported as unknown --
// the editor falls back to layer depth and says so instead of guessing.
//
//   node scan-create.mjs <source_codes dir> <assets dir>   -> <assets dir>/create.json
import fs from "node:fs";
import path from "node:path";

const [srcDir, assetsDir] = process.argv.slice(2);
if (!srcDir || !assetsDir) {
  console.error("usage: node scan-create.mjs <source_codes dir> <assets dir>");
  process.exit(2);
}
const objects = JSON.parse(fs.readFileSync(path.join(assetsDir, "objects.json"), "utf8"));

const hasEv = (name, type, sub) => objects[name]?.events.some(([t, s]) => t === type && s === sub);
const hasCreate = (name) => hasEv(name, 0, 0);
const hasDraw = (name) => hasEv(name, 8, 0);
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : null);

// the event that actually runs for `name`: own, else nearest ancestor that has one
function effectiveOwner(name, has = hasCreate) {
  for (let n = name; n; n = objects[n]?.parent) if (has(n)) return n;
  return null;
}

// ---- Create_0 ----

// statements of one Create body, in order: {kind:'inherit'} | {kind:'depth'|'visible', ...}
const bodyCache = new Map();
function body(name) {
  if (bodyCache.has(name)) return bodyCache.get(name);
  const out = [];
  for (const line of lines(path.join(srcDir, `gml_Object_${name}_Create_0.gml`)) ?? []) {
    const top = !/^\s/.test(line);
    const t = line.trim();
    if (t.startsWith("event_inherited()")) { if (top) out.push({ kind: "inherit" }); continue; }
    let m = /^depth\s*=\s*([^;]+);?$/.exec(t);
    if (m) { out.push({ kind: "depth", conditional: !top, ...parseDepth(m[1].trim()) }); continue; }
    m = /^visible\s*=\s*(true|false|0|1);?$/.exec(t);
    if (m) out.push({ kind: "visible", conditional: !top, value: m[1] === "true" || m[1] === "1" });
  }
  bodyCache.set(name, out);
  return out;
}

function parseDepth(expr) {
  const e = expr.replace(/\s+/g, "");
  let m = /^-y(?:([+-])(\d+(?:\.\d+)?))?$/.exec(e);
  if (m) return { mode: "y", offset: m[1] ? (m[1] === "-" ? -1 : 1) * Number(m[2]) : 0 };
  m = /^\(-y([+-]\d+)\)([+-]\d+)$/.exec(e) || /^-y([+-]\d+)([+-]\d+)$/.exec(e);
  if (m) return { mode: "y", offset: Number(m[1]) + Number(m[2]) };
  m = /^(-?\d+(?:\.\d+)?)$/.exec(e);
  if (m) return { mode: "const", value: Number(m[1]) };
  return { mode: "unknown", expr };
}

// replay the chain; returns the flattened statement list
function replay(owner, guard = new Set()) {
  if (!owner || guard.has(owner)) return [];
  guard.add(owner);
  const out = [];
  for (const st of body(owner)) {
    if (st.kind === "inherit") out.push(...replay(effectiveOwner(objects[owner]?.parent), guard));
    else out.push({ ...st, from: owner });
  }
  return out;
}

// ---- Draw_0 ----

const SELF = /^(draw_self|scr_draw_self_stuff|scr_draw_self_effect_hit)\(|^draw_sprite(_ext|_part|_part_ext|_stretched|_stretched_ext)?\(\s*sprite_index\b/;
const HL = /^(scr_highlight|scr_highlight_ext|show_highlight|show_highlight_alt|scr_draw_highlight)\(/;
const OTHER = /^(draw_(?!set_|clear)[a-z_]+|scr_draw[A-Za-z_]*)\(/;

function drawCalls(name, guard = new Set()) {
  if (!name || guard.has(name)) return [];
  guard.add(name);
  const out = [];
  for (const line of lines(path.join(srcDir, `gml_Object_${name}_Draw_0.gml`)) ?? []) {
    const t = line.trim();
    if (t.startsWith("event_inherited()")) { out.push(...drawCalls(effectiveOwner(objects[name]?.parent, hasDraw), guard)); continue; }
    const perf = /^event_perform_object\((\w+),\s*ev_draw\b/.exec(t);
    if (perf) { out.push(...drawCalls(effectiveOwner(perf[1], hasDraw), guard)); continue; }
    const bake = /^scr_bgRenderAdd\((\d*)/.exec(t);
    if (bake) { out.push({ c: "baked", from: name, index: Number(bake[1] || 0) }); continue; }
    if (/^scr_unitRenderDraw\(/.test(t)) { out.push({ c: "unit", from: name }); continue; }
    if (SELF.test(t)) out.push({ c: "self", from: name });
    else if (HL.test(t)) out.push({ c: "hl", from: name });
    else if (OTHER.test(t)) out.push({ c: "custom", from: name, call: t.slice(0, 60) });
  }
  return out;
}

function drawMode(name) {
  const owner = effectiveOwner(name, hasDraw);
  if (!owner) return null; // default draw
  const calls = drawCalls(owner);
  const baked = calls.find((c) => c.c === "baked");
  if (baked) return { mode: "baked", from: owner, depth: baked.index === 1 ? 125 : 135 };
  if (calls.some((c) => c.c === "unit")) return { mode: "unit", from: owner };
  if (calls.some((c) => c.c === "self"))
    return { mode: "self", from: owner, ...(calls.some((c) => c.c === "custom") ? { extra: true } : {}) };
  const custom = calls.find((c) => c.c === "custom");
  if (custom) return { mode: "custom", from: owner, call: custom.call };
  if (calls.some((c) => c.c === "hl")) return { mode: "hl", from: owner };
  return { mode: "none", from: owner };
}

// ---- output ----

const result = {};
let known = 0, unknown = 0;
for (const name of Object.keys(objects)) {
  const sts = replay(effectiveOwner(name));
  const depth = sts.filter((s) => s.kind === "depth").pop();
  const visible = sts.filter((s) => s.kind === "visible").pop();
  const draw = drawMode(name);
  if (!depth && !visible && !draw) continue;
  const r = {};
  if (draw) r.draw = draw;
  if (depth) {
    r.depth = { mode: depth.mode, from: depth.from };
    if (depth.mode === "y") r.depth.offset = depth.offset;
    if (depth.mode === "const") r.depth.value = depth.value;
    if (depth.mode === "unknown") r.depth.expr = depth.expr;
    if (depth.conditional) r.depth.conditional = true;
    depth.mode === "unknown" ? unknown++ : known++;
  }
  if (visible) r.visible = { value: visible.value, from: visible.from, ...(visible.conditional ? { conditional: true } : {}) };
  result[name] = r;
}
fs.writeFileSync(path.join(assetsDir, "create.json"), JSON.stringify(result));
console.log(`create.json: ${Object.keys(result).length} objects, depth known=${known} unknown=${unknown}`);
