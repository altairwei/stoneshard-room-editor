// App icon generator. A top-down room floor plan -- light stone walls with a doorway,
// plank floor -- with a violet Stoneshard crystal shard rising out of it. Built for
// desktop legibility: one bold silhouette, a dark outline that holds on light wallpapers
// and light shapes that hold on dark ones, no background tile.
// Emits
//   build/icon.svg        -- 40px and up
//   build/icon-small.svg  -- 16..32px cut with heavier outlines
//   build/icon.png        -- 256×256
//   build/icon.ico        -- 16/20/24/32/40/48/64/128/256, PNG-compressed entries
// The SVGs are rasterized by Electron's Chromium (build/render-svg.cjs), so every size
// is rendered from vectors rather than downscaled. Run: npm run icon
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = dirname(fileURLToPath(import.meta.url));
const INK = "#1c0f2e"; // outline: a near-black violet

// faceted shard in Stoneshard's violet, lit from the top-left: tip at (cx, top), height
// h; ow = outline half-width
function shard(cx, top, h, ow) {
  const P = (x, y) => `${(cx + x * h).toFixed(1)},${(top + y * h).toFixed(1)}`;
  const tip = P(0, 0), ul = P(-0.22, 0.3), ll = P(-0.16, 0.79), bot = P(0, 1), lr = P(0.16, 0.79), ur = P(0.22, 0.3);
  const a = P(-0.045, 0.35), b = P(-0.02, 0.84); // ridge
  return `
<polygon points="${tip} ${ul} ${ll} ${bot} ${lr} ${ur}" fill="${INK}" stroke="${INK}" stroke-width="${2 * ow}" stroke-linejoin="round"/>
<polygon points="${tip} ${ul} ${a}" fill="#f2e0ff"/>
<polygon points="${ul} ${ll} ${b} ${a}" fill="#b47cf4"/>
<polygon points="${ll} ${bot} ${b}" fill="#9150de"/>
<polygon points="${tip} ${a} ${ur}" fill="#9d5fe8"/>
<polygon points="${a} ${ur} ${lr} ${b}" fill="#6c31b8"/>
<polygon points="${b} ${lr} ${bot}" fill="#4a1d8a"/>
<path d="M${P(-0.17, 0.31)}L${P(-0.035, 0.07)}" stroke="#fff" stroke-opacity=".85" stroke-width="${h * 0.03}" stroke-linecap="round"/>`;
}

function icon({ small }) {
  const ow = small ? 12 : 7;
  // floor-plan box, wall thickness W, doorway [g0, g1] in the bottom wall
  const W = 30, x0 = 34, x1 = 222, y0 = 82, y1 = 230, r = 20, g0 = 58, g1 = 100;
  // wall centre-line from one door jamb clockwise round to the other; e pulls the jambs
  // back so the outline caps them
  const ring = (e) =>
    `M${g1 - e} ${y1}H${x1 - r}A${r} ${r} 0 0 0 ${x1} ${y1 - r}V${y0 + r}A${r} ${r} 0 0 0 ${x1 - r} ${y0}H${x0 + r}A${r} ${r} 0 0 0 ${x0} ${y0 + r}V${y1 - r}A${r} ${r} 0 0 0 ${x0 + r} ${y1}H${g0 + e}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${y1 - y0}" rx="${r}" fill="#8a5a33"/>
<path d="M${x0} ${y0 + 52}H${x1}M${x0} ${y0 + 100}H${x1}" stroke="#6a4224" stroke-width="${ow + 3}"/>
<rect x="${g0}" y="${y1}" width="${g1 - g0}" height="${W / 2 + ow}" fill="${INK}"/>
<rect x="${g0}" y="${y1 - 1}" width="${g1 - g0}" height="${W / 2 + 1}" fill="#8a5a33"/>
<path d="${ring(ow)}" fill="none" stroke="${INK}" stroke-width="${W + 2 * ow}"/>
<path d="${ring(0)}" fill="none" stroke="#c3c6cf" stroke-width="${W}"/>
<path d="${ring(0)}" fill="none" stroke="#e9ebf0" stroke-width="${W * 0.28}" transform="translate(0 ${-W * 0.3})"/>
<ellipse cx="128" cy="204" rx="44" ry="10" fill="#000" opacity=".35"/>
${shard(128, 18, 192, ow)}
</svg>
`;
}

// ---- rasterize + pack -----------------------------------------------------------------
const SMALL = [16, 20, 24, 32], LARGE = [40, 48, 64, 128, 256];
const full = join(OUT, "icon.svg"), small = join(OUT, "icon-small.svg");
writeFileSync(full, icon({ small: false }));
writeFileSync(small, icon({ small: true }));

const electron = createRequire(import.meta.url)("electron"); // the binary's path
const tmp = mkdtempSync(join(tmpdir(), "svre-icon-"));
const render = (sizes, file) => {
  const r = spawnSync(electron, [join(OUT, "render-svg.cjs"), tmp, sizes.join(","), file], { stdio: "inherit" });
  if (r.status !== 0) throw new Error(`render failed for ${file}`);
};
render(SMALL, small);
render(LARGE, full);
const png = (name, s) => readFileSync(join(tmp, `${name}-${s}.png`));
const entries = [...SMALL.map((s) => [s, png("icon-small", s)]), ...LARGE.map((s) => [s, png("icon", s)])];

function ico(list) {
  const head = Buffer.alloc(6 + 16 * list.length);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(list.length, 4);
  let off = head.length;
  list.forEach(([s, data], i) => {
    const e = 6 + 16 * i;
    head[e] = head[e + 1] = s >= 256 ? 0 : s; // 0 means 256
    head.writeUInt16LE(1, e + 4); // planes
    head.writeUInt16LE(32, e + 6); // bpp
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(off, e + 12);
    off += data.length;
  });
  return Buffer.concat([head, ...list.map(([, d]) => d)]);
}

writeFileSync(join(OUT, "icon.png"), png("icon", 256));
writeFileSync(join(OUT, "icon.ico"), ico(entries));
if (process.argv.includes("--preview")) {
  for (const [s, d] of entries) writeFileSync(join(OUT, `preview-${s}.png`), d);
}
rmSync(tmp, { recursive: true, force: true });
console.log("icon: build/icon.svg, build/icon-small.svg, build/icon.png, build/icon.ico");
