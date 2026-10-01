// Regenerate extract/fingerprint.json from the current cache after a game update:
//   npm run extract && node extract/fingerprint.mjs <game-version-label>
// The wizard compares every artist's fresh extract against this pinned fingerprint.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "svre.config.json"), "utf8"));
const localFile = path.join(root, "svre.config.local.json");
if (fs.existsSync(localFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(localFile, "utf8")));
const dir = cfg.assetsDir;

const old = JSON.parse(fs.readFileSync(path.join(root, "extract", "fingerprint.json"), "utf8"));
const fp = {
  game: process.argv[2] ?? old.game,
  note: old.note,
  objects: Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "objects.json"), "utf8"))).length,
  sprites: Object.keys(JSON.parse(fs.readFileSync(path.join(dir, "sprites.json"), "utf8"))).length,
  rooms: JSON.parse(fs.readFileSync(path.join(dir, "rooms.json"), "utf8")).length,
  indexSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, "rooms", "_index.json"))).digest("hex"),
};
fs.writeFileSync(path.join(root, "extract", "fingerprint.json"), JSON.stringify(fp, null, 2) + "\n");
console.log(JSON.stringify(fp));
