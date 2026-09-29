// The mod's own art. Vanilla assets come from the data.win extract (cache/assets); this
// scans what the mod itself ships so rooms can place and draw mod things:
//
//   <modDir>/Sprites/<name>_<N>.png   frame N of sprite <name> (0-based; bare <name>.png
//                                     is a single-frame sprite). MSL's packer gives these
//                                     origin (0,0) and a full-frame margin
//                                     (TextureLoader.cs:140-141) -- untrimmed PNGs.
//   <modDir>/**/*.cs                  the C# then fixes some of that up: AddObject calls
//                                     (named-arg and property-assignment styles) and
//                                     OriginX/OriginY/Margin* assignments on GetSprite
//                                     locals. We parse both back out.
//
// Mod frames get pseudo page numbers starting at MOD_PAGE_BASE so the client's Frame
// tuple and texture pipeline work unchanged; /mod-assets/pages/<i>.png serves the file.
import fs from "node:fs";
import path from "node:path";

export const MOD_PAGE_BASE = 1_000_000;

// same shapes as src/assets.ts, redeclared so the server never pulls pixi.js
export type Frame = [number, number, number, number, number, number, number, number, number, number, number] | [];
export interface ModSpriteDef {
  w: number;
  h: number;
  ox: number;
  oy: number;
  margin: [number, number, number, number]; // [left, top, right, bottom], inclusive
  frames: Frame[];
}
export interface ModObjectDef {
  // sparse: only fields the C# actually sets. A bare `GetObject` fixup overlays a vanilla
  // object and must not clobber the vanilla def's other fields with defaults.
  sprite?: string;
  parent?: string;
  visible?: boolean;
}

export interface ModAssets {
  sprites: Record<string, ModSpriteDef>;
  objects: Record<string, ModObjectDef>;
  pages: string[]; // absolute paths; index i <-> pseudo page MOD_PAGE_BASE + i
}

function pngSize(file: string): { w: number; h: number } | null {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(26);
    if (fs.readSync(fd, buf, 0, 26, 0) < 26) return null;
    if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } finally {
    fs.closeSync(fd);
  }
}

export function scanModAssets(modDir: string): ModAssets {
  const pages: string[] = [];
  const sprites: Record<string, ModSpriteDef> = {};
  const objects: Record<string, ModObjectDef> = {};

  // ---------------- Sprites/*.png ----------------
  const spritesDir = path.join(modDir, "Sprites");
  if (fs.existsSync(spritesDir)) {
    const bySprite = new Map<string, { n: number; file: string }[]>();
    for (const f of fs.readdirSync(spritesDir).filter((f) => f.toLowerCase().endsWith(".png")).sort()) {
      const m = /^(.*?)(?:_(\d+))?\.png$/i.exec(f)!;
      const list = bySprite.get(m[1]) ?? [];
      list.push({ n: m[2] !== undefined ? Number(m[2]) : 0, file: path.join(spritesDir, f) });
      bySprite.set(m[1], list);
    }
    for (const [name, frames] of bySprite) {
      const count = Math.max(...frames.map((f) => f.n)) + 1;
      const defs: Frame[] = Array.from({ length: count }, () => []);
      let w = 0, h = 0;
      for (const f of frames) {
        const size = pngSize(f.file);
        if (!size) continue;
        const page = MOD_PAGE_BASE + pages.length;
        pages.push(f.file);
        defs[f.n] = [page, 0, 0, size.w, size.h, 0, 0, size.w, size.h, size.w, size.h];
        w = Math.max(w, size.w);
        h = Math.max(h, size.h);
      }
      sprites[name] = { w, h, ox: 0, oy: 0, margin: [0, 0, w - 1, h - 1], frames: defs };
    }
  }

  // ---------------- *.cs: object registrations and sprite fixups ----------------
  const csFiles: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "bin" || e.name === "obj" || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 3) scan(full, depth + 1); }
      else if (e.name.endsWith(".cs")) csFiles.push(full);
    }
  };
  scan(modDir, 0);

  for (const file of csFiles) {
    const text = fs.readFileSync(file, "utf8");

    // locals bound to sprites: `UndertaleSprite x = Msl.GetSprite("s_name");`
    const spriteVar = new Map<string, string>();
    for (const m of text.matchAll(/(\w+)\s*=\s*Msl\.GetSprite\(\s*"([^"]+)"\s*\)/g)) spriteVar.set(m[1], m[2]);
    for (const [v, name] of spriteVar) {
      const def = sprites[name];
      if (!def) continue; // a vanilla sprite: editor already has its real origin/margin
      const fix = new RegExp(`\\b${v}\\.(OriginX|OriginY|MarginLeft|MarginRight|MarginTop|MarginBottom)\\s*=\\s*(-?\\d+)`, "g");
      for (const m of text.matchAll(fix)) {
        const n = Number(m[2]);
        if (m[1] === "OriginX") def.ox = n;
        else if (m[1] === "OriginY") def.oy = n;
        else if (m[1] === "MarginLeft") def.margin[0] = n;
        else if (m[1] === "MarginTop") def.margin[1] = n;
        else if (m[1] === "MarginRight") def.margin[2] = n;
        else if (m[1] === "MarginBottom") def.margin[3] = n;
      }
    }

    // objects. Two styles:
    //   Msl.AddObject("o_x", spriteName: "s_x", parentName: "o_p", isVisible: true, ...);
    //   UndertaleGameObject x = Msl.AddObject("o_y");  (or GetObject on an existing one)
    //   x.ParentId = Msl.GetObject("o_p"); x.Sprite = Msl.GetSprite("s_y"); x.Visible = true;
    const objVar = new Map<string, string>();
    const ensure = (name: string): ModObjectDef => (objects[name] ??= {});
    for (const m of text.matchAll(/(?:(\w+)\s*=\s*)?Msl\.AddObject\(\s*"([^"]+)"([\s\S]*?)\);/g)) {
      const [, v, name, args] = m;
      if (v) objVar.set(v, name);
      const def = ensure(name);
      const named = (key: string) => new RegExp(`${key}:\\s*"([^"]+)"`).exec(args)?.[1];
      const sprite = named("spriteName"), parent = named("parentName");
      const vis = /isVisible:\s*(true|false)/.exec(args)?.[1];
      if (sprite) def.sprite = sprite;
      if (parent) def.parent = parent;
      if (vis) def.visible = vis === "true";
    }
    for (const m of text.matchAll(/(\w+)\s*=\s*Msl\.GetObject\(\s*"([^"]+)"\s*\)/g)) objVar.set(m[1], m[2]);
    for (const [v, name] of objVar) {
      const def = ensure(name);
      const prop = (p: string, re: RegExp) => new RegExp(`\\b${v}\\.${p}\\s*=\\s*${re.source}`).exec(text);
      const parent = prop("ParentId", /Msl\.GetObject\("([^"]+)"\)/)?.[1];
      const sprite = prop("Sprite", /Msl\.GetSprite\("([^"]+)"\)/)?.[1];
      const vis = prop("Visible", /(true|false)/)?.[1];
      if (parent) def.parent = parent;
      if (sprite) def.sprite = sprite;
      if (vis) def.visible = vis === "true";
    }
  }

  return { sprites, objects, pages };
}
