import { handleApi } from "./api/router.ts";
import { initDashboardDb } from "./db/dashboard.ts";
import { initObservabilityDb } from "./db/observability.ts";
import { startIngestor } from "./db/ingestor.ts";
import { startBuilderReconciler } from "./builder/runner.ts";
import { startReasonerWatcher } from "./reasoner/index.ts";
import { seedPlaybooks } from "./reasoner/playbooks.ts";
import { createWorkflow, getWorkflow, listWorkflows, updateWorkflow, deleteWorkflow } from "./db/workflows.js";
import { readFileSync } from "fs";
import { startRetentionScheduler } from "./governance/retention.ts";
import { startInsightsScanScheduler, stopInsightsScanScheduler } from "./insights/scheduler.ts";
import { maybeGenerateWeeklyExecutiveReport } from "./reporting/executive.ts";
import { maybeGenerateMonthlyRemediationReport } from "./reporting/remediation.ts";
import { maybeGenerateWeeklySystemLaborReport } from "./reporting/systemLabor.ts";
import { maybeGenerateWeeklySlaUptimeReport } from "./reporting/slaUptime.ts";
import { maybeGenerateWeeklyDiscoveryPostureReport } from "./reporting/discoveryPosture.ts";
import { backfillCostEventsOnce } from "./gateway/ledger.ts";
import { setLaneLimit } from "./orchestrator/lanes.ts";
import { seedDefaultTenant } from "./tenancy/store.ts";
import { upsertProject } from "./projects/index.ts";
import { seedDemoData } from "./db/demo-seed.ts";
import { seedDemoTenant } from "./db/demoTenant.ts";
import {
  closeTerminalClients,
  terminalStatusHandler,
  terminalUpgradeHandler,
  terminalWebSocketHandlers,
  type TerminalSocketData,
} from "./terminal/session.ts";
import { handleOpenCodeProxy } from "./agentWorkspace/opencodeProxy.ts";
import { startOpenCodeEventSpool } from "./agentWorkspace/opencodeEventSpool.ts";
import { importLegacyAgentSessions, markUnreconciledAgentRunsStale, seedLegacyOpenCodeVisibilityReceipts } from "./agentWorkspace/registry.ts";

const DIST_PATH = new URL("../dist", import.meta.url).pathname;

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
  if (pathname === "/" || !pathname.includes(".")) {
    try {
      return new Response(readFileSync(`${DIST_PATH}/index.html`), {
        // The shell must revalidate every load: Cloudflare otherwise applies a
        // 4h browser TTL and clients keep HTML pointing at purged asset hashes
        // after a rebuild (page renders unstyled).
        headers: { "Content-Type": mimeFor("/index.html"), "Cache-Control": "no-cache, must-revalidate" },
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  }

  for (const candidate of [pathname, "/index.html"]) {
    const file = Bun.file(`${DIST_PATH}${candidate}`);
    if (await file.exists()) {
      const cache = candidate.startsWith("/assets/")
        ? "public, max-age=31536000, immutable" // hashed filenames never change content
        : candidate === "/index.html"
          ? "no-cache, must-revalidate"
          : "public, max-age=3600";
      return new Response(file, {
        headers: { "Content-Type": mimeFor(candidate), "Cache-Control": cache },
      });
    }
  }

  return new Response("Not found", { status: 404 });
}

export async function startServer(): Promise<{ stop: () => void }> {
  const dashboardDb = initDashboardDb();
  const observabilityDb = initObservabilityDb();
  if (process.env.DASHBOARD_DB === "1" && !dashboardDb) {
    console.error("[control-surface] DASHBOARD_DB=1 but dashboard SQLite is unavailable; continuing without durable history");
  }
  if (observabilityDb) {
    console.log("[control-surface] observability SQLite initialized");
  }
  if (dashboardDb) {
    const seededReceipts = seedLegacyOpenCodeVisibilityReceipts();
    if (seededReceipts > 0) {
      console.log(`[agent-workspace] imported ${seededReceipts} immutable OpenCode visibility receipts`);
    }
    const importedSessions = importLegacyAgentSessions();
    if (Object.values(importedSessions).some((count) => count > 0)) {
      console.log(`[agent-workspace] imported legacy visible sessions ${JSON.stringify(importedSessions)}`);
    }
    const staleRuns = markUnreconciledAgentRunsStale();
    if (staleRuns > 0) console.warn(`[agent-workspace] marked ${staleRuns} unreconciled runs stale after restart`);
    seedPlaybooks(dashboardDb);
    setLaneLimit("builder-passes", 3);
    seedDefaultTenant();
    seedDemoData(dashboardDb);
    seedDemoTenant(dashboardDb);
    for (const tbl of ["builder_workflows", "builder_runs", "builder_passes", "builder_artifacts", "builder_validations", "action_audit", "jobs"]) {
      try { dashboardDb.run(`UPDATE ${tbl} SET tenant_id = 'mimule' WHERE tenant_id IS NULL`); } catch { /* table may not exist yet */ }
    }
    upsertProject({
      id: "opencode-control-surface",
      tenantId: "mimule",
      name: "Control Surface",
      repoPath: "/opt/opencode-control-surface",
      language: "typescript",
      framework: "bun+react",
      validatorCommands: ["bun run check", "bun test server/db/ server/api/", "bun run build"],
      defaultModelRoster: [],
      defaultPolicies: {},
      status: "active",
    });

    const { installSkill, listSkills } = await import("./marketplace/registry.ts");
    const { parseManifest } = await import("./marketplace/manifest.ts");
    const echoBundlePath = new URL("./marketplace/builtin/echo-skill", import.meta.url).pathname;
    const echoManifestPath = `${echoBundlePath}/manifest.json`;
    try {
      const existing = listSkills("mimule").filter((s) => s.name === "echo");
      if (existing.length === 0) {
        const manifestJson = await Bun.file(echoManifestPath).text();
        installSkill("mimule", echoBundlePath, manifestJson);
        console.log("[control-surface] echo skill auto-installed");
      }
    } catch (e) {
      console.warn("[control-surface] echo skill auto-install failed:", e);
    }
  }

  const opencodeEventSpool = dashboardDb ? startOpenCodeEventSpool() : null;

  const ingestor = startIngestor();
  if (ingestor) {
    console.log("[control-surface] dashboard ingestor started");
  }

  const builderReconciler = startBuilderReconciler();
  if (builderReconciler) {
    console.log("[control-surface] builder reconciler started");
  }

  startReasonerWatcher();

  startRetentionScheduler();
  startInsightsScanScheduler();
  const executiveReportTick = () => {
    void maybeGenerateWeeklyExecutiveReport().catch((error) => {
      console.error("[control-surface] weekly executive report failed", error instanceof Error ? error.message : error);
    });
    void maybeGenerateMonthlyRemediationReport().catch((error) => {
      console.error("[control-surface] monthly remediation report failed", error instanceof Error ? error.message : error);
    });
    void maybeGenerateWeeklySystemLaborReport().catch((error) => {
      console.error("[control-surface] weekly system labor report failed", error instanceof Error ? error.message : error);
    });
    void maybeGenerateWeeklySlaUptimeReport().catch((error) => {
      console.error("[control-surface] weekly SLA uptime report failed", error instanceof Error ? error.message : error);
    });
    void maybeGenerateWeeklyDiscoveryPostureReport().catch((error) => {
      console.error("[control-surface] weekly discovery posture report failed", error instanceof Error ? error.message : error);
    });
  };
  executiveReportTick();
  const executiveReportTimer = setInterval(executiveReportTick, 15 * 60 * 1000);
  executiveReportTimer.unref?.();
  if (dashboardDb) { try { backfillCostEventsOnce(); } catch (e) { console.error("[control-surface] cost backfill failed", e); } }

  const shutdown = () => {
    closeTerminalClients();
    ingestor?.stop();
    builderReconciler?.stop();
    clearInterval(executiveReportTimer);
    stopInsightsScanScheduler();
    opencodeEventSpool?.stop();
    process.exit(0);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);

  return {
    stop: () => {
      closeTerminalClients();
      ingestor?.stop();
      builderReconciler?.stop();
      clearInterval(executiveReportTimer);
      stopInsightsScanScheduler();
      opencodeEventSpool?.stop();
    },
  };
}

startServer().catch(console.error);

const PORT = parseInt(process.env.PORT || "3000");

// Connection bounding for SSE streams
const MAX_SSE_CONNECTIONS = 100;
let currentSseConnections = 0;

const server = Bun.serve<TerminalSocketData>({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 0,

  async fetch(req, bunServer) {
    const url = new URL(req.url);
    const { pathname, search } = url;

    if (pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, version: "0.8.0" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathname === "/api/terminal/status") {
      return terminalStatusHandler(req);
    }

    if (pathname === "/api/terminal/ws") {
      return terminalUpgradeHandler(req, bunServer);
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
      return handleApi(req, url);
    }

    if (pathname.startsWith("/api/")) {
      return handleApi(req, url);
    }

    if (pathname.startsWith("/v1/")) {
      return handleApi(req, url);
    }

    if (pathname.startsWith("/opencode-api")) {
      return handleOpenCodeProxy(req, pathname, search);
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

  websocket: terminalWebSocketHandlers,
});

console.log(`[control-surface] listening on :${server.port}`);
