// Copy the UTMT CLI next to the app for packaging (npm run vendor:utmt). The CLI is
// MIT-licensed so bundling is fine; it is what the first-run wizard extracts the
// asset cache with. vendor/ is gitignored -- rerun this before every electron-builder
// build (the source is cfg.utmtCli's install folder).
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "svre.config.json"), "utf8"));
const localFile = path.join(root, "svre.config.local.json");
if (fs.existsSync(localFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(localFile, "utf8")));

const srcExe = cfg.utmtCli;
if (!srcExe || !fs.existsSync(srcExe)) {
  console.error(`utmtCli not found: ${srcExe} (check svre.config.json)`);
  process.exit(1);
}
const src = path.dirname(srcExe);
const dst = path.join(root, "vendor", "utmt");
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
let files = 0;
for (const e of fs.readdirSync(src, { withFileTypes: true })) {
  // skip docs/samples; the CLI needs its full .NET runtime dll set
  if (e.isDirectory() && ["Scripts", "GameSpecificData"].includes(e.name)) continue;
  if (e.isFile() && [".pdb", ".md", ".txt"].includes(path.extname(e.name).toLowerCase())) continue;
  if (e.isDirectory()) fs.cpSync(path.join(src, e.name), path.join(dst, e.name), { recursive: true });
  else {
    fs.copyFileSync(path.join(src, e.name), path.join(dst, e.name));
    files++;
  }
}
const mb = fs.readdirSync(dst).reduce((s, f) => s + (fs.statSync(path.join(dst, f)).size ?? 0), 0) / 1048576;
console.log(`vendored ${files} files (${mb.toFixed(0)} MB top-level) -> ${dst}`);
