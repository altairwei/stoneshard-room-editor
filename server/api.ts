// Dev-server middleware: the HTTP face of the Store (server/store.ts), shared by the
// browser and the `svre` CLI. Events (who changed what) go out on Vite's websocket as
// the custom event "svre:event"; the CLI polls /changes instead.
//
//   GET  /api/rooms                         every room: project? compiled? dirty? drift?
//   GET  /api/diagnostics                   one pass over the project: every room's lint findings
//                                           + project-level warnings (assets.json, Codes/ collisions)
//   GET  /api/vanilla?q=                    search vanilla rooms (bases)
//   GET  /api/vanilla-doc/<room>            a vanilla cache room for read-only viewing (no project)
//   POST /api/import      {name, base?, by?} project from an existing Codes/<name>.gml
//   POST /api/create      {name, base, keep?, by?}  new room on a vanilla base
//   GET  /api/doc/<room>                    full state: room JSON, log summary, notes, selections
//   POST /api/doc/<room>/apply   {by, label?, note?, ops}
//   POST /api/doc/<room>/undo    {by}        /redo {by}
//   GET  /api/doc/<room>/changes?since=N
//   POST /api/doc/<room>/compile {force?}    write rooms/<room>.compiled.json + regenerate <Mod>.Rooms.g.cs
//   POST /api/doc/<room>/adopt   {by?}       log an outside edit of rooms/<room>.compiled.json
//   GET  /api/doc/<room>/describe | lint | grid?region= | query?id=&object=&layer=&rect=&cell=
//   POST /api/doc/<room>/notes   {by, x, y, text} | {remove}
//   GET|POST /api/doc/<room>/selection  {by, ids}
//   GET  /assets/<path>                     the extracted asset cache (vanilla, from data.win)
//   GET  /api/mod-assets                    the mod's own sprites/objects (Sprites/*.png + assets.json)
//   POST /api/mod-assets/sync               rescan + rewrite <Mod>.Assets.g.cs if it disagrees
//   GET  /mod-assets/pages/<i>.png          one mod sprite frame (pseudo pages, see modassets.ts)
//   GET  /api/setup                         first-run state: reasons, detected game installs, fingerprint
//   POST /api/setup/moddir   {path?}        create the workdir skeleton + persist the choice
//   POST /api/setup/extract  {vanillaWin}   run the bundled UTMT CLI export -> cache (SSE progress)
//   POST /api/setup/create   {sourceDir} | {skip}
//                                           scan decompiled GML -> create.json (the depth facts
//                                           data.win does not hold); skip writes an empty table
//   POST /api/setup/restart                 ask for another wizard round (a game update changed
//                                           the data file); deletes nothing up front
//   POST /api/setup/utmt                    download the pinned UTMT CLI release into the
//                                           install dir (an install that has none: a clone
//                                           without vendor/, a build made without the vendor step)
// With no config/cache (a fresh packaged install) the API is degraded: every route but
// /api/config and /api/setup/* 503s, the page shows the setup wizard, and boot() runs
// again when the wizard fixes each piece -- no restart.
import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { generatedCsPath, loadManifest, pngSizeBuffer, saveManifest, scanModAssets, type ModAssets, type VanillaNames } from "./modassets.ts";
import {
  addRecent,
  ensureSkeleton,
  forgetRecent,
  listRecent,
  looksLikeModDir,
  seedRecent,
  validateProjectPath,
  validModName,
  type RecentProject,
} from "./projects.ts";
import {
  countGmlSource,
  detectVanillaWins,
  installUtmt,
  loadExpectedFingerprint,
  resolveUtmtCli,
  runCreateScan,
  runExtract,
  unpackedPath,
  utmtInstallDir,
  UTMT_MARKER,
  UTMT_RELEASE,
} from "./setup.ts";
import { HttpError, Store } from "./store.ts";

export interface SvreConfig {
  // the open project: a mod's source directory. "" = no project open, which is a normal
  // state (the welcome page), not a broken one -- see setupState()'s `mode`.
  modDir: string;
  assetsDir: string;
  sourceDir: string;
  vanillaWin: string;
  utmtCli: string;
  recent: RecentProject[]; // the welcome page's shortlist, newest first
}

export interface LoadedConfig {
  cfg: SvreConfig;
  file: string | null; // the config json actually read; null = packaged defaults, nothing on disk yet
}

// Config search order: SVRE_CONFIG (tests) -> <home>/svre.config.json (packaged app)
// -> <root>/svre.config.json (+ svre.config.local.json, dev). `home` is the packaged
// install's writable profile dir (electron userData); with no config anywhere it also
// supplies the defaults so the first-run wizard has somewhere to put the cache.
export function loadConfig(root: string, home?: string): LoadedConfig {
  const rootFile = path.join(root, "svre.config.json");
  const localFile = path.join(root, "svre.config.local.json");
  let file: string | null = null;
  if (process.env.SVRE_CONFIG) file = process.env.SVRE_CONFIG;
  else if (home && fs.existsSync(path.join(home, "svre.config.json"))) file = path.join(home, "svre.config.json");
  else if (fs.existsSync(rootFile)) file = rootFile;
  // a dev clone that deleted the committed config keeps working off the override alone
  // (it is also the file persistConfig writes to, so what is written is what is read)
  else if (!home && fs.existsSync(localFile)) file = localFile;
  if (!file && !home) throw new Error(`no svre.config.json in ${root}`);
  const base: Record<string, unknown> = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  // the local override only merges over the REPO config (dev-machine secrets); a
  // packaged install has exactly one writable config -- its home one
  if (!process.env.SVRE_CONFIG && file === rootFile && fs.existsSync(localFile))
    Object.assign(base, JSON.parse(fs.readFileSync(localFile, "utf8")));
  const cfg = base as Partial<SvreConfig>;
  if (home) {
    // no workdir default: "no project open" is a real state (the welcome page), so the
    // app never invents a folder to be the project. Machine-level paths still default.
    cfg.modDir ||= "";
    cfg.assetsDir ||= path.join(home, "cache", "assets");
    cfg.sourceDir ||= "";
    cfg.vanillaWin ||= "";
    cfg.utmtCli ||= "";
  }
  // relative config paths resolve against the config file's own directory, so
  // renaming the editor folder (or moving a workdir) never breaks them
  const anchor = file ? path.dirname(file) : (home ?? root);
  for (const key of ["modDir", "assetsDir", "sourceDir", "vanillaWin", "utmtCli"] as const)
    if (cfg[key] && !path.isAbsolute(cfg[key])) cfg[key] = path.resolve(anchor, cfg[key]);
  cfg.recent = listRecent(base.recent, anchor);
  // tests point a second server at a scratch copy, never at the real mod or cache
  if (process.env.SVRE_MOD_DIR) cfg.modDir = process.env.SVRE_MOD_DIR;
  if (process.env.SVRE_ASSETS_DIR) cfg.assetsDir = process.env.SVRE_ASSETS_DIR;
  return { cfg: cfg as SvreConfig, file };
}

const MIME: Record<string, string> = { ".png": "image/png", ".json": "application/json", ".webp": "image/webp" };

function send(res: any, status: number, body: unknown, type = "application/json") {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readJson(req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const s = Buffer.concat(chunks).toString("utf8");
      try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new HttpError(400, "body is not JSON")); }
    });
    req.on("error", reject);
  });
}

export interface SvreApi {
  // live view of the config as boot() last loaded it (a plain property would freeze the
  // object from before the first project switch)
  readonly cfg: SvreConfig;
  handler: Connect.NextHandleFunction;
  // store events (who changed what); vite wires this to its ws, the standalone
  // server to its SSE channel
  setEmit: (cb: (e: Record<string, unknown>) => void) => void;
}

export function createApi(root: string, opts: { home?: string } = {}): SvreApi {
  let cfg: SvreConfig = { modDir: "", assetsDir: "", sourceDir: "", vanillaWin: "", utmtCli: "", recent: [] };
  let configFile: string | null = null;
  // bumped by boot(); a request that awaits before touching the store must re-check it
  // (see the note above the request handler)
  let bootGen = 0;
  let emit: (e: Record<string, unknown>) => void = () => {};
  let store: Store | null = null;
  // vanilla name pools, for manifest validation (object sprites/parents may be vanilla)
  let vanillaNames: VanillaNames = { objects: new Set(), sprites: new Set() };
  // the page index a client got from /api/mod-assets must stay valid for the session,
  // so pages are served from the last scan the client could have seen
  let modScan: ModAssets = { sprites: {}, objects: {}, pages: [], warnings: [], synced: false };
  // what the MACHINE still needs ("config" | "cache" | "create"). Whether a project is
  // open is the other axis -- see mode() -- because having no project is a normal state,
  // not a defect to be fixed, and the two need different screens.
  let setupReasons: string[] = [];
  // the user asked for another round (菜单「本机设置…」 forced re-run, i.e. the game was updated).
  // Nothing on disk is touched -- the old cache has to keep working until a new extract
  // lands -- but the backend goes degraded right away so the wizard owns the app meanwhile.
  let setupForced = false;
  const extractState = { running: false };
  // the UTMT CLI download: its own flag, so the run panel's "running" and the 409s stay
  // honest about which long job is actually under way
  const utmtState = { running: false };

  // ---------------- the project axis ----------------
  // The open project, as it stands on disk right now (exists is re-checked per call: the
  // folder can be moved or deleted under a running app).
  const project = () => {
    if (!cfg.modDir) return null;
    const p = path.resolve(cfg.modDir);
    let exists = false;
    try {
      exists = fs.statSync(p).isDirectory();
    } catch {
      /* gone, or not a directory any more */
    }
    return { path: p, name: path.basename(p), exists };
  };
  // welcome = nothing open; setup = machine not ready; ready = the editor has both
  const modeOf = (p: ReturnType<typeof project>): "welcome" | "setup" | "ready" =>
    !p || !p.exists ? "welcome" : setupReasons.length > 0 || setupForced ? "setup" : "ready";
  const degraded = () => modeOf(project()) !== "ready";
  // remember a project the user actually opened (a fresh timestamp, moved to the front)
  const rememberProject = (dir: string, recent: RecentProject[]) => {
    cfg.recent = recent;
    persistConfig({ modDir: dir, recent });
  };
  // the recent list, with each entry's existence resolved live (a deleted/moved folder
  // stays listed -- greyed out and removable -- instead of vanishing under the user)
  const projectsState = () => ({
    current: project(),
    recent: cfg.recent.map((r) => {
      let exists = false;
      try {
        exists = fs.statSync(r.path).isDirectory();
      } catch {
        /* gone */
      }
      return { ...r, exists };
    }),
  });
  // boot()'s seeding: an install from before the recent list has only modDir to go on, and
  // must still appear in the welcome list -- with its old timestamp, so a plain start does
  // not churn the config file
  const seedProject = (dir: string) => {
    const next = seedRecent(cfg.recent, dir, new Date().toISOString());
    if (next === cfg.recent) return;
    cfg.recent = next;
    try {
      persistConfig({ recent: next });
    } catch (e) {
      console.warn(`最近打开列表写入失败：${(e as Error).message}`); // never fatal for boot
    }
  };

  // (re)initialise everything that depends on config and cache. Runs at startup and
  // again after the wizard fixes what was missing -- no process restart needed.
  const boot = () => {
    bootGen++;
    setupForced = false; // any completed step is a wizard round under way; boot() ends it
    setupReasons = [];
    let loaded: LoadedConfig;
    try {
      loaded = loadConfig(root, opts.home);
    } catch {
      setupReasons.push("config");
      store = null;
      return;
    }
    cfg = loaded.cfg;
    configFile = loaded.file;
    if (!cfg.assetsDir || !fs.existsSync(path.join(cfg.assetsDir, "objects.json"))) setupReasons.push("cache");
    else if (!fs.existsSync(path.join(cfg.assetsDir, "create.json"))) setupReasons.push("create");
    const p = project();
    if (p?.exists) seedProject(p.path);
    if (setupReasons.length || !p?.exists) {
      store = null; // nothing may serve a previous project's documents from here on
      return; // degraded: only /api/config, /api/setup* and /api/projects* answer
    }
    store = new Store(cfg, (e) => emit({ ...e, at: new Date().toISOString() }));
    vanillaNames = {
      objects: new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(cfg.assetsDir, "objects.json"), "utf8")))),
      sprites: new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(cfg.assetsDir, "sprites.json"), "utf8")))),
    };
    modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
    // <Mod>.Rooms.g.cs self-heals from the compiled snapshots at startup (and on every
    // compile/import/adopt from inside store.ts); a drifted snapshot blocks the regen
    // instead of being laundered into the build
    const csHeal = store.syncRoomsCs();
    if (csHeal.skipped.length) console.warn(`Rooms.g.cs NOT regenerated: drifted snapshots: ${csHeal.skipped.join(", ")}`);
    else if (csHeal.synced) console.log(`Rooms.g.cs regenerated (${csHeal.rooms.length} rooms)`);
  };
  boot();

  // Config writes never touch the committed repo file: overrides land in the
  // gitignored local file (dev) or the packaged install's single home config.
  const persistConfig = (patch: Record<string, unknown>) => {
    const rootFile = path.join(root, "svre.config.json");
    const target =
      process.env.SVRE_CONFIG ??
      (configFile && configFile !== rootFile ? configFile : null) ?? // SVRE_CONFIG | home | local
      (configFile === rootFile ? path.join(root, "svre.config.local.json") : null) ?? // repo config: write beside it
      (opts.home ? path.join(opts.home, "svre.config.json") : null) ??
      // nothing on disk at all (a dev clone with no config): the local file, which
      // loadConfig reads when the repo config is absent
      path.join(root, "svre.config.local.json");
    if (!target) throw new HttpError(500, "没有可写的配置位置");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const cur = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
    fs.writeFileSync(target, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  };

  // the CLI the export runs on, and where a fetched one would go: a fresh clone has no
  // vendor/utmt (gitignored), and then the wizard's extract step cannot run at all
  const utmtStatus = () => {
    const dir = utmtInstallDir(root, opts.home);
    let marker: { version?: unknown } = {};
    try {
      marker = JSON.parse(fs.readFileSync(path.join(dir, UTMT_MARKER), "utf8"));
    } catch {
      /* not installed by us -- a vendored or hand-placed copy has no marker */
    }
    return {
      cli: resolveUtmtCli(cfg.utmtCli, root, opts.home),
      dir,
      installed: fs.existsSync(path.join(dir, UTMT_RELEASE.exe)),
      version: typeof marker.version === "string" ? marker.version : null,
      running: utmtState.running,
      release: { version: UTMT_RELEASE.version, url: UTMT_RELEASE.url, bytes: UTMT_RELEASE.bytes },
    };
  };

  // The client's single source of routing truth: `mode` picks the screen (welcome page /
  // machine-setup dialog / editor), `reasons` says which machine pieces are missing,
  // `project` describes the open project. Computed here so no client re-derives it.
  const setupState = () => ({
    mode: modeOf(project()),
    reasons: [...setupReasons],
    project: project(),
    // a re-run the user asked for with nothing actually missing: the wizard still starts at
    // the data file, since that is what a game update changes
    forced: setupForced,
    running: extractState.running,
    current: { modDir: cfg.modDir, assetsDir: cfg.assetsDir, vanillaWin: cfg.vanillaWin, sourceDir: cfg.sourceDir },
    // whether the remembered source tree still looks like one, so the wizard can say so
    sourceGml: countGmlSource(cfg.sourceDir),
    detected: detectVanillaWins([cfg.vanillaWin]),
    utmtCli: resolveUtmtCli(cfg.utmtCli, root, opts.home),
    utmt: utmtStatus(),
    expected: loadExpectedFingerprint(root),
  });

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const [rawPath, qs] = (req.url ?? "").split("?");
    const url = decodeURIComponent(rawPath);
    const q = Object.fromEntries(new URLSearchParams(qs ?? ""));
    const method = req.method ?? "GET";
    try {
      if (url === "/api/config") return send(res, 200, cfg);
      // -------- what answers in degraded mode: /api/setup*, /api/projects*, /api/config --------
      if (url === "/api/setup" && method === "GET") return send(res, 200, setupState());
      // -------- projects: opening one IS switching the app's working directory --------
      if (url === "/api/projects" && method === "GET")
        return send(res, 200, { current: project(), recent: projectsState().recent });
      if (url === "/api/projects/open" && method === "POST") {
        // the two long jobs own the cache for their whole run; switching under them would
        // leave them writing into a project the user has left
        if (extractState.running) throw new HttpError(409, "资产提取正在进行中，稍候再切换项目");
        if (utmtState.running) throw new HttpError(409, "UTMT CLI 正在下载安装中，稍候再切换项目");
        const b = await readJson(req);
        const { dir } = validateProjectPath(String(b.path ?? ""));
        const bad = validModName(dir);
        if (bad) throw new HttpError(400, bad); // no override: this one would not compile
        // Not a mod tree: worth one confirmation (the open fills in a skeleton), never a
        // refusal -- the user may be starting a project MSL has not created yet.
        const unfamiliar = !looksLikeModDir(dir);
        if (unfamiliar && !b.force)
          throw new HttpError(
            409,
            `${dir} 看起来不是 mod 源码目录（没有 Codes/、Sprites/、assets.json 或 *.csproj）。\n\n照常打开：会补上编辑器需要的骨架（rooms/、Sprites/、Codes/、assets.json），mod 本身仍由 MSL 创建。`,
            { code: "unfamiliar", path: dir },
          );
        const made = ensureSkeleton(dir);
        rememberProject(dir, addRecent(cfg.recent, dir, new Date().toISOString()));
        boot(); // full rebuild: new Store, vanilla pools, mod scan, .g.cs self-heal
        // every client re-reads from scratch: the page index a client holds for
        // /mod-assets/pages/<i>.png only means anything for THIS project's scan
        emit({ type: "project", mode: modeOf(project()), project: project() });
        return send(res, 200, { ok: true, project: project(), created: made, setup: setupState() });
      }
      if (url === "/api/projects/close" && method === "POST") {
        // same two guards as 打开项目: leaving a project mid-job is the same hazard as
        // arriving at one (the job writes into the project it was started on)
        if (extractState.running) throw new HttpError(409, "资产提取正在进行中，稍候再关闭项目");
        if (utmtState.running) throw new HttpError(409, "UTMT CLI 正在下载安装中，稍候再关闭项目");
        // the closing project stays in the recent list (boot() seeded it): 关闭项目 means
        // "back to the welcome page", not "forget this project"
        persistConfig({ modDir: "", recent: cfg.recent });
        boot(); // no project: welcome mode, nothing else changes
        emit({ type: "project", mode: modeOf(project()), project: project() });
        return send(res, 200, { ok: true, setup: setupState() });
      }
      if (url === "/api/projects/forget" && method === "POST") {
        const b = await readJson(req);
        cfg.recent = forgetRecent(cfg.recent, String(b.path ?? ""));
        persistConfig({ recent: cfg.recent }); // list-only: never reboots the project
        return send(res, 200, { ok: true, recent: cfg.recent });
      }
      if (url === "/api/setup/extract" && method === "POST") {
        if (extractState.running) throw new HttpError(409, "提取正在进行中");
        const b = await readJson(req);
        const win = path.resolve(String(b.vanillaWin ?? ""));
        if (!fs.existsSync(win) || !/\.win$/i.test(win)) throw new HttpError(400, `找不到数据文件：${win}`);
        const mb = fs.statSync(win).size / 1048576;
        if (mb < 64) throw new HttpError(400, `文件只有 ${mb.toFixed(1)} MB，不像 Stoneshard 的 data.win（正常约 1.5 GB）`);
        if (utmtState.running) throw new HttpError(409, "UTMT CLI 正在下载安装中，稍候再提取");
        const utmt = resolveUtmtCli(cfg.utmtCli, root, opts.home);
        if (!utmt)
          throw new HttpError(
            400,
            `找不到 ${UTMT_RELEASE.exe}：用向导里的「下载并安装 UTMT CLI」，或在配置 utmtCli 指向自己的安装、放一份到 vendor/utmt/`,
          );
        const scripts = [path.join(root, "extract", "ExportEditorAssets.csx"), path.join(root, "extract", "ExportRooms.csx")];
        for (const s of scripts) if (!fs.existsSync(unpackedPath(s))) throw new HttpError(500, `缺导出脚本 ${s}`);
        extractState.running = true;
        emit({ type: "setup", phase: "assets", line: `${path.basename(utmt)} load ${win}` });
        runExtract({
          utmtCli: utmt,
          vanillaWin: win,
          assetsDir: cfg.assetsDir,
          scripts,
          expected: loadExpectedFingerprint(root),
          onProgress: (p) => emit({ type: "setup", ...p }),
        }).promise.then((r) => {
          extractState.running = false;
          if (!r.ok) return emit({ type: "setup", phase: "error", detail: r.error, job: "extract" });
          try {
            persistConfig({ vanillaWin: win });
            // a menu-requested round means a game update: the source scan is version-specific
            // too, so the old create.json goes with the cache it described. boot() then owes
            // step 4 again instead of quietly serving stale depth facts.
            if (setupForced && cfg.assetsDir) fs.rmSync(path.join(cfg.assetsDir, "create.json"), { force: true });
            boot(); // pick up the fresh cache; healthy mode on
            emit({ type: "setup", phase: "done", mismatches: r.mismatches, job: "extract" });
          } catch (e) {
            emit({ type: "setup", phase: "error", detail: (e as Error).message });
          }
        });
        return send(res, 202, { ok: true });
      }
      // create.json is the one cache file the export cannot produce (the depth/visible/draw
      // facts live in the objects' GML, not in the data file): scan a decompiled source tree
      // for it, or accept the fallback. Either way the cache is then complete and boot()
      // leaves degraded mode.
      if (url === "/api/setup/create" && method === "POST") {
        if (extractState.running) throw new HttpError(409, "提取正在进行中");
        const b = await readJson(req);
        const createFile = path.join(cfg.assetsDir, "create.json");
        if (b.skip) {
          fs.mkdirSync(cfg.assetsDir, { recursive: true });
          fs.writeFileSync(createFile, "{}\n"); // the client warns on boot; delete it to redo this step
          boot();
          return send(res, 200, { ok: true, skipped: true, setup: setupState() });
        }
        const src = path.resolve(String(b.sourceDir ?? ""));
        const gml = countGmlSource(src);
        if (!gml)
          throw new HttpError(400, `${src} 里没有 gml_Object_*.gml：用 UTMT「Decompile all code」导出源码（或整包反编译），再指向那个目录`);
        extractState.running = true;
        persistConfig({ sourceDir: src }); // remembered for the next game update
        emit({ type: "setup", phase: "create", line: `scan-create.mjs ${src}（${gml} 个对象事件文件）` });
        runCreateScan({
          srcDir: src,
          assetsDir: cfg.assetsDir,
          root,
          expected: loadExpectedFingerprint(root),
          onProgress: (p) => emit({ type: "setup", ...p }),
        }).promise.then((r) => {
          extractState.running = false;
          if (!r.ok) return emit({ type: "setup", phase: "error", detail: r.error, job: "create" });
          try {
            boot(); // create.json is there: healthy mode on
            emit({ type: "setup", phase: "done", mismatches: r.mismatches, count: r.count, job: "create" });
          } catch (e) {
            emit({ type: "setup", phase: "error", detail: (e as Error).message });
          }
        });
        return send(res, 202, { ok: true });
      }
      // Another wizard round on a working install: the game was updated, so the cache and the
      // depth facts have to be rebuilt from the new files. /api/setup/restart only flips the
      // backend back to degraded -- the cache on disk stays until a fresh extract succeeds,
      // so an abandoned or failed round costs the user nothing.
      if (url === "/api/setup/restart" && method === "POST") {
        if (extractState.running) throw new HttpError(409, "提取正在进行中");
        setupForced = true;
        return send(res, 200, { ok: true, setup: setupState() });
      }
      // The export cannot run without the CLI, and an install that has none has no way to
      // get one short of knowing about a GitHub release. Fetch it here instead: the pinned
      // release lands in utmtInstallDir, where resolveUtmtCli then finds it.
      if (url === "/api/setup/utmt" && method === "POST") {
        if (extractState.running) throw new HttpError(409, "提取正在进行中");
        if (utmtState.running) throw new HttpError(409, "UTMT CLI 正在下载安装中");
        const dest = utmtInstallDir(root, opts.home);
        // SVRE_UTMT_URL: the e2e points this at a local zip; it is also how a mirror (or a
        // locally downloaded copy) is used when github.com is unreachable. A test zip has
        // its own size, so the release's byte count is only checked for the release itself.
        const srcUrl = process.env.SVRE_UTMT_URL || UTMT_RELEASE.url;
        const expectBytes = process.env.SVRE_UTMT_URL ? 0 : UTMT_RELEASE.bytes;
        utmtState.running = true;
        emit({ type: "setup", job: "utmt", phase: "download", line: `下载 UTMT CLI v${UTMT_RELEASE.version}（${srcUrl}）` });
        void installUtmt({ dest, url: srcUrl, expectBytes, onProgress: (p) => emit({ type: "setup", job: "utmt", ...p }) })
          .then((r) => {
            utmtState.running = false;
            if (!r.ok) return emit({ type: "setup", job: "utmt", phase: "error", detail: r.error });
            emit({ type: "setup", job: "utmt", phase: "done", line: `✓ UTMT CLI v${r.version} → ${dest}` });
          })
          .catch((e) => {
            utmtState.running = false;
            emit({ type: "setup", job: "utmt", phase: "error", detail: (e as Error).message });
          });
        return send(res, 202, { ok: true, dest });
      }
      // The gate. The body carries the routing state so a client that hits this can send
      // itself to the right screen without a second round trip.
      if (degraded() && url.startsWith("/api/")) {
        const st = setupState();
        return send(res, 503, { error: "还没有打开项目，或本机设置未完成", setup: true, mode: st.mode, project: st.project });
      }
      // Requests that await before touching the store must re-read it afterwards: a
      // concurrent /api/projects/open|close runs boot() synchronously and rebinds the
      // module-level store/cfg/vanillaNames. Today the only such routes dereference
      // `store` AFTER their readJson, which leaves no window at all. A future route that
      // must await first should capture `const gen = bootGen` up front and refuse with a
      // 409 when it no longer matches.
      if (url === "/api/rooms") return send(res, 200, store!.listRooms());
      // every room's findings + the project-level warnings, in one pass. Read-only: the
      // asset scan runs with write:false so a GET never rewrites <Mod>.Assets.g.cs, and it
      // deliberately does NOT assign the module-level modScan -- that variable's `pages`
      // array is the contract behind /mod-assets/pages/<i>.png and may only move when the
      // client can re-read it.
      if (url === "/api/diagnostics") {
        const scan = scanModAssets(cfg.modDir, { vanilla: vanillaNames, write: false });
        return send(res, 200, store!.diagnostics({
          projectWarnings: scan.warnings.map((message) => ({ code: "assets" as const, level: "warn" as const, message })),
        }));
      }
      if (url === "/api/vanilla") return send(res, 200, store!.searchVanilla(q.q ?? ""));
      const vd = /^\/api\/vanilla-doc\/([A-Za-z0-9_]+)$/.exec(url);
      if (vd && method === "GET") return send(res, 200, store!.vanillaDoc(vd[1]));
      if (url === "/api/mod-assets") {
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        return send(res, 200, { sprites: modScan.sprites, objects: modScan.objects, pages: modScan.pages.length, warnings: modScan.warnings, synced: modScan.synced });
      }
      if (url === "/api/mod-assets/sync" && method === "POST") {
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        return send(res, 200, { file: path.basename(generatedCsPath(cfg.modDir)), warnings: modScan.warnings, synced: modScan.synced });
      }
      // the artist flow: draw PNG(s) -> register sprite+object -> place. Writes
      // Sprites/*.png, extends assets.json, then the usual scan self-heals the .g.cs
      if (url === "/api/mod-assets/import-sprite" && method === "POST") {
        const b = await readJson(req);
        // fresh scan first: validation must see the disk as it is, not the last GET's state
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        const ident = /^[A-Za-z_]\w*$/;
        const sprite = String(b.sprite ?? "");
        const object = String(b.object ?? "");
        if (!ident.test(sprite)) throw new HttpError(400, `sprite 名不合法（字母/数字/下划线，字母或下划线开头）：${sprite || "(空)"}`);
        if (!ident.test(object)) throw new HttpError(400, `对象名不合法：${object || "(空)"}`);
        if (vanillaNames.sprites.has(sprite)) throw new HttpError(409, `sprite ${sprite} 与原版重名，换个名字`);
        if (vanillaNames.objects.has(object)) throw new HttpError(409, `对象 ${object} 与原版重名，换个名字`);
        if (modScan.sprites[sprite]) throw new HttpError(409, `Sprites/ 里已有 ${sprite}（换图直接替换文件；加帧放 ${sprite}_N.png 后 sync）`);
        if (modScan.objects[object]) throw new HttpError(409, `assets.json 已注册对象 ${object}`);
        const frames: { buf: Buffer; w: number; h: number }[] = [];
        for (const f of Array.isArray(b.frames) ? b.frames : []) {
          const buf = Buffer.from(String((f as { data?: unknown } | null)?.data ?? ""), "base64");
          const size = pngSizeBuffer(buf);
          if (!size) throw new HttpError(400, "有文件不是合法的 PNG");
          frames.push({ buf, ...size });
        }
        if (!frames.length) throw new HttpError(400, "至少要选一帧 PNG");
        if (!frames.every((f) => f.w === frames[0].w && f.h === frames[0].h)) throw new HttpError(400, "多帧的尺寸必须一致");
        const { manifest } = loadManifest(cfg.modDir);
        const parent = b.parent ? String(b.parent) : undefined;
        if (parent && !vanillaNames.objects.has(parent) && !manifest.objects[parent])
          throw new HttpError(400, `parent ${parent} 不在原版对象表里`);
        const origin = b.origin !== undefined ? [Number(b.origin[0]), Number(b.origin[1])] as [number, number] : undefined;
        if (origin && (!Number.isFinite(origin[0]) || !Number.isFinite(origin[1]))) throw new HttpError(400, "origin 必须是两个数字");
        const note = b.note ? String(b.note) : undefined;

        const dir = path.join(cfg.modDir, "Sprites");
        fs.mkdirSync(dir, { recursive: true });
        const files: string[] = [];
        frames.forEach((f, i) => {
          const name = frames.length === 1 ? `${sprite}.png` : `${sprite}_${i}.png`;
          fs.writeFileSync(path.join(dir, name), f.buf);
          files.push(name);
        });
        if (origin) manifest.sprites[sprite] = { origin };
        manifest.objects[object] = { sprite, ...(parent ? { parent } : {}), visible: b.visible === undefined ? true : !!b.visible, ...(note ? { note } : {}) };
        saveManifest(cfg.modDir, manifest);
        modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
        emit({ type: "assets", by: String(b.by ?? "human"), sprite, object });
        return send(res, 200, { ok: true, files, warnings: modScan.warnings, synced: modScan.synced });
      }
      // Known residual: this route is not behind the gate and resolves modScan per
      // request, so an <img> issued just before a project switch can land after it and
      // return a page of the new project. Bounded and cosmetic (the switch reloads the
      // page, dropping those <img>s). The clean fix -- a scan nonce in the URL -- would
      // have to thread through src/assets.ts pageUrl() and the palette thumbnails.
      const pm = /^\/mod-assets\/pages\/(\d+)\.png$/.exec(url);
      if (pm) {
        const file = modScan.pages[Number(pm[1])];
        if (!file || !fs.existsSync(file)) return send(res, 404, "no such mod sprite page", "text/plain");
        res.setHeader("Cache-Control", "no-store"); // mod art changes while developing
        return send(res, 200, fs.readFileSync(file), "image/png");
      }
      if (url === "/api/import" && method === "POST") {
        const b = await readJson(req);
        const st = store!; // after the await: see the note above /api/rooms
        return send(res, 200, st.importRoom(b.name, { base: b.base, by: b.by }));
      }
      if (url === "/api/create" && method === "POST") {
        const b = await readJson(req);
        const st = store!;
        return send(res, 200, st.createRoom(b.name, { base: b.base, keep: b.keep, by: b.by }));
      }

      const m = /^\/api\/doc\/([A-Za-z0-9_]+)(?:\/([a-z]+))?$/.exec(url);
      if (m) {
        const [, room, action] = m;
        if (!action && method === "GET") return send(res, 200, store!.snapshot(room));
        const body = method === "POST" ? await readJson(req) : {};
        const st = store!;
        switch (action) {
          case "apply": return send(res, 200, st.apply(room, body));
          case "undo": return send(res, 200, st.undo(room, body.by));
          case "redo": return send(res, 200, st.redo(room, body.by));
          case "changes": return send(res, 200, st.changes(room, Number(q.since ?? 0)));
          case "compile":
            // compiling a room means the next pack reads it; make sure the generated
            // asset registrations are current too (self-heals when assets.json changed)
            modScan = scanModAssets(cfg.modDir, { vanilla: vanillaNames });
            return send(res, 200, st.compileRoom(room, !!body.force));
          case "adopt": return send(res, 200, st.adoptExternal(room, body.by));
          case "describe": return send(res, 200, st.describe(room));
          case "lint": return send(res, 200, st.describe(room).findings);
          case "grid": return send(res, 200, st.grid(room, q.region), "text/plain; charset=utf-8");
          case "query": return send(res, 200, st.query(room, q));
          case "notes":
            if (method !== "POST") return send(res, 200, st.snapshot(room).notes);
            return send(res, 200, body.remove ? st.removeNote(room, body.remove) : st.addNote(room, body));
          case "selection":
            if (method === "POST") return send(res, 200, st.setSelection(room, body.by, body.ids ?? []));
            return send(res, 200, st.selectionOf(room));
        }
        return send(res, 404, { error: `unknown action ${action}` });
      }

      if (url.startsWith("/assets/")) {
        const rel = path.normalize(url.slice("/assets/".length));
        const full = path.join(cfg.assetsDir, rel);
        if (!full.startsWith(path.normalize(cfg.assetsDir)) || !fs.existsSync(full))
          return send(res, 404, "asset not found -- run the extract step (README)", "text/plain");
        res.setHeader("Cache-Control", "max-age=86400");
        return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] ?? "application/octet-stream");
      }
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, detail: e.extra });
      console.error(e);
      return send(res, 500, { error: (e as Error).message });
    }
    next();
  };

  return {
    get cfg() {
      return cfg; // boot() rebinds `cfg`; a plain property would freeze the first one
    },
    handler,
    setEmit: (cb) => {
      emit = cb;
    },
  };
}

export function svreApi(root: string): Plugin {
  const { handler, setEmit } = createApi(root);
  return {
    name: "svre-api",
    configureServer(server) {
      setEmit((e) => server.ws.send("svre:event", e));
      server.middlewares.use(handler);
    },
  };
}
