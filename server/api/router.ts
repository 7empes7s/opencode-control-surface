import { homeHandler } from "./home.ts";
import { autopipelineHandler } from "./autopipeline.ts";
import { doctorHandler } from "./doctor.ts";
import { modelsHandler } from "./models.ts";
import { newsBitesHandler } from "./newsbites.ts";
import { infraHandler } from "./infra.ts";
import { incidentsHandler } from "./incidents.ts";
import { streamHandler } from "./stream.ts";
import { actionCatalogHandler } from "./actionDescriptors.ts";
import { actionAuditHandler } from "./audit.ts";
import { eventsHandler } from "./events.ts";
import { jobHandler, jobsHandler } from "./jobs.ts";
import { metricsHandler } from "./metrics.ts";
import {
  builderProjectsHandler,
  builderDiscoverHandler,
  builderModelsHandler,
  builderWorkflowsHandler,
  builderWorkflowHandler,
  builderCreateWorkflowHandler,
  builderUpdateWorkflowHandler,
  builderDeleteWorkflowHandler,
  builderRunsHandler,
  builderRunHandler,
  builderArtifactsHandler,
  builderRetryRunHandler,
  builderCancelRunHandler,
  builderStartWorkflowHandler,
  builderStopWorkflowHandler,
  builderPauseWorkflowHandler,
  builderResumeWorkflowHandler,
  builderDoctorReportsHandler,
  builderTriggerDoctorReviewHandler,
  builderRunReconcileHandler,
  builderRunnerDisabledHandler,
  builderProvisionHandler,
  builderArtifactContentHandler,
} from "./builder.ts";
import {
  codexListHandler, codexCreateHandler, codexGetHandler,
  codexDeleteHandler, codexSendHandler, codexStreamHandler, codexStopHandler,
} from "./codex.ts";
import {
  claudeHealthHandler,
  claudeListHandler, claudeCreateHandler, claudeGetHandler,
  claudeDeleteHandler, claudeStreamHandler, claudeStopHandler,
} from "./claude.ts";
import {
  geminiHealthHandler,
  geminiListHandler, geminiCreateHandler, geminiGetHandler,
  geminiDeleteHandler, geminiStreamHandler, geminiStopHandler,
} from "./gemini.ts";
import {
  agentsDiscoveryHandler,
  agentsQuickPromptsHandler,
  agentsSkillsHandler,
  agentsSummaryHandler,
  agentsVaultLogHandler,
  agentsWorkspacesHandler,
} from "./agents.ts";
import { missionControlHandler } from "./missionControl.ts";
import { todayHandler } from "./today.ts";
import { settingsStateHandler, settingsStatePutHandler, settingsAuthStatusHandler } from "./settings.ts";
import {
  autopipelineCommandHandler,
  modelsActionHandler,
  newsBitesDeployHandler,
  newsBitesDeployStatusHandler,
  infraServiceRestartHandler,
  infraRunTimerHandler,
  doctorScanHandler,
  authSessionHandler,
  authStatusHandler,
  checkToken,
} from "./actions.ts";
import { executeActionHandler } from "./execute.ts";

export async function handleApi(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // ── Auth bootstrap/status. Never return OPERATOR_TOKEN to the browser. ─────
  if (method === "GET" && pathname === "/api/auth/status") return authStatusHandler(req);
  if (method === "POST" && pathname === "/api/auth/session") return authSessionHandler(req);

  // ── Read endpoints ─────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/stream") return streamHandler();
  if (method === "GET" && pathname === "/api/actions/catalog") return actionCatalogHandler(url);
  if (method === "GET" && pathname === "/api/actions/audit") {
    if (!checkToken(req)) return unauthorized();
    return actionAuditHandler(url);
  }
  if (method === "GET" && pathname === "/api/jobs") {
    if (!checkToken(req)) return unauthorized();
    return jobsHandler(url);
  }
  const jobMatch = pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (method === "GET" && jobMatch) {
    if (!checkToken(req)) return unauthorized();
    return jobHandler(jobMatch[1]);
  }
  if (method === "GET" && pathname === "/api/home") return homeHandler();
  if (method === "GET" && pathname === "/api/events") return eventsHandler(url);
  if (method === "GET" && pathname === "/api/metrics") return metricsHandler(url);
  if (method === "GET" && pathname === "/api/autopipeline") return autopipelineHandler();
  if (method === "GET" && pathname === "/api/doctor") return doctorHandler(url);
  if (method === "GET" && pathname === "/api/models") return modelsHandler();
  if (method === "GET" && pathname === "/api/newsbites") return newsBitesHandler();
  if (method === "GET" && pathname === "/api/infra") return infraHandler();
  if (method === "GET" && pathname === "/api/incidents") return incidentsHandler();
  if (method === "GET" && pathname === "/api/agents/skills") return agentsSkillsHandler(url);
  if (method === "GET" && pathname === "/api/agents/quick-prompts") return agentsQuickPromptsHandler(url);
  if (method === "GET" && pathname === "/api/agents/summary") return agentsSummaryHandler();
  if (method === "GET" && pathname === "/api/agents/discovery") return agentsDiscoveryHandler();
  if (method === "GET" && pathname === "/api/agents/workspaces") return agentsWorkspacesHandler();
  if (pathname.startsWith("/api/builder/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/builder/projects") return builderProjectsHandler();
  if (method === "GET" && pathname === "/api/builder/discover") return builderDiscoverHandler(url);
  if (method === "GET" && pathname === "/api/builder/models") return builderModelsHandler();
  if (method === "GET" && pathname === "/api/builder/workflows") return builderWorkflowsHandler();
  if (method === "POST" && pathname === "/api/builder/workflows") return builderCreateWorkflowHandler(req);
  const builderWorkflowMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)$/);
  if (builderWorkflowMatch) {
    if (method === "GET") return builderWorkflowHandler(builderWorkflowMatch[1]);
    if (method === "PUT") return builderUpdateWorkflowHandler(req, builderWorkflowMatch[1]);
    if (method === "DELETE") return builderDeleteWorkflowHandler(builderWorkflowMatch[1]);
  }
  const builderWorkflowActionMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/(start|pause|resume|stop|doctor-review)$/);
  if (method === "POST" && builderWorkflowActionMatch) {
    const workflowId = builderWorkflowActionMatch[1];
    const action = builderWorkflowActionMatch[2];
    if (action === "start") return builderStartWorkflowHandler(workflowId, req);
    if (action === "stop") return builderStopWorkflowHandler(workflowId, req);
    if (action === "pause") return builderPauseWorkflowHandler(workflowId);
    if (action === "resume") return builderResumeWorkflowHandler(workflowId);
    if (action === "doctor-review") return builderTriggerDoctorReviewHandler(workflowId);
    return builderRunnerDisabledHandler(action);
  }
  if (method === "GET" && pathname === "/api/builder/doctor-reports") return builderDoctorReportsHandler(url);
  if (method === "GET" && pathname === "/api/builder/runs") return builderRunsHandler(url);
  const builderRunMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)$/);
  if (method === "GET" && builderRunMatch) {
    // Reconcile running status on every GET
    await builderRunReconcileHandler(builderRunMatch[1]);
    return builderRunHandler(builderRunMatch[1]);
  }
  const builderRunActionMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/(retry|cancel)$/);
  if (method === "POST" && builderRunActionMatch) {
    const runId = builderRunActionMatch[1];
    const action = builderRunActionMatch[2];
    if (action === "retry") return builderRetryRunHandler(runId);
    if (action === "cancel") return builderCancelRunHandler(runId);
    return builderRunnerDisabledHandler(action);
  }
  if (method === "GET" && pathname === "/api/builder/artifacts") return builderArtifactsHandler(url);
  if (method === "GET" && pathname === "/api/builder/log") return builderArtifactContentHandler(url);
  if (method === "POST" && pathname === "/api/builder/provision") {
    if (!checkToken(req)) return unauthorized();
    return builderProvisionHandler(req);
  }

  // Mission Control, Today, Settings
  if (method === "GET" && pathname === "/api/mission-control") return missionControlHandler();
  if (method === "GET" && pathname === "/api/today") return todayHandler();
  if (method === "GET" && pathname === "/api/settings/auth-status") return settingsAuthStatusHandler();
  if (method === "GET" && pathname === "/api/settings/state") {
    if (!checkToken(req)) return unauthorized();
    return settingsStateHandler(url);
  }
  const settingsStateKeyMatch = pathname.match(/^\/api\/settings\/state\/([^/]+)$/);
  if (method === "PUT" && settingsStateKeyMatch) {
    if (!checkToken(req)) return unauthorized();
    return settingsStatePutHandler(req, settingsStateKeyMatch[1]);
  }

  // Deploy job status (GET with path param)
  const deployMatch = pathname.match(/^\/api\/newsbites\/deploy\/([^/]+)$/);
  if (method === "GET" && deployMatch) return newsBitesDeployStatusHandler(deployMatch[1]);

  // ── Mutating endpoints ─────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/autopipeline/command") return autopipelineCommandHandler(req);
  if (method === "POST" && pathname === "/api/models/action") return modelsActionHandler(req);
  if (method === "POST" && pathname === "/api/doctor/scan") return doctorScanHandler(req);
  if (method === "POST" && pathname === "/api/newsbites/deploy") return newsBitesDeployHandler(req);
  if (method === "POST" && pathname === "/api/infra/service-restart") return infraServiceRestartHandler(req);
  if (method === "POST" && pathname === "/api/infra/run-timer") return infraRunTimerHandler(req);
  if (method === "POST" && pathname === "/api/agents/vault-log") {
    if (!checkToken(req)) return unauthorized();
    return agentsVaultLogHandler(req);
  }
  if (method === "POST" && pathname === "/api/actions/execute") {
    if (!checkToken(req)) return unauthorized();
    return executeActionHandler(req);
  }

  // ── Codex tab ─────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/codex/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/codex/sessions") return codexListHandler();
  if (method === "POST" && pathname === "/api/codex/sessions") return codexCreateHandler(req);
  const codexSessionMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)$/);
  if (codexSessionMatch) {
    if (method === "GET") return codexGetHandler(codexSessionMatch[1]);
    if (method === "DELETE") return codexDeleteHandler(codexSessionMatch[1]);
  }
  const codexSendMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/message$/);
  if (method === "POST" && codexSendMatch) return codexSendHandler(req, codexSendMatch[1]);
  const codexStreamMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && codexStreamMatch) return codexStreamHandler(req, codexStreamMatch[1]);
  const codexStopMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && codexStopMatch) return codexStopHandler(codexStopMatch[1]);

  // ── Claude tab ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/claude/health") return claudeHealthHandler();
  if (pathname.startsWith("/api/claude/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/claude/sessions") return claudeListHandler();
  if (method === "POST" && pathname === "/api/claude/sessions") return claudeCreateHandler(req);
  const claudeSessionMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)$/);
  if (claudeSessionMatch) {
    if (method === "GET") return claudeGetHandler(claudeSessionMatch[1]);
    if (method === "DELETE") return claudeDeleteHandler(claudeSessionMatch[1]);
  }
  const claudeStreamMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && claudeStreamMatch) return claudeStreamHandler(req, claudeStreamMatch[1]);
  const claudeStopMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && claudeStopMatch) return claudeStopHandler(claudeStopMatch[1]);

  // ── Gemini tab ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/gemini/health") return geminiHealthHandler();
  if (pathname.startsWith("/api/gemini/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/gemini/sessions") return geminiListHandler();
  if (method === "POST" && pathname === "/api/gemini/sessions") return geminiCreateHandler(req);
  const geminiSessionMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)$/);
  if (geminiSessionMatch) {
    if (method === "GET") return geminiGetHandler(geminiSessionMatch[1]);
    if (method === "DELETE") return geminiDeleteHandler(geminiSessionMatch[1]);
  }
  const geminiStreamMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && geminiStreamMatch) return geminiStreamHandler(req, geminiStreamMatch[1]);
  const geminiStopMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && geminiStopMatch) return geminiStopHandler(geminiStopMatch[1]);

  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

function unauthorized(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
