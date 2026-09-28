// Dev-server middleware: the editor's only door to the disk.
//
//   GET /api/config          the resolved svre.config.json
//   GET /api/rooms           every MSL room JSON under <modDir>/Codes (the .gml-wrapped kind)
//   GET /api/room/<file>     one room file, raw text (so the client keeps the exact bytes)
//   GET /assets/<path>       the extracted asset cache (pages/*.png, *.json)
//
// Game art never passes through the mod tree or git: it is read from assetsDir only.
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
  return { ...base, ...local };
}

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".json": "application/json",
  ".webp": "image/webp",
};

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

function send(res: any, status: number, type: string, body: string | Buffer) {
  res.statusCode = status;
  res.setHeader("Content-Type", type);
  res.end(body);
}

export function svreApi(root: string): Plugin {
  const cfg = loadConfig(root);
  const codesDir = path.join(cfg.modDir, "Codes");

  const handler: Connect.NextHandleFunction = (req, res, next) => {
    const url = decodeURIComponent((req.url ?? "").split("?")[0]);

    if (url === "/api/config") return send(res, 200, "application/json", JSON.stringify(cfg));

    if (url === "/api/rooms") {
      const rooms = fs
        .readdirSync(codesDir)
        .filter((f) => f.endsWith(".gml"))
        .map((f) => path.join(codesDir, f))
        .filter(isRoomFile)
        .map((f) => ({ file: path.basename(f), bytes: fs.statSync(f).size }));
      return send(res, 200, "application/json", JSON.stringify(rooms));
    }

    if (url.startsWith("/api/room/")) {
      const file = path.basename(url.slice("/api/room/".length));
      const full = path.join(codesDir, file);
      if (!fs.existsSync(full)) return send(res, 404, "text/plain", "no such room file");
      return send(res, 200, "text/plain; charset=utf-8", fs.readFileSync(full));
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
