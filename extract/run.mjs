// npm run extract -- rebuild the asset cache from the untouched vanilla data file.
//
//   1. UTMT CLI, one load, two scripts:
//      ExportEditorAssets.csx -> objects.json, sprites.json, rooms.json, pages/*.png
//      ExportRooms.csx        -> rooms/*.json + rooms/_index.json (all 1067 room bases)
//   2. scan-create.mjs over the decompiled source -> create.json (depth / visible / draw facts)
//
// Paths come from svre.config.json (+ svre.config.local.json). Only needed again when the
// game updates (then also regenerate extract/fingerprint.json). Takes a few minutes; the
// pages are ~435 MB.
//
// ⚠ UTMT CLI waits on stdin after the script finishes. Run it with stdin closed ("ignore"),
//   or it hangs forever at ~0% CPU with no output.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cfg = JSON.parse(fs.readFileSync(path.join(root, "svre.config.json"), "utf8"));
const localFile = path.join(root, "svre.config.local.json");
if (fs.existsSync(localFile)) Object.assign(cfg, JSON.parse(fs.readFileSync(localFile, "utf8")));

const only = process.argv[2]; // "scan" = skip the UTMT step
fs.mkdirSync(cfg.assetsDir, { recursive: true });

if (only !== "scan") {
  console.log(`[1/2] exporting ${cfg.vanillaWin} -> ${cfg.assetsDir}`);
  // each script needs its OWN -s flag (the help text's "Ex. a.csx b.csx" is a lie:
  // a second bare argument is rejected)
  const r = spawnSync(
    cfg.utmtCli,
    [
      "load",
      cfg.vanillaWin,
      "-s", path.join(root, "extract", "ExportEditorAssets.csx"),
      "-s", path.join(root, "extract", "ExportRooms.csx"),
    ],
    {
      env: { ...process.env, SVRE_OUT: cfg.assetsDir },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  if (r.status !== 0) {
    console.error(`UTMT CLI exited with ${r.status}`);
    process.exit(1);
  }
}

console.log(`[2/2] scanning Create/Draw events in ${cfg.sourceDir}`);
const s = spawnSync(process.execPath, [path.join(root, "extract", "scan-create.mjs"), cfg.sourceDir, cfg.assetsDir], { stdio: "inherit" });
process.exit(s.status ?? 1);
