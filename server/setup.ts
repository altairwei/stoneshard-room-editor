// First-run setup support: find the user's own Stoneshard data file, run the bundled
// UTMT CLI export over it, and verify the fresh cache against the editor's pinned
// version fingerprint (extract/fingerprint.json). The asset cache is NEVER
// distributed -- every install extracts it from a legitimately owned game copy.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface WinCandidate {
  path: string;
  kind: "vallina" | "data"; // vallina.win = MSL's untouched vanilla backup (preferred)
  source: "steam" | "config";
}

// MSL patches data.win in place and keeps the pristine original as vallina.win, so a
// vallina.win is always preferred; a lone data.win means MSL never ran on this
// machine and the file is still vanilla.
export function detectVanillaWins(extra: (string | undefined)[] = []): WinCandidate[] {
  const out: WinCandidate[] = [];
  const seen = new Set<string>();
  const add = (p: string, kind: WinCandidate["kind"], source: WinCandidate["source"]) => {
    const key = p.toLowerCase();
    if (seen.has(key) || !fs.existsSync(p)) return;
    seen.add(key);
    out.push({ path: p, kind, source });
  };
  for (const lib of steamLibraries()) {
    const dir = path.join(lib, "steamapps", "common", "Stoneshard");
    add(path.join(dir, "vallina.win"), "vallina", "steam");
    add(path.join(dir, "data.win"), "data", "steam");
  }
  for (const p of extra)
    if (p) add(p, path.basename(p).toLowerCase().startsWith("vallina") ? "vallina" : "data", "config");
  return out;
}

// every Steam library folder: the main install plus whatever libraryfolders.vdf lists
function steamLibraries(): string[] {
  const roots: string[] = [];
  const push = (p: string) => {
    if (p && !roots.includes(p)) roots.push(p);
  };
  for (const steam of [...steamInstallPaths(), process.env.STEAM_PATH, "C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"]) {
    if (!steam || !fs.existsSync(steam)) continue;
    push(steam);
    for (const vdf of [path.join(steam, "config", "libraryfolders.vdf"), path.join(steam, "steamapps", "libraryfolders.vdf")]) {
      if (!fs.existsSync(vdf)) continue;
      try {
        for (const m of fs.readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) push(m[1].replace(/\\\\/g, "\\"));
      } catch {
        /* a malformed vdf just means no extra libraries */
      }
    }
  }
  return roots;
}

// Steam is routinely installed off-C: (D:\Games\Steam ...), which no static path list
// can guess -- the registry is the source of truth on Windows
function steamInstallPaths(): string[] {
  const out: string[] = [];
  if (process.platform !== "win32") return out;
  for (const [key, value] of [
    ["HKCU\\Software\\Valve\\Steam", "SteamPath"],
    ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"],
  ] as const) {
    try {
      const text = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = /REG_SZ\s+(\S[^\r\n]*)/.exec(text);
      if (m) out.push(m[1].trim());
    } catch {
      /* key absent */
    }
  }
  return out;
}

export interface Fingerprint {
  game: string; // display label, only meaningful in the bundled expected fingerprint
  objects: number;
  sprites: number;
  rooms: number;
  indexSha256: string; // sha256 of rooms/_index.json -- catches any room content drift
}

export function fingerprintCache(assetsDir: string): Fingerprint {
  const j = (f: string) => JSON.parse(fs.readFileSync(path.join(assetsDir, f), "utf8"));
  return {
    game: "",
    objects: Object.keys(j("objects.json")).length,
    sprites: Object.keys(j("sprites.json")).length,
    rooms: j("rooms.json").length,
    indexSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(assetsDir, "rooms", "_index.json"))).digest("hex"),
  };
}

export function loadExpectedFingerprint(root: string): Fingerprint | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "extract", "fingerprint.json"), "utf8")) as Fingerprint;
  } catch {
    return null;
  }
}

export function fingerprintMismatches(expected: Fingerprint, got: Fingerprint): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: number | string, b: number | string) => {
    if (a !== b) out.push(`${label}：应为 ${a}，实为 ${b}`);
  };
  cmp("对象数", expected.objects, got.objects);
  cmp("sprite 数", expected.sprites, got.sprites);
  cmp("房间数", expected.rooms, got.rooms);
  cmp("房间索引哈希", expected.indexSha256.slice(0, 12), got.indexSha256.slice(0, 12));
  return out;
}

export interface ExtractProgress {
  phase: "assets" | "rooms" | "check" | "done" | "error";
  line?: string;
}

export interface ExtractResult {
  ok: boolean;
  mismatches: string[];
  error?: string;
}

// node fs reads inside app.asar transparently, but a spawned child process needs a
// real file -- electron-builder puts asarUnpack entries in app.asar.unpacked
export const unpackedPath = (p: string) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

export function resolveUtmtCli(cfgPath: string | undefined, root: string): string | null {
  for (const p of [cfgPath, path.join(root, "vendor", "utmt", "UndertaleModCli.exe")])
    if (p && fs.existsSync(unpackedPath(p))) return unpackedPath(p);
  return null;
}

// One UTMT CLI load running both export scripts (a single parse of the 1.5 GB file).
// Each script needs its OWN -s flag: despite the help text's "Ex. a.csx b.csx", the
// CLI rejects a second bare argument. stdin stays closed -- UTMT waits on it and hangs
// otherwise. The phase flips to "rooms" when the first script's summary line appears.
export function runExtract(opts: {
  utmtCli: string;
  vanillaWin: string;
  assetsDir: string;
  scripts: string[];
  expected: Fingerprint | null;
  onProgress: (p: ExtractProgress) => void;
}): { promise: Promise<ExtractResult>; child: ChildProcess } {
  fs.mkdirSync(opts.assetsDir, { recursive: true });
  const child = spawn(opts.utmtCli, ["load", opts.vanillaWin, ...opts.scripts.flatMap((s) => ["-s", unpackedPath(s)])], {
    env: { ...process.env, SVRE_OUT: opts.assetsDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let phase: ExtractProgress["phase"] = "assets";
  const pump = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (line.includes("objects=")) phase = "rooms"; // script 1 printed its summary
      opts.onProgress({ phase, line: line.slice(0, 400) });
    }
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  const promise = new Promise<ExtractResult>((resolve) => {
    child.on("error", (e) => resolve({ ok: false, mismatches: [], error: `启动 UTMT CLI 失败：${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, mismatches: [], error: `UTMT CLI 退出码 ${code}` });
      try {
        opts.onProgress({ phase: "check" });
        const got = fingerprintCache(opts.assetsDir);
        resolve({ ok: true, mismatches: opts.expected ? fingerprintMismatches(opts.expected, got) : [] });
      } catch (e) {
        resolve({ ok: false, mismatches: [], error: `提取后校验失败：${(e as Error).message}` });
      }
    });
  });
  return { promise, child };
}
