import { startServer } from "./index.ts";
import { readFileSync, existsSync } from "fs";

if (process.argv.includes("--version")) {
  console.log("0.8.0");
  process.exit(0);
}

if (process.argv.includes("--help")) {
  console.log("Usage: tib-builder [options]");
  console.log("  --version  Print version and exit");
  console.log("  --help     Show this help");
  process.exit(0);
}

const STATIC_DIR = process.env.STATIC_DIR ?? "./dist";
const PORT = parseInt(process.env.PORT || "3000");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

function mimeFor(pathname: string): string {
  const ext = pathname.match(/\.[^.]+$/)?.[0] ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, version: "0.8.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname.startsWith("/api/") || pathname.startsWith("/v1/") || pathname.startsWith("/opencode-api")) {
      return new Response("API gateway not available in binary mode", { status: 503 });
    }

    if (existsSync(STATIC_DIR)) {
      if (pathname === "/" || !pathname.includes(".")) {
        const indexPath = `${STATIC_DIR}/index.html`;
        if (existsSync(indexPath)) {
          return new Response(readFileSync(indexPath), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }
      }

      const filePath = `${STATIC_DIR}${pathname}`;
      if (existsSync(filePath)) {
        return new Response(readFileSync(filePath), {
          headers: { "Content-Type": mimeFor(pathname) },
        });
      }

      const indexFallback = `${STATIC_DIR}/index.html`;
      if (existsSync(indexFallback)) {
        return new Response(readFileSync(indexFallback), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});