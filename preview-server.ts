/**
 * Control Surface PREVIEW server (redesign sandbox).
 *
 * Serves the redesigned frontend build from dist/ and proxies every
 * backend call to the PRODUCTION control-surface instance on :3000.
 * This process runs no adapters, no background jobs, no DB writers —
 * it is a pure static host + reverse proxy, so the redesign can never
 * duplicate ingestor/builder/reasoner side effects.
 *
 * Proxied paths: /api/* (incl. SSE streams + terminal WebSockets) and
 * /opencode-api* (OpenCode BFF passthrough, incl. its /event SSE).
 */

import { join, extname, normalize } from "path";

const PORT = parseInt(process.env.PORT || "3007");
const UPSTREAM = process.env.UPSTREAM || "http://127.0.0.1:3000";
const UPSTREAM_WS = UPSTREAM.replace(/^http/, "ws");
const DIST = join(import.meta.dir, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function isProxied(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname.startsWith("/opencode-api");
}

type WsData = { upstream: WebSocket; pending: (string | ArrayBuffer)[] };

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (isProxied(url.pathname)) {
      // WebSocket upgrade (terminal sessions)
      if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") {
        const upstreamUrl = UPSTREAM_WS + url.pathname + url.search;
        const upstream = new WebSocket(upstreamUrl);
        const data: WsData = { upstream, pending: [] };
        upstream.addEventListener("open", () => {
          for (const m of data.pending.splice(0)) upstream.send(m);
        });
        if (!srv.upgrade(req, { data })) {
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        return undefined as unknown as Response;
      }

      // Plain HTTP / SSE proxy — stream the body straight through.
      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.set("x-forwarded-host", url.host);
      const upstreamReq = new Request(UPSTREAM + url.pathname + url.search, {
        method: req.method,
        headers,
        body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body,
        // @ts-expect-error bun streaming flag
        duplex: "half",
      });
      try {
        const res = await fetch(upstreamReq);
        const resHeaders = new Headers(res.headers);
        resHeaders.delete("content-encoding");
        resHeaders.delete("content-length");
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers: resHeaders,
        });
      } catch (err) {
        return new Response(`Upstream unavailable: ${(err as Error).message}`, { status: 502 });
      }
    }

    // Static assets with SPA fallback.
    let path = normalize(url.pathname).replace(/^([/\\])+/, "");
    if (path === "" || path === ".") path = "index.html";
    let file = Bun.file(join(DIST, path));
    if (!(await file.exists())) {
      // SPA fallback — unknown non-API routes render the app shell.
      file = Bun.file(join(DIST, "index.html"));
    }
    const ext = extname(file.name || "");
    const headers: Record<string, string> = {
      "content-type": MIME[ext] || "application/octet-stream",
    };
    if (path.startsWith("assets/")) {
      headers["cache-control"] = "public, max-age=31536000, immutable";
    } else {
      headers["cache-control"] = "no-cache";
    }
    return new Response(file, { headers });
  },

  websocket: {
    open(ws) {
      const { upstream } = ws.data;
      upstream.addEventListener("message", (ev) => {
        try {
          ws.send(ev.data as string | ArrayBuffer);
        } catch {
          /* client vanished */
        }
      });
      upstream.addEventListener("close", (ev) => {
        try {
          ws.close(ev.code, ev.reason);
        } catch {
          /* already closed */
        }
      });
      upstream.addEventListener("error", () => {
        try {
          ws.close(1011, "upstream error");
        } catch {
          /* already closed */
        }
      });
    },
    message(ws, message) {
      const { upstream, pending } = ws.data;
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(message);
      } else {
        pending.push(message as string | ArrayBuffer);
      }
    },
    close(ws) {
      try {
        ws.data.upstream.close();
      } catch {
        /* already closed */
      }
    },
  },
});

console.log(`[preview] design.techinsiderbytes.com sandbox on :${PORT} -> ${UPSTREAM}`);
