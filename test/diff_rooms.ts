// node test/diff_rooms.ts -- diff each compiled snapshot against its vanilla base and
// prove the ops replay to the byte-identical file.
import fs from "node:fs";
import { diffRooms, verifyDiff } from "../src/core/diff.ts";
import { applyAll } from "../src/core/ops.ts";
import { cloneRoom, serializeRoom, styleOf } from "../src/core/room.ts";

const MOD = "D:/Program Files/ModShardLauncher/ModSources/StoneValley";
const VAN = "E:/StoneShard_Mod_Data/tools/sv-room-editor/cache/assets/rooms";
const pairs = [
  ["r_house01inside_Child_2", "r_sv_hut_inside1"],
  ["r_house01inside2floor_Child_2", "r_sv_hut_inside2"],
  ["r_Abadonedhouse01Mid", "r_sv_hut_mid"],
  ["r_Abadonedhouse01Pine", "r_sv_hut_pine"],
];
let bad = 0;
for (const [b, t] of pairs) {
  const base = JSON.parse(fs.readFileSync(`${VAN}/${b}.json`, "utf8"));
  const text = fs.readFileSync(`${MOD}/rooms/${t}.compiled.json`, "utf8");
  const target = JSON.parse(text);
  const ops = diffRooms(base, target);
  const r = cloneRoom(base);
  applyAll(r, ops);
  const bytes = serializeRoom(r, styleOf(text)) === text;
  const kinds: Record<string, number> = {};
  for (const o of ops) kinds[o.op] = (kinds[o.op] ?? 0) + 1;
  console.log(t, verifyDiff(base, target, ops) ? "equal" : "DIFFERENT", bytes ? "byte-identical" : "BYTES DIFFER", JSON.stringify(kinds));
  if (!bytes) bad++;
}
process.exit(bad);
