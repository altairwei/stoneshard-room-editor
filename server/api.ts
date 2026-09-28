// Dev-server middleware: the HTTP face of the Store (server/store.ts), shared by the
// browser and the `svre` CLI. Events (who changed what) go out on Vite's websocket as
// the custom event "svre:event"; the CLI polls /changes instead.
//
//   GET  /api/rooms                         every room: project? compiled? dirty? drift?
//   GET  /api/vanilla?q=                    search vanilla rooms (bases)
//   POST /api/import      {name, base?, by?} project from an existing Codes/<name>.gml
//   POST /api/create      {name, base, keep?, by?}  new room on a vanilla base
//   GET  /api/doc/<room>                    full state: room JSON, log summary, notes, selections
//   POST /api/doc/<room>/apply   {by, label?, note?, ops}
//   POST /api/doc/<room>/undo    {by}        /redo {by}
//   GET  /api/doc/<room>/changes?since=N
//   POST /api/doc/<room>/compile {force?}    write Codes/<room>.gml
//   POST /api/doc/<room>/adopt   {by?}       log an outside edit of Codes/<room>.gml
//   GET  /api/doc/<room>/describe | lint | grid?region= | query?id=&object=&layer=&rect=&cell=
//   POST /api/doc/<room>/notes   {by, x, y, text} | {remove}
//   GET|POST /api/doc/<room>/selection  {by, ids}
//   GET  /assets/<path>                     the extracted asset cache
import fs from "node:fs";
import path from "node:path";
import type { Connect, Plugin } from "vite";
import { HttpError, Store } from "./store.ts";

export interface SvreConfig {
  modDir: string;
  assetsDir: string;
  sourceDir: string;
  vanillaWin: string;
  utmtCli: string;
}

export function loadConfig(root: string): SvreConfig {
  const base = JSON.parse(fs.readFileSync(path.join(root, "svre.config.json"), "utf8"));
  const localFile = path.join(root, "svre.config.local.json");
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, "utf8")) : {};
  const cfg = { ...base, ...local };
  // tests point a second server at a scratch copy of a mod, never at the real one
  if (process.env.SVRE_MOD_DIR) cfg.modDir = process.env.SVRE_MOD_DIR;
  return cfg;
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

export function svreApi(root: string): Plugin {
  const cfg = loadConfig(root);
  let emit: (e: Record<string, unknown>) => void = () => {};
  const store = new Store(cfg, (e) => emit({ ...e, at: new Date().toISOString() }));

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const [rawPath, qs] = (req.url ?? "").split("?");
    const url = decodeURIComponent(rawPath);
    const q = Object.fromEntries(new URLSearchParams(qs ?? ""));
    const method = req.method ?? "GET";
    try {
      if (url === "/api/config") return send(res, 200, cfg);
      if (url === "/api/rooms") return send(res, 200, store.listRooms());
      if (url === "/api/vanilla") return send(res, 200, store.searchVanilla(q.q ?? ""));
      if (url === "/api/import" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, store.importRoom(b.name, { base: b.base, by: b.by }));
      }
      if (url === "/api/create" && method === "POST") {
        const b = await readJson(req);
        return send(res, 200, store.createRoom(b.name, { base: b.base, keep: b.keep, by: b.by }));
      }

      const m = /^\/api\/doc\/([A-Za-z0-9_]+)(?:\/([a-z]+))?$/.exec(url);
      if (m) {
        const [, room, action] = m;
        if (!action && method === "GET") return send(res, 200, store.snapshot(room));
        const body = method === "POST" ? await readJson(req) : {};
        switch (action) {
          case "apply": return send(res, 200, store.apply(room, body));
          case "undo": return send(res, 200, store.undo(room, body.by));
          case "redo": return send(res, 200, store.redo(room, body.by));
          case "changes": return send(res, 200, store.changes(room, Number(q.since ?? 0)));
          case "compile": return send(res, 200, store.compileRoom(room, !!body.force));
          case "adopt": return send(res, 200, store.adoptExternal(room, body.by));
          case "describe": return send(res, 200, store.describe(room));
          case "lint": return send(res, 200, store.describe(room).findings);
          case "grid": return send(res, 200, store.grid(room, q.region), "text/plain; charset=utf-8");
          case "query": return send(res, 200, store.query(room, q));
          case "notes":
            if (method !== "POST") return send(res, 200, store.snapshot(room).notes);
            return send(res, 200, body.remove ? store.removeNote(room, body.remove) : store.addNote(room, body));
          case "selection":
            if (method === "POST") return send(res, 200, store.setSelection(room, body.by, body.ids ?? []));
            return send(res, 200, store.selectionOf(room));
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
    name: "svre-api",
    configureServer(server) {
      emit = (e) => server.ws.send("svre:event", e);
      server.middlewares.use(handler);
    },
  };
}
