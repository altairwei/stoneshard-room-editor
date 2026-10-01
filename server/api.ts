// Dev-server middleware: the HTTP face of the Store (server/store.ts), shared by the
// browser and the `svre` CLI. Events (who changed what) go out on Vite's websocket as
// the custom event "svre:event"; the CLI polls /changes instead.
//
//   GET  /api/rooms                         every room: project? compiled? dirty? drift?
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
// With no config/cache (a fresh packaged install) the API is degraded: every route but
// /api/config and /api/setup/* 503s, the page shows the setup wizard, and boot() runs
// again when the wizard fixes each piece -- no restart.
import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { generatedCsPath, loadManifest, pngSizeBuffer, saveManifest, scanModAssets, type ModAssets, type VanillaNames } from "./modassets.ts";
import { detectVanillaWins, loadExpectedFingerprint, resolveUtmtCli, runExtract, unpackedPath } from "./setup.ts";
import { HttpError, Store } from "./store.ts";

export interface SvreConfig {
  modDir: string;
  assetsDir: string;
  sourceDir: string;
  vanillaWin: string;
  utmtCli: string;
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
  let file: string | null = null;
  if (process.env.SVRE_CONFIG) file = process.env.SVRE_CONFIG;
  else if (home && fs.existsSync(path.join(home, "svre.config.json"))) file = path.join(home, "svre.config.json");
  else if (fs.existsSync(rootFile)) file = rootFile;
  if (!file && !home) throw new Error(`no svre.config.json in ${root}`);
  const base: Record<string, unknown> = file ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  // the local override only merges over the REPO config (dev-machine secrets); a
  // packaged install has exactly one writable config -- its home one
  const localFile = path.join(root, "svre.config.local.json");
  if (!process.env.SVRE_CONFIG && file === rootFile && fs.existsSync(localFile))
    Object.assign(base, JSON.parse(fs.readFileSync(localFile, "utf8")));
  const cfg = base as Partial<SvreConfig>;
  if (home) {
    cfg.modDir ||= path.join(home, "work");
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
  cfg: SvreConfig;
  handler: Connect.NextHandleFunction;
  // store events (who changed what); vite wires this to its ws, the standalone
  // server to its SSE channel
  setEmit: (cb: (e: Record<string, unknown>) => void) => void;
}

export function createApi(root: string, opts: { home?: string } = {}): SvreApi {
  let cfg: SvreConfig = { modDir: "", assetsDir: "", sourceDir: "", vanillaWin: "", utmtCli: "" };
  let configFile: string | null = null;
  let emit: (e: Record<string, unknown>) => void = () => {};
  let store: Store | null = null;
  // vanilla name pools, for manifest validation (object sprites/parents may be vanilla)
  let vanillaNames: VanillaNames = { objects: new Set(), sprites: new Set() };
  // the page index a client got from /api/mod-assets must stay valid for the session,
  // so pages are served from the last scan the client could have seen
  let modScan: ModAssets = { sprites: {}, objects: {}, pages: [], warnings: [], synced: false };
  // first-run state: what the wizard still needs to fix ("config" | "moddir" | "cache")
  let setupReasons: string[] = [];
  const extractState = { running: false };

  // (re)initialise everything that depends on config and cache. Runs at startup and
  // again after the wizard fixes what was missing -- no process restart needed.
  const boot = () => {
    setupReasons = [];
    let loaded: LoadedConfig;
    try {
      loaded = loadConfig(root, opts.home);
    } catch {
      setupReasons.push("config");
      return;
    }
    cfg = loaded.cfg;
    configFile = loaded.file;
    if (!cfg.modDir || !fs.existsSync(cfg.modDir)) setupReasons.push("moddir");
    if (!cfg.assetsDir || !fs.existsSync(path.join(cfg.assetsDir, "objects.json"))) setupReasons.push("cache");
    if (setupReasons.length) return; // degraded: only /api/setup/* answers
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
  const persistConfig = (patch: Record<string, string>) => {
    const rootFile = path.join(root, "svre.config.json");
    const target =
      process.env.SVRE_CONFIG ??
      (configFile && configFile !== rootFile ? configFile : null) ??
      (configFile === rootFile ? path.join(root, "svre.config.local.json") : null) ??
      (opts.home ? path.join(opts.home, "svre.config.json") : null);
    if (!target) throw new HttpError(500, "没有可写的配置位置");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const cur = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
    fs.writeFileSync(target, JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
  };

  const setupState = () => ({
    needed: setupReasons.length > 0,
    reasons: [...setupReasons],
    running: extractState.running,
    current: { modDir: cfg.modDir, assetsDir: cfg.assetsDir, vanillaWin: cfg.vanillaWin },
    detected: detectVanillaWins([cfg.vanillaWin]),
    utmtCli: resolveUtmtCli(cfg.utmtCli, root),
    expected: loadExpectedFingerprint(root),
  });

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const [rawPath, qs] = (req.url ?? "").split("?");
    const url = decodeURIComponent(rawPath);
    const q = Object.fromEntries(new URLSearchParams(qs ?? ""));
    const method = req.method ?? "GET";
    try {
      if (url === "/api/config") return send(res, 200, cfg);
      // -------- first-run setup wizard: the only routes that answer in degraded mode --------
      if (url === "/api/setup" && method === "GET") return send(res, 200, setupState());
      if (url === "/api/setup/moddir" && method === "POST") {
        const b = await readJson(req);
        if (!b.path && !cfg.modDir) throw new HttpError(400, "需要工作目录路径");
        const target = path.resolve(String(b.path || cfg.modDir));
        if (target === path.parse(target).root) throw new HttpError(400, "工作目录不能是盘符根目录");
        fs.mkdirSync(path.join(target, "rooms"), { recursive: true });
        const mf = path.join(target, "assets.json");
        if (!fs.existsSync(mf)) fs.writeFileSync(mf, JSON.stringify({ sprites: {}, objects: {} }, null, 2) + "\n");
        persistConfig({ modDir: target });
        boot();
        return send(res, 200, { ok: true, modDir: target, setup: setupState() });
      }
      if (url === "/api/setup/extract" && method === "POST") {
        if (extractState.running) throw new HttpError(409, "提取正在进行中");
        const b = await readJson(req);
        const win = path.resolve(String(b.vanillaWin ?? ""));
        if (!fs.existsSync(win) || !/\.win$/i.test(win)) throw new HttpError(400, `找不到数据文件：${win}`);
        const mb = fs.statSync(win).size / 1048576;
        if (mb < 64) throw new HttpError(400, `文件只有 ${mb.toFixed(1)} MB，不像 Stoneshard 的 data.win（正常约 1.5 GB）`);
        const utmt = resolveUtmtCli(cfg.utmtCli, root);
        if (!utmt) throw new HttpError(400, "找不到 UndertaleModCli.exe（配置 utmtCli，或随包 vendor/utmt/ 缺失）");
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
          if (!r.ok) return emit({ type: "setup", phase: "error", detail: r.error });
          try {
            persistConfig({ vanillaWin: win });
            boot(); // pick up the fresh cache; healthy mode on
            emit({ type: "setup", phase: "done", mismatches: r.mismatches });
          } catch (e) {
            emit({ type: "setup", phase: "error", detail: (e as Error).message });
          }
        });
        return send(res, 202, { ok: true });
      }
      if (setupReasons.length && url.startsWith("/api/"))
        return send(res, 503, { error: "首次运行设置未完成，请先走 /api/setup 向导", setup: true });
      const st = store!;
      if (url === "/api/rooms") return send(res, 200, st.listRooms());
      if (url === "/api/vanilla") return send(res, 200, st.searchVanilla(q.q ?? ""));
      const vd = /^\/api\/vanilla-doc\/([A-Za-z0-9_]+)$/.exec(url);
      if (vd && method === "GET") return send(res, 200, st.vanillaDoc(vd[1]));
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
      const pm = /^\/mod-assets\/pages\/(\d+)\.png$/.exec(url);
      if (pm) {
        const file = modScan.pages[Number(pm[1])];
        if (!file || !fs.existsSync(file)) return send(res, 404, "no such mod sprite page", "text/plain");
        res.setHeader("Cache-Control", "no-store"); // mod art changes while developing
        return send(res, 200, fs.readFileSync(file), "image/png");
      }
      if (url === "/api/import" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, st.importRoom(b.name, { base: b.base, by: b.by }));
      }
      if (url === "/api/create" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, st.createRoom(b.name, { base: b.base, keep: b.keep, by: b.by }));
      }

      const m = /^\/api\/doc\/([A-Za-z0-9_]+)(?:\/([a-z]+))?$/.exec(url);
      if (m) {
        const [, room, action] = m;
        if (!action && method === "GET") return send(res, 200, st.snapshot(room));
        const body = method === "POST" ? await readJson(req) : {};
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

  return { cfg, handler, setEmit: (cb) => { emit = cb; } };
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
