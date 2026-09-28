// Dev-server middleware: the editor's only door to the disk.
//
//   GET /api/config          the resolved svre.config.json
//   GET /api/rooms           every MSL room JSON under <modDir>/Codes (the .gml-wrapped kind),
//                            with the generator script that owns it, if any
//   GET /api/room/<file>     one room file, raw text (so the client keeps the exact bytes);
//                            header X-Svre-Hash = sha1 of those bytes
//   PUT /api/room/<file>     write it back. Requires X-Svre-Base = the hash the client loaded;
//                            if the file changed on disk since (another session, a generator
//                            run), answers 409 and writes nothing
//   GET /assets/<path>       the extracted asset cache (pages/*.png, *.json)
//
// Game art never passes through the mod tree or git: it is read from assetsDir only.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Plugin, Connect } from "vite";

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

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
  ".webp": "image/webp",
};

const sha1 = (b: Buffer | string) => crypto.createHash("sha1").update(b).digest("hex");

// a room file is a Codes/*.gml whose body is the JSON AddRoomJson reads
function isRoomFile(file: string): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, 256, 0);
    return /^\s*\{\s*"name"\s*:/.test(buf.subarray(0, n).toString("utf8"));
  } finally {
    fs.closeSync(fd);
  }
}

// generator scripts under <modDir>/tools that name a room file are taken to own it:
// hand edits there are lost on the next generator run, and the UI says so
function generatorsOf(modDir: string): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  const toolsDir = path.join(modDir, "tools");
  if (!fs.existsSync(toolsDir)) return owners;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(full); continue; }
      if (!/\.(py|mjs|js|ts|csx)$/.test(e.name)) continue;
      const text = fs.readFileSync(full, "utf8");
      for (const m of text.matchAll(/r_[A-Za-z0-9_]+(?:\.gml)?/g)) {
        const f = m[0].endsWith(".gml") ? m[0] : `${m[0]}.gml`;
        const rel = path.relative(modDir, full).replace(/\\/g, "/");
        const list = owners.get(f) ?? [];
        if (!list.includes(rel)) list.push(rel);
        owners.set(f, list);
      }
    }
  };
  walk(toolsDir);
  return owners;
}

function send(res: any, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(body);
}

function readBody(req: any): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function svreApi(root: string): Plugin {
  const cfg = loadConfig(root);
  const codesDir = path.join(cfg.modDir, "Codes");

  const handler: Connect.NextHandleFunction = async (req, res, next) => {
    const url = decodeURIComponent((req.url ?? "").split("?")[0]);

    if (url === "/api/config") return send(res, 200, "application/json", JSON.stringify(cfg));

    if (url === "/api/rooms") {
      const owners = generatorsOf(cfg.modDir);
      const rooms = fs
        .readdirSync(codesDir)
        .filter((f) => f.endsWith(".gml"))
        .filter((f) => isRoomFile(path.join(codesDir, f)))
        .map((f) => ({ file: f, bytes: fs.statSync(path.join(codesDir, f)).size, generatedBy: owners.get(f) ?? [] }));
      return send(res, 200, "application/json", JSON.stringify(rooms));
    }

    if (url.startsWith("/api/room/")) {
      const file = path.basename(url.slice("/api/room/".length));
      if (!file.endsWith(".gml")) return send(res, 400, "text/plain", "room files end in .gml");
      const full = path.join(codesDir, file);

      if (req.method === "GET") {
        if (!fs.existsSync(full)) return send(res, 404, "text/plain", "no such room file");
        const buf = fs.readFileSync(full);
        return send(res, 200, "text/plain; charset=utf-8", buf, { "X-Svre-Hash": sha1(buf) });
      }

      if (req.method === "PUT") {
        const base = String(req.headers["x-svre-base"] ?? "");
        const body = await readBody(req);
        try {
          JSON.parse(body.toString("utf8"));
        } catch (e) {
          return send(res, 400, "text/plain", `refusing to write invalid JSON: ${(e as Error).message}`);
        }
        if (fs.existsSync(full)) {
          const current = sha1(fs.readFileSync(full));
          if (current !== base)
            return send(res, 409, "application/json", JSON.stringify({ error: "changed on disk since you opened it", current }));
        } else if (base !== "new") {
          return send(res, 409, "application/json", JSON.stringify({ error: "file no longer exists" }));
        }
        // write-then-rename so a crash never leaves half a room behind
        const tmp = `${full}.svre-tmp`;
        fs.writeFileSync(tmp, body);
        fs.renameSync(tmp, full);
        return send(res, 200, "application/json", JSON.stringify({ hash: sha1(body) }));
      }

      return send(res, 405, "text/plain", "GET or PUT");
    }

    if (url.startsWith("/assets/")) {
      const rel = path.normalize(url.slice("/assets/".length));
      const full = path.join(cfg.assetsDir, rel);
      if (!full.startsWith(path.normalize(cfg.assetsDir)) || !fs.existsSync(full))
        return send(res, 404, "text/plain", "asset not found -- run the extract step (README)");
      res.setHeader("Cache-Control", "max-age=86400");
      return send(res, 200, MIME[path.extname(full)] ?? "application/octet-stream", fs.readFileSync(full));
    }

    next();
  };

  return {
    name: "svre-api",
    configureServer(server) {
      server.middlewares.use(handler);
    },
  };
}
