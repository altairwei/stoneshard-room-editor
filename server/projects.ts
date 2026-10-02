// The project model: a mod's source tree IS the app's working directory. Everything the
// editor owns lives inside it (rooms/, Sprites/, assets.json, the generated <Mod>.*.g.cs);
// everything machine-level (the asset cache, the game data file, UTMT, the decompiled
// source tree) lives outside it, in the config, and survives a project switch untouched.
//
// This module is the one place that decides what a path may be opened as a project, and
// what an opened project gets scaffolded with. The HTTP routes in api.ts stay thin.
import fs from "node:fs";
import path from "node:path";
import { HttpError } from "./store.ts";

export interface RecentProject {
  path: string;
  name: string;
  at: string; // ISO timestamp of the last open
}

// the welcome page is a shortlist, not a history: ten entries is already more than a
// human scans without reading
export const RECENT_MAX = 10;

// `namespace <Mod>;` and `<Mod>.Rooms.g.cs` are generated from the folder name, so the
// name has to be a C# identifier (see validModName below)
const IDENT = /^[A-Za-z_]\w*$/;

// what a brand-new project starts with. The mod itself (the .cs, the .csproj, PatchMod)
// is MSL's job; this is only the skeleton the editor reads and writes.
const SKELETON_DIRS = ["rooms", "Sprites", "Codes"];
// byte-identical to the manifest the editor writes elsewhere (modassets.ts saveManifest)
const EMPTY_MANIFEST = JSON.stringify({ sprites: {}, objects: {} }, null, 2) + "\n";

const isDir = (p: string) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export const projectName = (dir: string) => path.basename(path.resolve(dir));

// Dedupe/compare key. Windows paths are case-insensitive, so `D:\Mods\X` and `d:\mods\x`
// are the same project and must not both sit in the recent list.
const key = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// A mod's folder name is not cosmetic: genRoomsCs/genAssetsCs interpolate it into
// `namespace ${modName};` and into the generated file names, and boot() writes those the
// moment a project opens. A basename that is not a C# identifier would produce a file that
// does not compile, so this is a hard precondition with no override -- unlike the
// "looks like a mod dir" check below, which the user may wave through.
export function validModName(dir: string): string | null {
  const name = projectName(dir);
  if (IDENT.test(name)) return null;
  return `「${name}」不能直接用作项目名：编辑器生成的 C#（namespace ${name}; 与 ${name}.Rooms.g.cs）要求文件夹名以字母或下划线开头、只含字母数字下划线。把文件夹改个名（例如 StoneValley）再打开。`;
}

// Fully resolve and vet a user-typed/picked path. Everything downstream (mkdir, write)
// can then assume a real directory.
export function validateProjectPath(input: string): { dir: string; name: string } {
  const raw = input.trim();
  if (!raw) throw new HttpError(400, "需要项目目录路径");
  const dir = path.resolve(raw);
  // a drive root or a UNC share root is not a project (and scaffolding one would litter
  // the volume); path.parse().root covers "D:\" and "\\server\share\"
  if (dir === path.parse(dir).root) throw new HttpError(400, `${dir} 是盘符根目录，不能作为项目目录`);
  if (!isDir(dir)) {
    if (fs.existsSync(dir)) throw new HttpError(400, `${dir} 是一个文件，不是文件夹`);
    // a path that does not exist yet is fine (新建项目): mkdirSync below creates it
  }
  const name = projectName(dir);
  if (!name) throw new HttpError(400, `${dir} 不是一个可用的项目目录`);
  return { dir, name };
}

// Does this folder look like it was already a mod source tree? Purely advisory: a "no"
// only buys the client one confirmation, it never blocks the open (the skeleton is
// filled in either way). MSL's own layout is Codes/ + *.csproj; a project this editor
// created is Codes/ + Sprites/ + assets.json.
export function looksLikeModDir(dir: string): boolean {
  if (SKELETON_DIRS.some((d) => isDir(path.join(dir, d)))) return true;
  if (fs.existsSync(path.join(dir, "assets.json"))) return true;
  try {
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith(".csproj"));
  } catch {
    return false;
  }
}

// Idempotent: opening an existing project must not touch anything, and opening a bare
// folder must leave it usable (rooms/ + assets.json are what the Store reads on boot).
export function ensureSkeleton(dir: string): string[] {
  const made: string[] = [];
  for (const d of SKELETON_DIRS) {
    const p = path.join(dir, d);
    if (isDir(p)) continue;
    fs.mkdirSync(p, { recursive: true });
    made.push(`${d}/`);
  }
  const mf = path.join(dir, "assets.json");
  if (!fs.existsSync(mf)) {
    fs.writeFileSync(mf, EMPTY_MANIFEST);
    made.push("assets.json");
  }
  return made;
}

export function listRecent(raw: unknown, anchor: string): RecentProject[] {
  const out: RecentProject[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    const p = String((e as RecentProject | null)?.path ?? "");
    if (!p) continue;
    const abs = path.isAbsolute(p) ? p : path.resolve(anchor, p);
    if (out.some((r) => key(r.path) === key(abs))) continue;
    out.push({ path: abs, name: projectName(abs), at: String((e as RecentProject).at ?? "") });
    if (out.length >= RECENT_MAX) break;
  }
  return out;
}

// Opening a project moves it to the front with a fresh timestamp.
export function addRecent(list: RecentProject[], dir: string, at: string): RecentProject[] {
  const one: RecentProject = { path: path.resolve(dir), name: projectName(dir), at };
  return [one, ...list.filter((r) => key(r.path) !== key(one.path))].slice(0, RECENT_MAX);
}

// boot()'s quieter cousin: an install that predates the recent list has only modDir to go
// on, and it must not lose its `at` (or churn the config file) on every start.
export function seedRecent(list: RecentProject[], dir: string, at: string): RecentProject[] {
  return list.some((r) => key(r.path) === key(path.resolve(dir))) ? list : addRecent(list, dir, at);
}

export function forgetRecent(list: RecentProject[], dir: string): RecentProject[] {
  return list.filter((r) => key(r.path) !== key(path.resolve(dir)));
}
