import { homeHandler } from "./home.ts";
import {
  marketplaceListHandler,
  marketplaceInstallHandler,
  marketplaceDeleteHandler,
  marketplaceEnableHandler,
  marketplaceDisableHandler,
  marketplaceRunHandler,
  marketplaceRunsHandler,
} from "./marketplace.ts";
import { getVersionInfo, VERSION } from "../version.ts";
import { getCachedUpdateInfo, shouldRefreshCache, checkForUpdate, setCachedUpdateInfo } from "../updater.ts";
import { autopipelineHandler } from "./autopipeline.ts";
import { doctorHandler } from "./doctor.ts";
import {
  paperclipAgentsHandler,
  paperclipTasksHandler,
} from "./paperclip.ts";
import { fsBrowseHandler } from "./fs.ts";
import { getDossierArtifacts, injectDossierNotes } from "./dossier.ts";
import {
  modelsHandler,
  getRoutingLogs,
  getRoutingStats,
  forceRouteModel,
  clearForceRoute,
} from "./models.ts";
import { newsBitesHandler } from "./newsbites.ts";
import { infraHandler } from "./infra.ts";
import { incidentsHandler } from "./incidents.ts";
import { streamHandler } from "./stream.ts";
import { actionCatalogHandler } from "./actionDescriptors.ts";
import { actionAuditHandler, auditExportHandler } from "./audit.ts";
import { eventsHandler } from "./events.ts";
import { jobHandler, jobsHandler } from "./jobs.ts";
import { metricsHandler } from "./metrics.ts";
import { 
  getBudgets, 
  createBudget, 
  getSpend, 
  getVastRunway, 
  getAttribution, 
  getFallbacks, 
  getRecommendations,
  getCostSummary,
} from "./cost.ts";
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
  builderPassDiagnosisHandler,
  builderRunSummaryHandler,
  builderWorkflowPlanProgressHandler,
  builderPassLiveHandler,
  traceListDatesHandler,
  traceByDateHandler,
  auditChainStatusHandler,
} from "./builder.ts";
import {
  codexListHandler, codexCreateHandler, codexGetHandler,
  codexDeleteHandler, codexSendHandler, codexStreamHandler, codexStopHandler,
} from "./codex.ts";
import { workloadHandler } from "./workload.ts";
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
  governancePoliciesHandler,
  governancePoliciesReloadHandler,
  governanceRbacMeHandler,
  governanceApprovalsListHandler,
  governanceApprovalDecideHandler,
  governanceSecretsListHandler,
  governanceSecretsWriteHandler,
  governanceSecretsDeleteHandler,
  governanceBudgetsListHandler,
  governanceBudgetsWriteHandler,
  governanceRetentionHandler,
  governanceRetentionWriteHandler,
  governanceAuditHandler,
} from "./governance.ts";
import {
  approvalCreateHandler,
  approvalsListHandler,
  approvalGetHandler,
  approvalVoteHandler,
  approvalExpireHandler,
} from "./approvals.ts";
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
import {
  gatewayStatusHandler,
  gatewayModelsHandler,
  gatewayLedgerHandler,
  gatewayStatsHandler,
  v1ChatCompletionsHandler,
  v1ModelsHandler,
} from "./gateway.ts";
import {
  reasonerJobsHandler,
  reasonerDiagnosesHandler,
  reasonerDiagnosisByPassHandler,
  reasonerIncidentsHandler,
  reasonerIncidentByIdHandler,
  reasonerResolveIncidentHandler,
  reasonerPlaybooksHandler,
  reasonerApplyPlaybookHandler,
} from "./reasoner.ts";
import {
  orchestratorSignalsListHandler,
  orchestratorSignalEmitHandler,
  orchestratorLanesHandler,
  orchestratorInstancesListHandler,
  orchestratorInstanceDetailHandler,
} from "./orchestrator.ts";
import {
  tenantsListHandler,
  tenantsCreateHandler,
  tenantGetHandler,
  tenantPatchHandler,
  tenantTmuxStatusHandler,
} from "./tenants.ts";
import { withTenantContext } from "../tenancy/middleware.ts";
import { projectsListHandler,
  projectsCreateHandler,
  projectGetHandler,
  projectPatchHandler,
  projectDeleteHandler,
  projectsDetectHandler,
} from "./projects.ts";
import {
  ssoConfigGetHandler,
  ssoConfigPutHandler,
  ssoLoginHandler,
  ssoCallbackHandler,
  ssoLogoutHandler,
  ssoSessionHandler,
} from "./sso.ts";
import { loadMtlsConfig, verifyClientCert, extractTenantFromCert } from "../sso/mtls.ts";
import {
  reportsTemplatesHandler,
  reportsRunHandler,
  reportsGetHandler,
  reportsDownloadCsvHandler,
} from "./reports.ts";
import { tenantSettingsGetHandler, tenantSettingsPutHandler } from "./tenant-settings.ts";
import { complianceDpaHandler,
  complianceSubprocessorsHandler,
  complianceSoc2MappingHandler,
  complianceSummaryHandler,
  complianceEvidenceBundleHandler,
} from "./compliance.ts";
import { getActiveLicense } from "../licensing/index.ts";
import { getTelemetryConsent, setTelemetryConsent, collectTelemetryPayload } from "../telemetry/index.ts";
import { onboardingStatusHandler, onboardingStepHandler } from "./onboarding.ts";
import { docsTutorialsHandler } from "./docs.ts";
import { cloudTierStatusHandler } from "./cloud-tier.ts";
import {
  channelsBriefPreviewHandler,
  channelsBriefSendHandler,
  channelsHandler,
  notificationRulesHandler,
  notificationRuleUpsertHandler,
} from "./channels.ts";
import {
  litellmStatusHandler,
  litellmRoutingHandler,
  litellmConfigHandler,
} from "./litellm.ts";
import {
  getScoutRuns,
  getScoutConfig,
  updateScoutConfig,
  triggerScoutRun,
} from "./scout.ts";
import {
  getFinanceStats,
  getFinanceRuns,
  getFinanceEnrichments,
  getPortfolioConfigs,
} from "./financeIntel.ts";
import {
  getSystemConfig,
  getSystemConfigHistory,
  updateSystemConfig,
} from "./systemConfig.ts";

export const handleApi = withTenantContext(handleApiInner);

function shouldRateLimitRequest(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

async function handleApiInner(req: Request, url: URL): Promise<Response> {
  const { pathname } = url;
  const method = req.method;

  // ── HTTP boundary input validation ─────────────────────────────────────────
  const allowedMethods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
  if (!allowedMethods.includes(method)) {
    return new Response(JSON.stringify({ error: "method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": allowedMethods.join(", ") },
    });
  }

  if (["POST", "PUT", "PATCH"].includes(method)) {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType && !contentType.includes("application/json") && !contentType.includes("multipart/form-data") && !contentType.includes("text/plain")) {
      return new Response(JSON.stringify({ error: "unsupported media type" }), {
        status: 415,
        headers: { "Content-Type": "application/json" },
      });
    }
    const contentLength = req.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > 1 * 1024 * 1024) {
      return new Response(JSON.stringify({ error: "request body too large (max 1MB)" }), {
        status: 413,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // ── Rate limiting for sensitive endpoints (30 req/min per IP) ───────────────
  if (shouldRateLimitRequest(method)) {
    const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
      ?? req.headers.get("x-real-ip") ?? "unknown";
    const rateLimitKey = `rl:${clientIp}`;
    const now = Date.now();
    const windowMs = 60_000;
    const maxReqs = 30;
    const rlMap = (globalThis as unknown as Record<string, Record<string, [number, number]>>)["__rateLimitMap"] ??= {};
    const entry = rlMap[rateLimitKey];
    if (entry) {
      const [count, windowStart] = entry;
      if (now - windowStart < windowMs) {
        if (count >= maxReqs) {
          return new Response(JSON.stringify({ error: "rate limit exceeded (30 req/min), retry later" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "60" },
          });
        }
        rlMap[rateLimitKey] = [count + 1, windowStart];
      } else {
        rlMap[rateLimitKey] = [1, now];
      }
    } else {
      rlMap[rateLimitKey] = [1, now];
    }
  }

  const mtlsConfig = loadMtlsConfig();
  if (mtlsConfig?.required) {
    const clientCert = req.headers.get("x-forwarded-client-cert") ?? req.headers.get("x-tls-client-cert-pem") ?? "";
    if (!clientCert) {
      return new Response(JSON.stringify({ error: "client certificate required" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Mutual" },
      });
    }
    const result = verifyClientCert(clientCert, mtlsConfig.caPath);
    if (!result.valid) {
      return new Response(JSON.stringify({ error: result.error ?? "invalid client certificate" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
    const tenantId = extractTenantFromCert(result.subject);
    if (tenantId) {
      req.headers.set("x-mtls-tenant-id", tenantId);
    }
  }

  // ── Auth bootstrap/status. Never return OPERATOR_TOKEN to the browser. ─────
  if (method === "GET" && pathname === "/api/auth/status") return authStatusHandler(req);
  if (method === "POST" && pathname === "/api/auth/session") return authSessionHandler(req);

  // ── Read endpoints ─────────────────────────────────────────────────────────
  // Connection bounding for SSE streams
const MAX_SSE_CONNECTIONS = 100;
let currentSseConnections = 0;

// ── Read endpoints ─────────────────────────────────────────────────────────
if (method === "GET" && pathname === "/api/stream") {
  if (currentSseConnections >= MAX_SSE_CONNECTIONS) {
    return new Response(JSON.stringify({ error: "too many concurrent SSE connections" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }
  currentSseConnections++;
  const response = streamHandler();
  // Override the response to decrement the counter when the connection closes
  const originalBody = response.body;
  if (originalBody) {
    const wrappedBody = new ReadableStream({
      async start(controller) {
        const reader = originalBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          console.error("SSE stream error:", err);
        } finally {
          currentSseConnections--;
          controller.close();
          reader.releaseLock();
        }
      },
      cancel() {
        currentSseConnections--;
      }
    });
    return new Response(wrappedBody, {
      headers: response.headers,
      status: response.status,
    });
  }
  currentSseConnections--; // Decrement if we somehow don't have a body
  return response;
}
  if (method === "GET" && pathname === "/api/actions/catalog") return actionCatalogHandler(url);
  if (method === "GET" && pathname === "/api/actions/audit") {
    if (!checkToken(req)) return unauthorized();
    return actionAuditHandler(url);
  }
  if (method === "GET" && pathname === "/api/governance/audit") return governanceAuditHandler(req);
  if (method === "POST" && pathname === "/api/audit/export") {
    if (!checkToken(req)) return unauthorized();
    return auditExportHandler(url, method, await req.clone().json().catch(() => ({})));
  }
  const auditExportMatch = pathname.match(/^\/api\/audit\/export\/([^/]+)(\/download|\/verify)?$/);
  if (auditExportMatch) {
    if (!checkToken(req)) return unauthorized();
    return auditExportHandler(url, method, await req.clone().json().catch(() => ({})));
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
  if (method === "GET" && pathname === "/api/version") {
    if (shouldRefreshCache()) {
      checkForUpdate().then(setCachedUpdateInfo).catch(() => setCachedUpdateInfo(null));
    }
    return Response.json({ ...getVersionInfo(), updateAvailable: getCachedUpdateInfo() });
  }
  if (method === "POST" && pathname === "/api/update-check") {
    if (!checkToken(req)) return unauthorized();
    const result = await checkForUpdate();
    setCachedUpdateInfo(result);
    return Response.json({ updateAvailable: result });
  }

  // ── v1 prefix aliases (Phase 1) ──────────────────────────────────────────────
  if (pathname.startsWith("/v1/builder/")) {
    const apiPath = pathname.replace("/v1/builder/", "/api/builder/");
    return handleApiInner(req, new URL(apiPath, url.origin));
  }
  const v1GatewayMatch = pathname.match(/^\/v1\/gateway(\/.*)?$/);
  if (v1GatewayMatch) {
    const suffix = v1GatewayMatch[1] ?? "/status";
    return handleApiInner(req, new URL(`/api/gateway${suffix}`, url.origin));
  }
  const v1GovernanceMatch = pathname.match(/^\/v1\/governance(\/.*)?$/);
  if (v1GovernanceMatch) {
    const suffix = v1GovernanceMatch[1] ?? "/policies";
    return handleApiInner(req, new URL(`/api/governance${suffix}`, url.origin));
  }
  const v1LicensingMatch = pathname.match(/^\/v1\/licensing(\/.*)?$/);
  if (v1LicensingMatch) {
    return handleApiInner(req, new URL("/api/licensing/status", url.origin));
  }
  const v1TelemetryMatch = pathname.match(/^\/v1\/telemetry(\/.*)?$/);
  if (v1TelemetryMatch) {
    return handleApiInner(req, new URL("/api/telemetry/preview", url.origin));
  }
  const v1OnboardingMatch = pathname.match(/^\/v1\/onboarding(\/.*)?$/);
  if (v1OnboardingMatch) {
    const suffix = v1OnboardingMatch[1] ?? "/status";
    return handleApiInner(req, new URL(`/api/onboarding${suffix}`, url.origin));
  }
  if (method === "GET" && pathname === "/api/infra") return infraHandler();
  if (method === "GET" && pathname === "/api/channels") {
    if (!checkToken(req)) return unauthorized();
    return channelsHandler(url);
  }
  if (method === "GET" && pathname === "/api/notifications/rules") {
    if (!checkToken(req)) return unauthorized();
    return notificationRulesHandler(url);
  }
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
  if (method === "GET" && pathname === "/api/builder/doctor/reports") return builderDoctorReportsHandler(url);
  if (method === "GET" && pathname === "/api/builder/runs") return builderRunsHandler(url);
  if (method === "GET" && pathname === "/api/workload") return workloadHandler(req);
  const builderRunMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)$/);
  if (method === "GET" && builderRunMatch) {
    // Reconcile running status on every GET
    await builderRunReconcileHandler(builderRunMatch[1]);
    return builderRunHandler(builderRunMatch[1]);
  }
  const builderWorkflowPlanProgressMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/plan-progress$/);
  if (method === "GET" && builderWorkflowPlanProgressMatch) {
    return builderWorkflowPlanProgressHandler(builderWorkflowPlanProgressMatch[1]);
  }
  const builderPassLiveMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/pass-live$/);
  if (method === "GET" && builderPassLiveMatch) {
    return builderPassLiveHandler(builderPassLiveMatch[1]);
  }
  const builderRunSummaryMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/summary$/);
  if (method === "GET" && builderRunSummaryMatch) {
    return builderRunSummaryHandler(builderRunSummaryMatch[1]);
  }
  const builderPassDiagnosisMatch = pathname.match(/^\/api\/builder\/passes\/([^/]+)\/diagnosis$/);
  if (method === "GET" && builderPassDiagnosisMatch) {
    return builderPassDiagnosisHandler(builderPassDiagnosisMatch[1]);
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

  // Traces
  if (method === "GET" && pathname === "/api/traces") return traceListDatesHandler();
  const traceByDateMatch = pathname.match(/^\/api\/traces\/(\d{4}-\d{2}-\d{2})$/);
  if (method === "GET" && traceByDateMatch) return traceByDateHandler(traceByDateMatch[1]);

  // Audit chain
  if (method === "GET" && pathname === "/api/audit/chain-status") return auditChainStatusHandler();

  // ── LiteLLM ─────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/litellm/status") return litellmStatusHandler();
  if (method === "GET" && pathname === "/api/litellm/routing") return litellmRoutingHandler();
  if (method === "GET" && pathname === "/api/litellm/config") return litellmConfigHandler();

  // ── Scout ───────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/scout/runs") return getScoutRuns(req);
  const scoutRunMatch = pathname.match(/^\/api\/scout\/runs\/([^/]+)$/);
  if (method === "GET" && scoutRunMatch) {
    const { getScoutRun } = await import("./scout.ts");
    return getScoutRun(req, scoutRunMatch[1]);
  }
  if (method === "GET" && pathname === "/api/scout/config") return getScoutConfig(req);
  if (method === "PUT" && pathname === "/api/scout/config") return updateScoutConfig(req);
  if (method === "POST" && pathname === "/api/scout/trigger") return triggerScoutRun(req);

  // ── Finance Intel ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/finance-intel/stats") return getFinanceStats(req);
  if (method === "GET" && pathname === "/api/finance-intel/runs") return getFinanceRuns(req);
  if (method === "GET" && pathname === "/api/finance-intel/enrichments") return getFinanceEnrichments(req);
  if (method === "GET" && pathname === "/api/finance-intel/portfolio-configs") return getPortfolioConfigs(req);
  const financeTriggerMatch = pathname.match(/^\/api\/finance-intel\/(trigger-analysis|portfolio-configs?)$/);
  if (method === "POST" && financeTriggerMatch) {
    if (!checkToken(req)) return unauthorized();
    const { triggerAnalysis } = await import("./financeIntel.ts");
    if (financeTriggerMatch[1] === "trigger-analysis") return triggerAnalysis(req);
    if (financeTriggerMatch[1] === "portfolio-config" || financeTriggerMatch[1] === "portfolio-configs") {
      const { upsertPortfolioConfig } = await import("./financeIntel.ts");
      return upsertPortfolioConfig(req);
    }
  }

  // ── System Config ─────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/system-config") return getSystemConfig(req);
  if (method === "PUT" && pathname === "/api/system-config") {
    if (!checkToken(req)) return unauthorized();
    return updateSystemConfig(req);
  }
  if (method === "GET" && pathname === "/api/system-config/history") return getSystemConfigHistory(req);

  // ── Paperclip ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/paperclip/agents") return paperclipAgentsHandler();
  if (method === "GET" && pathname === "/api/paperclip/tasks") return paperclipTasksHandler();

  // ── Filesystem ──────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/fs/browse") return fsBrowseHandler(url);

  // ── Dossier ─────────────────────────────────────────────────────────────────
  const dossierMatch = pathname.match(/^\/api\/dossier\/([^/]+)\/([^/]+)$/);
  if (method === "GET" && dossierMatch) return getDossierArtifacts(req, dossierMatch[1], dossierMatch[2]);
  const dossierInjectMatch = pathname.match(/^\/api\/dossier\/([^/]+)\/([^/]+)\/inject$/);
  if (method === "POST" && dossierInjectMatch) return injectDossierNotes(req, dossierInjectMatch[1], dossierInjectMatch[2]);

  // ── Model Routing ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/models/routing-log") return getRoutingLogs(req);
  if (method === "GET" && pathname === "/api/models/routing-stats") return getRoutingStats(req);
  if (method === "POST" && pathname === "/api/models/force-route") return forceRouteModel(req);
  const modelForceMatch = pathname.match(/^\/api\/models\/force-route\/([^/]+)$/);
  if (method === "DELETE" && modelForceMatch) return clearForceRoute(req);

  // Gateway
  if (method === "GET" && pathname === "/api/gateway/status") return gatewayStatusHandler();
  if (method === "GET" && pathname === "/api/gateway") return gatewayStatusHandler();
  if (method === "GET" && pathname === "/api/gateway/models") return gatewayModelsHandler();
  if (method === "GET" && pathname === "/api/gateway/ledger") return gatewayLedgerHandler(url);
  if (method === "GET" && pathname === "/api/gateway/stats") return gatewayStatsHandler(url);

  // Cost Alias
  if (method === "GET" && pathname === "/api/cost") return getCostSummary(req);
  // OpenAI-compatible surface
  if (method === "POST" && pathname === "/v1/chat/completions") return v1ChatCompletionsHandler(req);
  if (method === "GET" && pathname === "/v1/models") return v1ModelsHandler();

  if (method === "POST" && pathname === "/api/builder/provision") {
    if (!checkToken(req)) return unauthorized();
    return builderProvisionHandler(req);
  }

  // Mission Control, Today, Workload, Settings
  if (method === "GET" && pathname === "/api/mission-control") return missionControlHandler();
  if (method === "GET" && pathname === "/api/today") return todayHandler();
  if (method === "GET" && pathname === "/api/workload") return workloadHandler(req);
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

  // ── Governance ──────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/governance/policies") return governancePoliciesHandler();
  if (method === "POST" && pathname === "/api/governance/policies/reload") return governancePoliciesReloadHandler();
  if (method === "GET" && pathname === "/api/governance/rbac/me") return governanceRbacMeHandler(req);
  if (method === "GET" && pathname === "/api/governance/approvals") return governanceApprovalsListHandler(req);
  const govApprovalMatch = pathname.match(/^\/api\/governance\/approvals\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && govApprovalMatch) {
    return governanceApprovalDecideHandler(req, govApprovalMatch[1], govApprovalMatch[2] as "approve" | "reject");
  }

  // ── Approvals (4-eyes) ──────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/approvals") return approvalCreateHandler(req);
  if (method === "GET" && pathname === "/api/approvals") return approvalsListHandler(req);
  const approvalGetMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === "GET" && approvalGetMatch) {
    return approvalGetHandler(req, approvalGetMatch[1]);
  }
  if (method === "POST" && approvalGetMatch) {
    return approvalVoteHandler(req, approvalGetMatch[1]);
  }
  const approvalExpireMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/expire$/);
  if (method === "POST" && approvalExpireMatch) {
    return approvalExpireHandler(req, approvalExpireMatch[1]);
  }

  // ── Secrets ──────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/governance/secrets") return governanceSecretsListHandler(req);
  if (method === "POST" && pathname === "/api/governance/secrets") return governanceSecretsWriteHandler(req);
  const govSecretDeleteMatch = pathname.match(/^\/api\/governance\/secrets\/(.+)$/);
  if (method === "DELETE" && govSecretDeleteMatch) {
    return governanceSecretsDeleteHandler(req, govSecretDeleteMatch[1]);
  }
  if (method === "GET" && pathname === "/api/governance/budgets") return governanceBudgetsListHandler(req);
  if (method === "POST" && pathname === "/api/governance/budgets") return governanceBudgetsWriteHandler(req);
  if (method === "GET" && pathname === "/api/governance/retention") return governanceRetentionHandler();
  if (method === "POST" && pathname === "/api/governance/retention") return governanceRetentionWriteHandler(req);
  if (method === "GET" && pathname === "/api/governance/audit") return governanceAuditHandler(req);

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
  if (method === "POST" && pathname === "/api/notifications/rules") {
    if (!checkToken(req)) return unauthorized();
    return notificationRuleUpsertHandler(req);
  }
  const notificationRuleMatch = pathname.match(/^\/api\/notifications\/rules\/([^/]+)$/);
  if (method === "POST" && notificationRuleMatch) {
    if (!checkToken(req)) return unauthorized();
    return notificationRuleUpsertHandler(req, notificationRuleMatch[1]);
  }
  if (method === "POST" && pathname === "/api/channels/brief/preview") {
    if (!checkToken(req)) return unauthorized();
    return channelsBriefPreviewHandler();
  }
  if (method === "POST" && pathname === "/api/channels/brief/send") {
    if (!checkToken(req)) return unauthorized();
    return channelsBriefSendHandler();
  }
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

  // ── Reasoner ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/reasoner/jobs") return reasonerJobsHandler();
  if (method === "GET" && pathname === "/api/reasoner/diagnoses") return reasonerDiagnosesHandler();
  if (method === "GET" && pathname === "/api/reasoner/incidents") return reasonerIncidentsHandler(url);
  const reasonerDiagnosisMatch = pathname.match(/^\/api\/reasoner\/diagnoses\/([^/]+)$/);
  if (method === "GET" && reasonerDiagnosisMatch) {
    return reasonerDiagnosisByPassHandler(reasonerDiagnosisMatch[1]);
  }
  const reasonerIncidentMatch = pathname.match(/^\/api\/reasoner\/incidents\/([^/]+)$/);
  if (reasonerIncidentMatch) {
    if (method === "GET") return reasonerIncidentByIdHandler(reasonerIncidentMatch[1]);
    if (method === "POST") return reasonerResolveIncidentHandler(reasonerIncidentMatch[1]);
  }
  if (method === "GET" && pathname === "/api/reasoner/playbooks") return reasonerPlaybooksHandler();
  const reasonerApplyPlaybookMatch = pathname.match(/^\/api\/reasoner\/playbooks\/([^/]+)\/apply$/);
  if (method === "POST" && reasonerApplyPlaybookMatch) {
    return reasonerApplyPlaybookHandler(reasonerApplyPlaybookMatch[1], req);
  }

  if (method === "GET" && pathname === "/api/orchestrator/signals") {
    if (!checkToken(req)) return unauthorized();
    return orchestratorSignalsListHandler(url);
  }
  if (method === "POST" && pathname === "/api/orchestrator/signals") {
    if (!checkToken(req)) return unauthorized();
    return orchestratorSignalEmitHandler(req);
  }
  if (method === "GET" && pathname === "/api/orchestrator/lanes") {
    if (!checkToken(req)) return unauthorized();
    return orchestratorLanesHandler();
  }
  if (method === "GET" && pathname === "/api/orchestrator/instances") {
    if (!checkToken(req)) return unauthorized();
    return orchestratorInstancesListHandler(url);
  }
  const instanceMatch = pathname.match(/^\/api\/orchestrator\/instances\/([^/]+)$/);
  if (method === "GET" && instanceMatch) {
    if (!checkToken(req)) return unauthorized();
    return orchestratorInstanceDetailHandler(instanceMatch[1]);
  }

  // ── Tenants ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/tenants") return tenantsListHandler(req);
  if (method === "POST" && pathname === "/api/tenants") return tenantsCreateHandler(req);
  const tenantMatch = pathname.match(/^\/api\/tenants\/([^/]+)$/);
  if (tenantMatch) {
    if (method === "GET") return tenantGetHandler(req, tenantMatch[1]);
    if (method === "PATCH") return tenantPatchHandler(req, tenantMatch[1]);
  }
  const tenantTmuxMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/tmux-status$/);
  if (tenantTmuxMatch) {
    if (method === "GET") return tenantTmuxStatusHandler(req, tenantTmuxMatch[1]);
  }

  // ── Projects ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/projects") return projectsListHandler(req, url);
  if (method === "POST" && pathname === "/api/projects") return projectsCreateHandler(req);
  if (method === "POST" && pathname === "/api/projects/detect") return projectsDetectHandler(req);
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    if (method === "GET") return projectGetHandler(req, projectMatch[1]);
    if (method === "PATCH") return projectPatchHandler(req, projectMatch[1]);
    if (method === "DELETE") return projectDeleteHandler(req, projectMatch[1]);
  }

  // ── SSO ────────────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sso/config") return ssoConfigGetHandler(req);
  if (method === "PUT" && pathname === "/api/sso/config") return ssoConfigPutHandler(req);
  if (method === "GET" && pathname === "/api/sso/login") return ssoLoginHandler(req);
  if (method === "GET" && pathname === "/api/sso/callback") return ssoCallbackHandler(req);
  if (method === "POST" && pathname === "/api/sso/logout") return ssoLogoutHandler(req);
  if (method === "GET" && pathname === "/api/sso/session") return ssoSessionHandler(req);

  // ── Marketplace ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/marketplace/skills") return marketplaceListHandler(req);
  if (method === "POST" && pathname === "/api/marketplace/skills/install") return marketplaceInstallHandler(req);
  const marketplaceDeleteMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)$/);
  if (method === "DELETE" && marketplaceDeleteMatch) return marketplaceDeleteHandler(req, marketplaceDeleteMatch[1]);
  const marketplaceEnableMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/enable$/);
  if (method === "POST" && marketplaceEnableMatch) return marketplaceEnableHandler(req, marketplaceEnableMatch[1]);
  const marketplaceDisableMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/disable$/);
  if (method === "POST" && marketplaceDisableMatch) return marketplaceDisableHandler(req, marketplaceDisableMatch[1]);
  const marketplaceRunMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/run$/);
  if (method === "POST" && marketplaceRunMatch) return marketplaceRunHandler(req, marketplaceRunMatch[1]);
  const marketplaceRunsMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/runs$/);
  if (method === "GET" && marketplaceRunsMatch) return marketplaceRunsHandler(req, marketplaceRunsMatch[1]);

  // ── Reports ─────────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/reports/templates") return reportsTemplatesHandler();
  if (method === "POST" && pathname === "/api/reports/run") {
    if (!checkToken(req)) return unauthorized();
    return reportsRunHandler(req);
  }
  const reportRunMatch = pathname.match(/^\/api\/reports\/([^/]+)$/);
  if (method === "GET" && reportRunMatch) {
    return reportsGetHandler(req, reportRunMatch[1]);
  }
  const reportCsvMatch = pathname.match(/^\/api\/reports\/([^/]+)\/csv$/);
  if (method === "GET" && reportCsvMatch) {
    return reportsDownloadCsvHandler(req, reportCsvMatch[1]);
  }

  // ── Tenant Settings ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/tenant/settings") return tenantSettingsGetHandler(req);
  if (method === "PUT" && pathname === "/api/tenant/settings") {
    if (!checkToken(req)) return unauthorized();
    return tenantSettingsPutHandler(req);
  }

  // ── Licensing ───────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/licensing/status") {
    const status = getActiveLicense();
    return Response.json(status);
  }

  // ── Telemetry ─────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/telemetry/preview") {
    const payload = collectTelemetryPayload();
    return Response.json(payload);
  }
  if (method === "POST" && pathname === "/api/telemetry/consent") {
    let body: { consent: boolean };
    try {
      body = await req.json() as { consent: boolean };
    } catch {
      return new Response(JSON.stringify({ error: "invalid json" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    setTelemetryConsent(Boolean(body.consent));
    return Response.json({ ok: true, consent: body.consent });
  }

  // ── Onboarding ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/onboarding/status") return onboardingStatusHandler();
  if (method === "POST" && pathname === "/api/onboarding/step") return onboardingStepHandler(req);

  // ── Docs / Tutorials ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/docs/tutorials") return docsTutorialsHandler();

  // ── Cloud Tier ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/cloud-tier/status") return cloudTierStatusHandler();

  // ── Cost Management ───────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/cost/budgets") return getBudgets(req);
  if (method === "POST" && pathname === "/api/cost/budgets") return createBudget(req);
  if (method === "GET" && pathname === "/api/cost/spend") return getSpend(req);
  if (method === "GET" && pathname === "/api/cost/runway/vast") return getVastRunway(req);
  if (method === "GET" && pathname.startsWith("/api/cost/attribution/")) return getAttribution(req);
  if (method === "GET" && pathname === "/api/cost/fallbacks") return getFallbacks(req);
  if (method === "POST" && pathname === "/api/cost/recommendations") return getRecommendations(req);
  if (method === "GET" && pathname === "/api/cost/summary") return getCostSummary(req);

  // ── Compliance (Phase 7) ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/compliance/dpa") return complianceDpaHandler(req);
  if (method === "GET" && pathname === "/api/compliance/subprocessors") return complianceSubprocessorsHandler();
  if (method === "GET" && pathname === "/api/compliance/soc2-mapping") return complianceSoc2MappingHandler();
  if (method === "GET" && pathname === "/api/compliance/summary") return complianceSummaryHandler(req);
  if (method === "GET" && pathname === "/api/compliance/evidence-bundle") return complianceEvidenceBundleHandler(req);

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
