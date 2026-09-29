// Object palette: search the 9.6k game objects by name or family, with a thumbnail cut
// straight out of the texture page by CSS (no canvas, no extra requests beyond the page).
import { pageUrl, type AssetDb } from "./assets";

export interface Family {
  label: string;
  test: (db: AssetDb, name: string) => boolean;
}

const descends = (root: string) => (db: AssetDb, name: string) => name === root || db.parentChain(name).includes(root);

export const FAMILIES: Family[] = [
  { label: "全部", test: () => true },
  { label: "家具", test: descends("o_stuff") },
  { label: "建筑", test: (db, n) => descends("c_barrierFade")(db, n) || descends("c_barrierNoFade")(db, n) },
  { label: "门/过场", test: descends("o_transitions_door") },
  { label: "碰撞/标记", test: (db, n) => ["o_hut_wall", "o_position_starter", "o_barrier_marker", "o_encounter_marker"].includes(n) || descends("o_position_starter")(db, n) },
  { label: "无 sprite", test: (db, n) => !db.objects[n]?.sprite },
];

const THUMB = 40;

export function thumbHtml(db: AssetDb, object: string, frame = 0, size = THUMB): string {
  const spr = db.objects[object]?.sprite;
  const def = spr ? db.sprites[spr] : undefined;
  const f = def && def.frames.length ? def.frames[frame % def.frames.length] : undefined;
  if (!f || f.length === 0) return `<div class="thumb empty" style="width:${size}px;height:${size}px">◇</div>`;
  const [page, sx, sy, sw, sh] = f;
  const k = Math.min(size / sw, size / sh, 2);
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  return `<div class="thumb" style="width:${size}px;height:${size}px"><div style="width:${sw}px;height:${sh}px;background:url(${pageUrl(page)}) -${sx}px -${sy}px no-repeat;transform:scale(${k});transform-origin:0 0;margin-right:${w - sw}px;margin-bottom:${h - sh}px"></div></div>`;
}

export function searchObjects(db: AssetDb, query: string, family: Family, limit = 150): string[] {
  const q = query.trim().toLowerCase();
  const out: { name: string; score: number }[] = [];
  for (const name of Object.keys(db.objects)) {
    const lower = name.toLowerCase();
    if (q && !lower.includes(q)) continue;
    if (!family.test(db, name)) continue;
    // exact > prefix > substring; objects with art first; shorter names first
    const score = (lower === q ? 0 : lower.startsWith(q) || lower.startsWith("o_" + q) ? 1 : 2) * 1000
      + (db.objects[name].sprite ? 0 : 500) + name.length;
    out.push({ name, score });
  }
  out.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return out.slice(0, limit).map((o) => o.name);
}
