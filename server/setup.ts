// First-run setup support: find the user's own Stoneshard data file, run the bundled
// UTMT CLI export over it, and compare the fresh cache against the editor's pinned
// version fingerprint (extract/fingerprint.json). The asset cache is NEVER
// distributed -- every install extracts it from a legitimately owned game copy.
//
// The fingerprint is the DEVELOPER's reference: it is pinned so the person building the
// editor notices when the game (or the export scripts) moved. A user's install having a
// different version is normal -- Stoneshard gets updated -- so a mismatch is reported as
// information, never as a failure.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { once } from "node:events";
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
  create: number; // create.json entries -- the depth/visible/draw facts scanned from source
}

export function fingerprintCache(assetsDir: string): Fingerprint {
  const j = (f: string) => JSON.parse(fs.readFileSync(path.join(assetsDir, f), "utf8"));
  const createFile = path.join(assetsDir, "create.json");
  return {
    game: "",
    objects: Object.keys(j("objects.json")).length,
    sprites: Object.keys(j("sprites.json")).length,
    rooms: j("rooms.json").length,
    indexSha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(assetsDir, "rooms", "_index.json"))).digest("hex"),
    // absent until the source scan has run: 0, not an error -- the extract's own check
    // must not fail on a file that step cannot produce (see runCreateScan)
    create: fs.existsSync(createFile) ? Object.keys(j("create.json")).length : 0,
  };
}

export function loadExpectedFingerprint(root: string): Fingerprint | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "extract", "fingerprint.json"), "utf8")) as Fingerprint;
  } catch {
    return null;
  }
}

// The cache is built in two passes (the UTMT export, then the GML source scan), so each
// pass reports on only the fields it produced: comparing everything after the export would
// count the not-yet-scanned create.json as different and say nothing useful.
//
// A difference is not an error: the expected fingerprint is pinned by whoever builds the
// editor, and the user's game may simply be a different version. Callers report these as
// information -- the wizard lists them without calling the run a failure.
export function fingerprintMismatches(expected: Fingerprint, got: Fingerprint, only?: (keyof Fingerprint)[]): string[] {
  const out: string[] = [];
  const cmp = (label: string, a: number | string, b: number | string) => {
    if (a !== b) out.push(`${label}：应为 ${a}，实为 ${b}`);
  };
  const want = (k: keyof Fingerprint) => !only || only.includes(k);
  if (want("objects")) cmp("对象数", expected.objects, got.objects);
  if (want("sprites")) cmp("sprite 数", expected.sprites, got.sprites);
  if (want("rooms")) cmp("房间数", expected.rooms, got.rooms);
  if (want("indexSha256")) cmp("房间索引哈希", expected.indexSha256.slice(0, 12), got.indexSha256.slice(0, 12));
  if (want("create")) cmp("深度事实条目", expected.create, got.create);
  return out;
}

export interface ExtractProgress {
  phase: "assets" | "rooms" | "check" | "create" | "done" | "error";
  line?: string;
}

export interface ExtractResult {
  ok: boolean;
  mismatches: string[];
  error?: string;
  count?: number; // entries produced, when the step produces a countable artifact (create.json)
}

// node fs reads inside app.asar transparently, but a spawned child process needs a
// real file -- electron-builder puts asarUnpack entries in app.asar.unpacked
export const unpackedPath = (p: string) => p.replace(/app\.asar([\\/])/, "app.asar.unpacked$1");

// ---------- UTMT CLI: where it comes from ----------
// The export runs on UndertaleModCli. The dev flow vendors one from a local install
// (`npm run vendor:utmt`, vendor/ is gitignored) and electron-builder ships that copy
// unpacked, so a packaged install has one. A fresh clone -- or a build made without the
// vendor step -- has none and cannot extract at all, which is what installUtmt below is
// for: fetch the official release instead.
//
// Pinned, not "latest": the export scripts drive UTMT's C# script API, which moves between
// releases. This is the version the editor was tested against.
export const UTMT_RELEASE = {
  version: "0.9.2.0",
  url: "https://github.com/UnderminersTeam/UndertaleModTool/releases/download/0.9.2.0/UTMT_CLI_v0.9.2.0-Windows.zip",
  bytes: 62585935, // the release asset's size: catches a truncated download or an HTML error page
  exe: "UndertaleModCli.exe",
};
// written next to a downloaded CLI: which release it is, so the wizard can say so
export const UTMT_MARKER = "svre-utmt.json";

// Where a fetched copy lands. Packaged: the writable profile -- the app folder is replaced
// on update and may not be writable at all. Dev: the same vendor/utmt/ the vendor script
// fills, so a clone that never vendored anything gets the CLI where the docs say it lives.
// SVRE_UTMT_DIR overrides both (the e2e uses it to leave the repo's own vendor/utmt alone).
export function utmtInstallDir(root: string, home?: string): string {
  return process.env.SVRE_UTMT_DIR || (home ? path.join(home, "utmt") : path.join(root, "vendor", "utmt"));
}

// Lookup order: the user's own config, then the install directory, then the bundled copy --
// a downloaded copy wins over the bundle, since downloading one was an explicit act.
// SVRE_UTMT_DIR pins the install directory outright and nothing else is consulted, which is
// what the e2e needs: the repo's own vendor/utmt/ must not answer for a machine that has none.
export function resolveUtmtCli(cfgPath: string | undefined, root: string, home?: string): string | null {
  const dirs = process.env.SVRE_UTMT_DIR
    ? [process.env.SVRE_UTMT_DIR]
    : [utmtInstallDir(root, home), path.join(root, "vendor", "utmt")];
  const candidates = [cfgPath, ...dirs.map((d) => path.join(d, UTMT_RELEASE.exe))];
  for (const p of candidates) if (p && fs.existsSync(unpackedPath(p))) return unpackedPath(p);
  return null;
}

export interface UtmtProgress {
  phase: "download" | "unpack";
  line?: string;
  status?: string; // live one-liner (bytes / percent) -- a status, not a log line
}

export interface UtmtInstallResult {
  ok: boolean;
  cli?: string;
  version?: string;
  error?: string;
}

// Fetch a UTMT CLI release zip and put it where resolveUtmtCli looks for it. Everything is
// staged beside the target and swapped in at the end: a half-downloaded or half-extracted
// copy must never look installed, and a copy that was already there survives a failure.
export async function installUtmt(opts: {
  dest: string;
  url: string;
  expectBytes?: number;
  onProgress: (p: UtmtProgress) => void;
}): Promise<UtmtInstallResult> {
  const zip = `${opts.dest}.download.zip`;
  const stage = `${opts.dest}.unpack`;
  const old = `${opts.dest}.old`;
  try {
    // the staging files are siblings of dest, so its parent has to exist: a fresh clone has
    // no vendor/ at all, and the packaged profile may have no utmt/ yet
    fs.mkdirSync(path.dirname(opts.dest), { recursive: true });
    for (const p of [zip, stage, old]) fs.rmSync(p, { recursive: true, force: true });
    await fetchTo(opts.url, zip, opts.expectBytes ?? 0, opts.onProgress);
    opts.onProgress({ phase: "unpack" });
    fs.mkdirSync(stage, { recursive: true });
    await unzipTo(zip, stage);
    const exe = findFile(stage, UTMT_RELEASE.exe, 3);
    if (!exe) throw new Error(`压缩包里没有 ${UTMT_RELEASE.exe}：这个来源不是 UTMT CLI 的发布包？`);
    // the release zip wraps everything in UTMT_CLI_v<version>-Windows/, so install the
    // folder's CONTENTS: the flat dest/UndertaleModCli.exe layout both resolveUtmtCli and
    // `npm run vendor:utmt` produce
    const src = path.dirname(exe);
    for (const f of ["UndertaleModLib.dll", "UndertaleModCli.runtimeconfig.json"])
      if (!fs.existsSync(path.join(src, f))) throw new Error(`解压结果不像 UTMT CLI：缺 ${f}`);
    if (fs.existsSync(opts.dest)) fs.renameSync(opts.dest, old);
    try {
      fs.renameSync(src, opts.dest);
    } catch (e) {
      if (!fs.existsSync(opts.dest) && fs.existsSync(old)) fs.renameSync(old, opts.dest);
      throw e;
    }
    fs.rmSync(old, { recursive: true, force: true });
    fs.writeFileSync(
      path.join(opts.dest, UTMT_MARKER),
      JSON.stringify({ version: UTMT_RELEASE.version, url: opts.url, at: new Date().toISOString() }, null, 2) + "\n",
    );
    return { ok: true, cli: path.join(opts.dest, UTMT_RELEASE.exe), version: UTMT_RELEASE.version };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    fs.rmSync(zip, { force: true });
    fs.rmSync(stage, { recursive: true, force: true }); // what is left of it after the rename
  }
}

const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;

async function fetchTo(url: string, file: string, expectBytes: number, onProgress: (p: UtmtProgress) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText}（${url}）`);
  const total = Number(res.headers.get("content-length")) || expectBytes || 0;
  const sink = fs.createWriteStream(file);
  // a write-stream error is emitted, not thrown: without this it would take the process
  // down instead of failing the download (a full disk, a path that went away)
  const sinkError = new Promise<never>((_, reject) => sink.on("error", reject));
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), sinkError]);
      if (done) break;
      got += value.length;
      if (!sink.write(value)) await Promise.race([once(sink, "drain"), sinkError]);
      if (Date.now() - last > 400) {
        last = Date.now();
        onProgress({ phase: "download", status: `${mb(got)}${total ? ` / ${mb(total)}（${Math.round((got / total) * 100)}%）` : ""}` });
      }
    }
    await Promise.race([
      new Promise<void>((resolve, reject) => sink.end((err?: Error | null) => (err ? reject(err) : resolve()))),
      sinkError,
    ]);
  } catch (e) {
    sink.destroy();
    await reader.cancel().catch(() => {});
    throw e;
  }
  if (expectBytes && got !== expectBytes) throw new Error(`下载不完整：${got} 字节，应为 ${expectBytes}（${url}）`);
}

// Windows ships bsdtar (System32\tar.exe, 10 1803+) which reads zip natively, and every
// current macOS/Linux does: no dependency, no PowerShell, no execution policy. The
// absolute System32 path comes first because a Git-for-Windows PATH puts GNU tar there,
// and GNU tar cannot read a zip at all. Expand-Archive is the last resort -- it is slower
// and can be blocked by policy, but it is always there on Windows.
async function unzipTo(zip: string, dir: string): Promise<void> {
  const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const extract: [string, string[]] = ["tar", ["-xf", zip, "-C", dir]];
  const attempts: [string, string[]][] = [
    ...(process.env.SystemRoot ? [[path.join(process.env.SystemRoot, "System32", "tar.exe"), extract[1]] as [string, string[]]] : []),
    extract,
    ["powershell", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${psQuote(zip)} -DestinationPath ${psQuote(dir)} -Force`]],
  ];
  const why: string[] = [];
  for (const [cmd, args] of attempts) {
    try {
      const code = await spawnOnce(cmd, args);
      if (code === 0) return;
      why.push(`${path.basename(cmd)} 退出码 ${code}`);
    } catch (e) {
      why.push(`${path.basename(cmd)} 无法启动：${(e as Error).message}`);
    }
  }
  throw new Error(`解压失败（${why.join("；")}）`);
}

// resolves with the exit code; rejects only when the program itself could not be started
function spawnOnce(cmd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve, reject) => {
    // windowsHide: a console-subsystem helper must not flash a console window
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

// a release zip wraps its payload in a folder (UTMT_CLI_v<version>-Windows/), so the exe
// is a level down -- but never assume how many levels
function findFile(dir: string, name: string, depth: number): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name.toLowerCase()) return p;
    if (e.isDirectory() && depth > 0) {
      const hit = findFile(p, name, depth - 1);
      if (hit) return hit;
    }
  }
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
        // create.json is the other pass's job (runCreateScan) -- not compared here
        resolve({ ok: true, mismatches: opts.expected ? fingerprintMismatches(opts.expected, got, ["objects", "sprites", "rooms", "indexSha256"]) : [] });
      } catch (e) {
        resolve({ ok: false, mismatches: [], error: `提取后校验失败：${(e as Error).message}` });
      }
    });
  });
  return { promise, child };
}

// What extract/scan-create.mjs actually reads: UTMT's "Decompile all code" output, one
// file per object event. Counting them validates the picker's answer (a wrong folder --
// or a folder of .yy/.gml dumps from some other game -- is almost always empty) and is
// the number the wizard shows before the user commits to a scan.
const GML_OBJECT_RE = /^gml_Object_.+_(Create|Draw|Step|Alarm|Destroy)_0\.gml$/;

export function countGmlSource(dir: string | undefined): number {
  if (!dir || !fs.existsSync(dir)) return 0;
  try {
    let n = 0;
    for (const f of fs.readdirSync(dir)) if (GML_OBJECT_RE.test(f)) n++;
    return n;
  } catch {
    return 0; // unreadable (permissions/network) -- treat as "no source here"
  }
}

// create.json is the ONE cache file data.win cannot produce: it is a static scan of the
// DECOMPILED GML source (depth = -y + 18 and friends drive the game-order canvas), so the
// wizard asks for that tree instead of pretending the CLI export covered it. Takes ~15 s
// over ~27k files, but it reads the cache's objects.json -- hence: after the extract.
//
// scan-create.mjs is dependency-free node ESM, so it runs on Electron's own binary in
// node mode: a packaged install has no `node` on PATH at all. This is also why
// electron-builder ships extract/ unpacked (asarUnpack) -- a child process cannot exec
// a path inside the archive.
export function runCreateScan(opts: {
  srcDir: string;
  assetsDir: string;
  root: string;
  expected: Fingerprint | null;
  onProgress: (p: ExtractProgress) => void;
}): { promise: Promise<ExtractResult>; child: ChildProcess } {
  const script = unpackedPath(path.join(opts.root, "extract", "scan-create.mjs"));
  const child = spawn(process.execPath, [script, opts.srcDir, opts.assetsDir], {
    // node itself ignores this; electron needs it to behave as node
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pump = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      opts.onProgress({ phase: "create", line: line.slice(0, 400) });
    }
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  const promise = new Promise<ExtractResult>((resolve) => {
    child.on("error", (e) => resolve({ ok: false, mismatches: [], error: `启动源码扫描失败：${e.message}` }));
    child.on("close", (code) => {
      if (code !== 0) return resolve({ ok: false, mismatches: [], error: `源码扫描退出码 ${code}` });
      try {
        opts.onProgress({ phase: "check" });
        const got = fingerprintCache(opts.assetsDir);
        // an empty table means the scan recognised nothing: a source tree of the wrong
        // game/version, and a silent fallback is worse than refusing it here
        if (!got.create) return resolve({ ok: false, mismatches: [], error: "扫描没有产出任何深度事实：这个源码目录里没有可识别的对象事件？" });
        // ...and a wrong-but-real folder does NOT come back empty: every object that
        // inherits a Draw event still gets `draw:none` when its file cannot be read (6611
        // of them here). A genuine tree always assigns depth somewhere, so zero depth
        // facts means the files were never found.
        const facts = JSON.parse(fs.readFileSync(path.join(opts.assetsDir, "create.json"), "utf8")) as Record<string, { depth?: unknown }>;
        if (!Object.values(facts).some((f) => f.depth))
          return resolve({ ok: false, mismatches: [], error: "扫描读不到任何 depth 赋值：这个目录下的 gml_Object_*.gml 不是这个版本的源码？" });
        resolve({ ok: true, count: got.create, mismatches: opts.expected ? fingerprintMismatches(opts.expected, got, ["create"]) : [] });
      } catch (e) {
        resolve({ ok: false, mismatches: [], error: `扫描后校验失败：${(e as Error).message}` });
      }
    });
  });
  return { promise, child };
}
