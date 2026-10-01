// Standalone backend for the Electron app: the SAME handler the vite plugin mounts
// (server/api.ts createApi), plus dist/ statics, plus an SSE channel at /api/events
// standing in for vite's websocket. Everything is loopback-only; the port defaults to
// 0 (OS-assigned) so the app never collides with a dev server.
//
// Bundled to dist-server/standalone.cjs by `npm run build:server` (esbuild); the
// Electron main process require()s it in-process.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { createApi } from "./api.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface StandaloneOptions {
  root: string;          // the editor repo root (svre.config.json lives here)
  staticDir?: string;    // vite build output; non-/api paths fall through to it
  port?: number;         // default 0 = OS-assigned
  host?: string;         // default 127.0.0.1
}

export async function startSvreServer(opts: StandaloneOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const { handler, setEmit } = createApi(opts.root);

  // store events -> every subscribed SSE client (the client's wireWs falls back to
  // EventSource when vite's HMR channel is absent, i.e. exactly here)
  const sse = new Set<http.ServerResponse>();
  setEmit((e) => {
    const chunk = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(chunk);
  });
  const heartbeat = setInterval(() => {
    for (const res of sse) res.write(`: ping\n\n`);
  }, 25000);

  const serveStatic = (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!opts.staticDir) {
      res.statusCode = 404;
      return res.end("no static bundle -- run `npm run build` (or use the vite dev server)");
    }
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const rel = path.normalize(urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
    const full = path.join(opts.staticDir, rel);
    if (!full.startsWith(path.normalize(opts.staticDir)) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.statusCode = 404;
      return res.end("not found");
    }
    res.setHeader("Content-Type", MIME[path.extname(full)] ?? "application/octet-stream");
    res.end(fs.readFileSync(full));
  };

  const server = http.createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/events")) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(`: svre events\n\n`);
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }
    void handler(req, res, () => serveStatic(req, res));
  });

  const host = opts.host ?? "127.0.0.1";
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, host, () => resolve((server.address() as { port: number }).port));
  });
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        clearInterval(heartbeat);
        for (const res of sse) res.end();
        server.close(() => resolve());
      }),
  };
}
