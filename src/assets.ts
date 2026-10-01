// The extracted asset cache (see extract/): objects, sprites, Create-scan facts, and the
// game's own texture pages, loaded lazily page by page. On top of that sits the mod's own
// art (/api/mod-assets, parsed server-side from Sprites/*.png + the mod's C#): its frames
// get pseudo page numbers >= MOD_PAGE_BASE and each PNG is its own "page".
import { Assets, Rectangle, Texture, TextureSource } from "pixi.js";

export const MOD_PAGE_BASE = 1_000_000;
export const pageUrl = (i: number) =>
  i >= MOD_PAGE_BASE ? `/mod-assets/pages/${i - MOD_PAGE_BASE}.png` : `/assets/pages/${i}.png`;

export interface ObjectDef {
  sprite?: string;
  parent?: string;
  mask?: string;
  visible: boolean;
  persistent: boolean;
  depth: number;
  events: [number, number][];
}

// [page, srcX, srcY, srcW, srcH, tgtX, tgtY, tgtW, tgtH, boundW, boundH]; [] = no texture
export type Frame = [number, number, number, number, number, number, number, number, number, number, number] | [];

export interface SpriteDef {
  w: number;
  h: number;
  ox: number;
  oy: number;
  margin: [number, number, number, number];
  frames: Frame[];
}

export interface CreateFacts {
  depth?: {
    mode: "y" | "const" | "unknown"; from: string; offset?: number; value?: number; expr?: string;
    conditional?: boolean; perFrame?: boolean; offsetVar?: string;
  };
  visible?: { value: boolean; from: string; conditional?: boolean };
  // absent = default draw (draw_self); see extract/scan-create.mjs for the modes
  draw?: { mode: "self" | "hl" | "custom" | "baked" | "unit" | "none"; from: string; extra?: boolean; call?: string; depth?: number };
}

export class AssetDb {
  objects: Record<string, ObjectDef> = {};
  sprites: Record<string, SpriteDef> = {};
  create: Record<string, CreateFacts> = {};
  modObjects = new Set<string>(); // names the mod's C# registers (AddObject / GetObject fixups)
  private modSpriteNames = new Set<string>(); // every sprite a mod scan ever handed us
  private pages = new Map<number, Promise<TextureSource>>();
  private frameTex = new Map<string, Texture>();

  async load() {
    const get = (f: string) => fetch(`/assets/${f}`).then((r) => {
      if (!r.ok) throw new Error(`/assets/${f}: ${r.status} -- run the extract step`);
      return r.json();
    });
    [this.objects, this.sprites, this.create] = await Promise.all([get("objects.json"), get("sprites.json"), get("create.json")]);

    // Best-effort: an editor without the route still works.
    try {
      const ma = await fetch("/api/mod-assets").then((r) => (r.ok ? r.json() : null));
      if (ma) this.applyMod(ma);
    } catch { /* mod assets are additive; vanilla-only editing still works */ }
  }

  // merge the server's mod scan over the vanilla defs (a mod can re-sprite a vanilla
  // object). Re-runnable: importing a sprite re-merges on top without a page reload.
  private applyMod(ma: { objects: Record<string, Partial<ObjectDef>>; sprites: Record<string, SpriteDef> }) {
    for (const [name, def] of Object.entries(ma.objects)) {
      this.modObjects.add(name);
      const base: ObjectDef = this.objects[name] ?? { visible: true, persistent: false, depth: 0, events: [] };
      this.objects[name] = { ...base, ...def };
    }
    for (const [name, def] of Object.entries(ma.sprites)) {
      this.sprites[name] = def;
      this.modSpriteNames.add(name);
    }
  }

  // re-pull the mod overlay after a registration changed server-side. Pseudo page numbers
  // are reassigned by every server scan, so a cached mod page/texture could now point at a
  // different file -- drop those (vanilla pages never shift).
  async reloadModAssets() {
    const ma = await fetch("/api/mod-assets").then((r) => (r.ok ? r.json() : null));
    if (!ma) return;
    for (const k of [...this.pages.keys()]) if (k >= MOD_PAGE_BASE) this.pages.delete(k);
    const names = new Set([...this.modSpriteNames, ...Object.keys(ma.sprites)]);
    for (const k of [...this.frameTex.keys()]) if (names.has(k.slice(0, k.lastIndexOf("#")))) this.frameTex.delete(k);
    this.applyMod(ma);
  }

  parentChain(name: string): string[] {
    const out: string[] = [];
    for (let n = this.objects[name]?.parent; n && out.length < 32; n = this.objects[n]?.parent) out.push(n);
    return out;
  }

  // Create-scan facts for an object, falling back along its parent chain: mod objects are
  // never in create.json (the scan is vanilla-only) but their parents are vanilla, and the
  // facts genuinely come from that chain (the `from` attribution in the facts says so).
  createOf(name: string): CreateFacts | undefined {
    let n: string | undefined = name;
    for (let i = 0; n && i < 32; i++) {
      const f = this.create[n];
      if (f) return f;
      n = this.objects[n]?.parent;
    }
    return undefined;
  }

  hasEvent(name: string, type: number): boolean {
    return !!this.objects[name]?.events.some(([t]) => t === type);
  }

  private page(i: number): Promise<TextureSource> {
    let p = this.pages.get(i);
    if (!p) {
      p = Assets.load<Texture>({ src: pageUrl(i), parser: "loadTextures" }).then((t) => {
        t.source.scaleMode = "nearest";
        return t.source;
      });
      this.pages.set(i, p);
    }
    return p;
  }

  // page indexes a set of frames needs, so a room can preload before drawing
  async preload(frames: Frame[]) {
    const need = new Set<number>();
    for (const f of frames) if (f.length) need.add(f[0]);
    await Promise.all([...need].map((i) => this.page(i)));
  }

  // texture of one frame, cropped to the stored (trimmed) rect; caller places it at tgtX/tgtY
  async frameTexture(sprite: string, index: number): Promise<{ tex: Texture; frame: Frame } | null> {
    const def = this.sprites[sprite];
    if (!def || def.frames.length === 0) return null;
    const i = ((index % def.frames.length) + def.frames.length) % def.frames.length;
    const f = def.frames[i];
    if (f.length === 0) return null;
    const key = `${sprite}#${i}`;
    let tex = this.frameTex.get(key);
    if (!tex) {
      const source = await this.page(f[0]);
      tex = new Texture({ source, frame: new Rectangle(f[1], f[2], f[3], f[4]) });
      this.frameTex.set(key, tex);
    }
    return { tex, frame: f };
  }
}
