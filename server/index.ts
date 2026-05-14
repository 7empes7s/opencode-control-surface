import { handleApi } from "./api/router.ts";
import { checkToken } from "./api/actions.ts";
import { normalizeWorkspace } from "./api/workspaces.ts";
import { initDashboardDb } from "./db/dashboard.ts";
import { startIngestor } from "./db/ingestor.ts";
import { startBuilderReconciler } from "./builder/runner.ts";
import { createWorkflow, getWorkflow, listWorkflows, updateWorkflow, deleteWorkflow } from "./db/workflows.js";
import { readFileSync } from "fs";

const OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://localhost:4096";
const PORT = parseInt(process.env.PORT || "3000");
const DIST_PATH = new URL("../dist", import.meta.url).pathname;

// Map common extensions to MIME types
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

async function serveStatic(pathname: string): Promise<Response> {
  // Client-side routes should always receive the SPA shell.
  if (pathname === "/" || !pathname.includes(".")) {
    try {
      return new Response(readFileSync(`${DIST_PATH}/index.html`), {
        headers: { "Content-Type": mimeFor("/index.html") },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  for (const candidate of [pathname, "/index.html"]) {
    const file = Bun.file(`${DIST_PATH}${candidate}`);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "Content-Type": mimeFor(candidate) },
      });
    }
  }

  return new Response("Not found", { status: 404 });
}

async function proxyOpenCode(req: Request, pathname: string, search: string): Promise<Response> {
  const targetPath = pathname.replace(/^\/opencode-api/, "") || "/";
  const targetUrl = `${OPENCODE_URL}${targetPath}${search}`;

  const proxyHeaders = new Headers(req.headers);
  proxyHeaders.delete("host");
  proxyHeaders.delete("content-length");

  let body: BodyInit | undefined =
    req.method !== "GET" && req.method !== "HEAD" ? req.body : undefined;

  if (req.method === "POST" && targetPath === "/session") {
    let payload: Record<string, unknown>;
    try {
      payload = await req.json() as Record<string, unknown>;
    } catch {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const workspace = normalizeWorkspace(typeof payload.directory === "string" ? payload.directory : undefined);
    if (workspace.ok === false) {
      return new Response(JSON.stringify({ error: workspace.error }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    payload.directory = workspace.path;
    body = JSON.stringify(payload);
    proxyHeaders.set("content-type", "application/json");
  }

  try {
    const resp = await fetch(targetUrl, {
      method: req.method,
      headers: proxyHeaders,
      body,
    } as RequestInit);

    const headers = new Headers(resp.headers);
    // Bun fetch transparently decodes compressed upstream responses. Forwarding
    // the original encoding headers makes browsers try to decode the body again.
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");

    // Stream the response body through unchanged
    return new Response(resp.body, {
      status: resp.status,
      headers,
    });
  } catch {
    return new Response(JSON.stringify({ error: "OpenCode server unavailable" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }
}

const dashboardDb = initDashboardDb();
if (process.env.DASHBOARD_DB === "1" && !dashboardDb) {
  console.error("[control-surface] DASHBOARD_DB=1 but dashboard SQLite is unavailable; continuing without durable history");
}

const ingestor = startIngestor();
if (ingestor) {
  console.log("[control-surface] dashboard ingestor started");
}

const builderReconciler = startBuilderReconciler();
if (builderReconciler) {
  console.log("[control-surface] builder reconciler started");
}

const shutdown = () => {
  ingestor?.stop();
  builderReconciler?.stop();
  process.exit(0);
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0, // SSE and Claude streaming need no idle cutoff

  async fetch(req) {
    const url = new URL(req.url);
    const { pathname, search } = url;

    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/workflows") {
      if (req.method === "POST") {
        const body = await req.json();
        const wf = createWorkflow({ model: body.model, input: body.input });
        return Response.json(wf, { status: 201 });
      }
      if (req.method === "GET") {
        const limit = Number(new URL(req.url).searchParams.get("limit")) || 50;
        const offset = Number(new URL(req.url).searchParams.get("offset")) || 0;
        return Response.json(listWorkflows(limit, offset));
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (pathname.startsWith("/api/workflows/")) {
      const id = pathname.split("/")[3];
      if (!id) return new Response("Not found", { status: 404 });
      if (req.method === "GET") {
        const wf = getWorkflow(id);
        if (!wf) return new Response("Not found", { status: 404 });
        return Response.json(wf);
      }
      if (req.method === "PUT") {
        const urlObj = new URL(req.url);
        if (urlObj.pathname.endsWith("/rerun")) {
          const wf = getWorkflow(id);
          if (!wf) return new Response("Not found", { status: 404 });
          updateWorkflow(id, { status: "pending", attempts: wf.attempts + 1 });
          return Response.json({ ok: true, id });
        }
      }
      if (req.method === "DELETE") {
        deleteWorkflow(id);
        return Response.json({ ok: true });
      }
      return new Response("Method not allowed", { status: 405 });
    }

    if (pathname === "/api/models") {
      // Let the router handle this for proper formatting
      return handleApi(req, url);
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(req, url);
    }

    if (pathname.startsWith("/opencode-api")) {
      if (!checkToken(req)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return proxyOpenCode(req, pathname, search);
    }

    if (pathname === "/models") {
      const file = Bun.file("public/models.html");
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    return serveStatic(pathname);
  },
});

console.log(`[control-surface] listening on :${server.port}`);
