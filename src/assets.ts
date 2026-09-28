// The extracted asset cache (see extract/): objects, sprites, Create-scan facts, and the
// game's own texture pages, loaded lazily page by page.
import { Assets, Rectangle, Texture, TextureSource } from "pixi.js";

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
  depth?: { mode: "y" | "const" | "unknown"; from: string; offset?: number; value?: number; expr?: string; conditional?: boolean };
  visible?: { value: boolean; from: string; conditional?: boolean };
  // absent = default draw (draw_self); see extract/scan-create.mjs for the modes
  draw?: { mode: "self" | "hl" | "custom" | "baked" | "unit" | "none"; from: string; extra?: boolean; call?: string; depth?: number };
}

export class AssetDb {
  objects: Record<string, ObjectDef> = {};
  sprites: Record<string, SpriteDef> = {};
  create: Record<string, CreateFacts> = {};
  private pages = new Map<number, Promise<TextureSource>>();
  private frameTex = new Map<string, Texture>();

  async load() {
    const get = (f: string) => fetch(`/assets/${f}`).then((r) => {
      if (!r.ok) throw new Error(`/assets/${f}: ${r.status} -- run the extract step`);
      return r.json();
    });
    [this.objects, this.sprites, this.create] = await Promise.all([get("objects.json"), get("sprites.json"), get("create.json")]);
  }

  parentChain(name: string): string[] {
    const out: string[] = [];
    for (let n = this.objects[name]?.parent; n && out.length < 32; n = this.objects[n]?.parent) out.push(n);
    return out;
  }

  hasEvent(name: string, type: number): boolean {
    return !!this.objects[name]?.events.some(([t]) => t === type);
  }

  private page(i: number): Promise<TextureSource> {
    let p = this.pages.get(i);
    if (!p) {
      p = Assets.load<Texture>({ src: `/assets/pages/${i}.png`, parser: "loadTextures" }).then((t) => {
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
