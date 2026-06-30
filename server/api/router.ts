import { homeHandler } from "./home.ts";
import { productHealthHandler } from "./product-health.ts";
import { showcaseMetricsHandler } from "./metrics-showcase.ts";
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
import { publicStatusHandler } from "./status.ts";
import { getCachedUpdateInfo, shouldRefreshCache, checkForUpdate, setCachedUpdateInfo } from "../updater.ts";
import { autopipelineHandler } from "./autopipeline.ts";
import { doctorHandler } from "./doctor.ts";
import {
  paperclipAgentsHandler,
  paperclipTasksHandler,
} from "./paperclip.ts";
import { fsBrowseHandler } from "./fs.ts";
import { getDossierArtifacts, injectDossierNotes } from "./dossier.ts";
import { dataExplorerTableHandler, dataExplorerTablesHandler } from "./dataExplorer.ts";
import {
  modelsHandler,
  getRoutingLogs,
  getRoutingStats,
  forceRouteModel,
  clearForceRoute,
} from "./models.ts";
import { newsBitesHandler } from "./newsbites.ts";
import { deleteArticleHandler, articleDossierPathHandler, refreshArticleImageHandler, uploadArticleImageHandler } from "./newsbites-actions.ts";
import { infraHandler } from "./infra.ts";
import { incidentAckHandler, incidentPostMortemHandler, incidentResolveHandler, incidentsHandler } from "./incidents.ts";
import { streamHandler } from "./stream.ts";
import { actionCatalogHandler } from "./actionDescriptors.ts";
import { actionAuditHandler, auditExportHandler } from "./audit.ts";
import { contentHealthHandler, contentHealthRunHandler } from "./content-health.ts";
import { eventsHandler } from "./events.ts";
import { jobHandler, jobsHandler, cancelJobHandler, retryJobHandler } from "./jobs.ts";
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
  builderWorkflowPlanHandler,
  builderWorkflowIterateHandler,
  builderWorkflowPreviewStartHandler,
  builderWorkflowPreviewStatusHandler,
  builderWorkflowPreviewStopHandler,
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
  builderSetLifecycleHandler,
  builderDoctorReportsHandler,
  builderTriggerDoctorReviewHandler,
  builderRunReconcileHandler,
  builderRunnerDisabledHandler,
  builderProvisionHandler,
  builderArtifactContentHandler,
  builderPassDiagnosisHandler,
  builderRunSummaryHandler,
  builderRepairBaselineHandler,
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
import { agentTeamHandler, agentTeamJobHandler, agentTeamActionHandler } from "./agent-team.ts";
import {
  settingsStateHandler,
  settingsStatePutHandler,
  settingsAuthStatusHandler,
  settingsAccessHandler,
  settingsAccessInviteHandler,
  settingsAccessRoleHandler,
} from "./settings.ts";
import { authLoginHandler } from "./auth.ts";
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
  doctorRequeuHandler,
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
  gatewayShowbackHandler,
  gatewayCircuitActionHandler,
  gatewayProbeHandler,
  gatewayRouteHealthiestHandler,
  v1ChatCompletionsHandler,
  v1ModelsHandler,
} from "./gateway.ts";
import {
  listGatewayKeysHandler,
  createGatewayKeyHandler,
  revokeGatewayKeyHandler,
} from "./gatewayKeys.ts";
import {
  reasonerJobsHandler,
  reasonerDiagnosesHandler,
  reasonerDiagnosisByPassHandler,
  reasonerIncidentsHandler,
  reasonerIncidentByIdHandler,
  reasonerResolveIncidentHandler,
  reasonerIncidentPostMortemHandler,
  reasonerPlaybooksHandler,
  reasonerApplyPlaybookHandler,
} from "./reasoner.ts";
import {
  insightApplyHandler,
  insightDismissHandler,
  insightsListHandler,
  insightsScanHandler,
  insightsReanalyzeHandler,
  insightsBulkApplyHandler,
  insightsBulkAcknowledgeHandler,
  insightsBulkSnoozeHandler,
  insightsAutoApplyPreviewHandler,
  requireInsightPermission,
} from "./insights.ts";
import { policyRegistryHandler } from "./policyRegistry.ts";
import { securityPostureHandler, securitySecretsHandler, trustScoreHandler } from "./security.ts";
import {
  adminHealthHandler,
  adminBriefingHandler,
  adminSearchHandler,
  adminAutoFixFeedHandler,
} from "./admin.ts";
import { promptsHandler } from "./prompts.ts";
import {
  discoveryListAssetsHandler,
  discoveryRegisterAssetHandler,
  discoveryIgnoreAssetHandler,
  discoveryRescanHandler,
} from "./discovery.ts";
import { gatewayTracesHandler } from "./traces.ts";
import { agentRegistryListHandler, agentPassportHandler } from "./agentRegistry.ts";
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
import { withTenantContext, getCurrentTenantContext } from "../tenancy/middleware.ts";
import brainstormApp from './brainstorm-actions.ts';
import { brainstormStreamHandler } from './brainstorm-stream.ts';
import preflightApp from './brainstorm-preflight.ts';
import { withAuditBoundary, isMutatingApiRequest, resolveActorForAudit } from "./auditBoundary.ts";
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
  ssoConfigPostHandler,
  ssoLoginHandler,
  ssoCallbackHandler,
  ssoLogoutHandler,
  ssoSessionHandler,
} from "./sso.ts";
import { loadMtlsConfig, verifyClientCert, extractTenantFromCert } from "../sso/mtls.ts";
import {
  reportsTemplatesHandler,
  reportsListHandler,
  reportsRunHandler,
  reportsGetHandler,
  reportsDownloadCsvHandler,
  reportsExportVaultHandler,
} from "./reports.ts";
import { generateOperatorDigest } from "../reporting/digest.ts";
import { tenantSettingsGetHandler, tenantSettingsPutHandler } from "./tenant-settings.ts";
import { complianceDpaHandler,
  complianceSubprocessorsHandler,
  complianceSoc2MappingHandler,
  complianceSummaryHandler,
  complianceEvidenceBundleHandler,
} from "./compliance.ts";
import {
  generateEvidencePack,
  readEvidencePackById,
} from "../compliance/evidencePack.ts";
import { writeActionAudit } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { getActiveLicense } from "../licensing/index.ts";
import { getTelemetryConsent, setTelemetryConsent, collectTelemetryPayload } from "../telemetry/index.ts";
import { onboardingStatusHandler, onboardingStepHandler } from "./onboarding.ts";
import {
  featureFlagsListHandler,
  featureFlagsCreateHandler,
  featureFlagsGetHandler,
  featureFlagsUpdateHandler,
  featureFlagsDeleteHandler,
  featureFlagsHistoryHandler,
} from "./featureFlags.ts";
import { installStatusHandler } from "./install.ts";
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
import { withRequestAuthContext } from "../auth/session.ts";
import { requireMutation } from "../governance/rbac.ts";
import {
  publicApiAgentsHandler,
  publicApiAuditHandler,
  publicApiCostHandler,
  publicApiInsightsHandler,
  publicApiTrustScoreHandler,
  webhooksCreateHandler,
  webhooksDisableHandler,
  webhooksListHandler,
} from "./publicApi.ts";

export const handleApi = withTenantContext(withRequestAuthContext(handleApiOuter));

function handleApiOuter(req: Request, url: URL): Promise<Response> {
  if (isMutatingApiRequest(req.method, url.pathname)) {
    return withAuditBoundary(req, url.pathname, resolveActorForAudit(req), () =>
      handleApiInner(req, url),
    );
  }
  return handleApiInner(req, url);
}

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
  if (method === "POST" && pathname === "/api/auth/login") return authLoginHandler(req);
  if (method === "POST" && pathname === "/api/auth/session") return authSessionHandler(req);

  // ── Public status page (no auth; public-by-design) ──────────────────────────
  if (method === "GET" && pathname === "/api/public-status") return publicStatusHandler();

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
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const wrappedBody = new ReadableStream({
      async start(controller) {
        reader = originalBody.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            try {
              controller.enqueue(value);
            } catch (enqueueErr) {
              // Controller was cancelled/closed underneath us; stop quietly.
              break;
            }
          }
        } catch (err) {
          console.error("SSE stream error:", err);
        } finally {
          currentSseConnections--;
          try {
            controller.close();
          } catch {
            // Controller may already be closed/cancelled (e.g. client disconnected).
            // Swallow — there's nothing useful we can do here.
          }
          try {
            reader.releaseLock();
          } catch {
            // Reader may already be released; ignore.
          }
        }
      },
      cancel() {
        currentSseConnections--;
        // Propagate the client disconnect to the inner stream so its
        // homeHandler push intervals stop (otherwise: immortal zombie pumps).
        try {
          reader?.cancel();
        } catch {
          // Inner stream may already be closed; nothing to do.
        }
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
  if (method === "GET" && pathname === "/api/policy/registry") {
    if (!checkToken(req)) return unauthorized();
    return policyRegistryHandler();
  }
  if (method === "GET" && (pathname === "/api/content-health" || pathname === "/api/content-health/findings")) {
    if (!checkToken(req)) return unauthorized();
    return contentHealthHandler(url);
  }
  if (method === "POST" && pathname === "/api/content-health/run") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return contentHealthRunHandler(url);
  }
  if (method === "GET" && pathname === "/api/insights") {
    if (!checkToken(req)) return unauthorized();
    return insightsListHandler(req, url);
  }
  if (method === "GET" && pathname === "/api/security/posture") {
    if (!checkToken(req)) return unauthorized();
    return securityPostureHandler(req);
  }
  if (method === "GET" && pathname === "/api/security/secrets") {
    if (!checkToken(req)) return unauthorized();
    return securitySecretsHandler(req);
  }
  if (method === "GET" && pathname === "/api/security/trust-score") {
    if (!checkToken(req)) return unauthorized();
    return trustScoreHandler(req);
  }
  if (method === "GET" && pathname === "/api/prompts") {
    if (!checkToken(req)) return unauthorized();
    return promptsHandler(req, url);
  }
  if (method === "GET" && pathname === "/api/agent-registry") {
    if (!checkToken(req)) return unauthorized();
    return agentRegistryListHandler(req);
  }
  const agentRegistryMatch = pathname.match(/^\/api\/agent-registry\/([^/]+)$/);
  if (method === "GET" && agentRegistryMatch) {
    if (!checkToken(req)) return unauthorized();
    return agentPassportHandler(req, decodeURIComponent(agentRegistryMatch[1]));
  }
  if (method === "POST" && pathname === "/api/insights/scan") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return insightsScanHandler(req);
  }
  if (method === "POST" && pathname === "/api/insights/bulk-apply") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return insightsBulkApplyHandler(req);
  }
  if (method === "POST" && pathname === "/api/insights/bulk-ack") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return insightsBulkAcknowledgeHandler(req);
  }
  if (method === "POST" && pathname === "/api/insights/bulk-snooze") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return insightsBulkSnoozeHandler(req);
  }
  if (method === "GET" && pathname === "/api/insights/auto-apply/preview") {
    if (!checkToken(req)) return unauthorized();
    return insightsAutoApplyPreviewHandler(req);
  }
  const insightActionMatch = pathname.match(/^\/api\/insights\/([^/]+)\/(apply|dismiss|reanalyze)$/);
  if (method === "POST" && insightActionMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    const insightId = decodeURIComponent(insightActionMatch[1]);
    const action = insightActionMatch[2];
    if (action === "apply") return insightApplyHandler(req, insightId);
    if (action === "reanalyze") return insightsReanalyzeHandler(req, insightId);
    return insightDismissHandler(req, insightId);
  }
  if (method === "GET" && pathname === "/api/actions/audit") {
    if (!checkToken(req)) return unauthorized();
    return actionAuditHandler(url);
  }
  if (method === "GET" && pathname === "/api/governance/audit") return governanceAuditHandler(req);
  if (method === "POST" && pathname === "/api/audit/export") {
    if (!checkToken(req)) return unauthorized();
    return auditExportHandler(url, method, await req.clone().json().catch(() => ({})), req);
  }
  const auditExportMatch = pathname.match(/^\/api\/audit\/export\/([^/]+)(\/download|\/verify)?$/);
  if (auditExportMatch) {
    if (!checkToken(req)) return unauthorized();
    return auditExportHandler(url, method, await req.clone().json().catch(() => ({})), req);
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
  const jobCancelMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
  if (method === "POST" && jobCancelMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return cancelJobHandler(decodeURIComponent(jobCancelMatch[1]), req);
  }
  const jobRetryMatch = pathname.match(/^\/api\/jobs\/([^/]+)\/retry$/);
  if (method === "POST" && jobRetryMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return retryJobHandler(decodeURIComponent(jobRetryMatch[1]), req);
  }
  if (method === "GET" && pathname === "/api/admin/health") {
    if (!checkToken(req)) return unauthorized();
    return adminHealthHandler();
  }
  if (method === "GET" && pathname === "/api/admin/briefing") {
    if (!checkToken(req)) return unauthorized();
    return adminBriefingHandler();
  }
  if (method === "GET" && pathname === "/api/admin/search") {
    if (!checkToken(req)) return unauthorized();
    return adminSearchHandler(url);
  }
  if (method === "GET" && pathname === "/api/admin/autofixes") {
    if (!checkToken(req)) return unauthorized();
    return adminAutoFixFeedHandler();
  }
  if (method === "GET" && pathname === "/api/install/status") {
    if (!checkToken(req)) return unauthorized();
    return installStatusHandler();
  }
  if (method === "GET" && pathname === "/api/home") return homeHandler();
  if (method === "GET" && pathname === "/api/product-health") return productHealthHandler();
  if (method === "GET" && pathname === "/api/metrics/showcase") return showcaseMetricsHandler();
  if (method === "GET" && pathname === "/api/events") return eventsHandler(url);
  if (method === "GET" && pathname === "/api/metrics") return metricsHandler(url);
  if (method === "GET" && pathname === "/api/autopipeline") return autopipelineHandler();
  if (method === "GET" && pathname === "/api/doctor") return doctorHandler(url);
  if (method === "GET" && pathname === "/api/models") return modelsHandler();
  if (method === "GET" && pathname === "/api/agent-team") return agentTeamHandler();
  const agentTeamJobMatch = pathname.match(/^\/api\/agent-team\/job\/([^/]+)$/);
  if (method === "GET" && agentTeamJobMatch) return agentTeamJobHandler(decodeURIComponent(agentTeamJobMatch[1]));
  if (method === "POST" && pathname === "/api/agent-team/action") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return agentTeamActionHandler(req);
  }
  if (method === "GET" && pathname === "/api/newsbites") return newsBitesHandler();
  if (method === "GET" && pathname === "/api/version") {
    if (shouldRefreshCache()) {
      checkForUpdate().then(setCachedUpdateInfo).catch(() => setCachedUpdateInfo(null));
    }
    return Response.json({ ...getVersionInfo(), updateAvailable: getCachedUpdateInfo() });
  }
  if (method === "POST" && pathname === "/api/update-check") {
    const denied = requireMutation(req);
    if (denied) return denied;
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

  // ── Phase G: public API v1 (G1) + webhooks management (G2) ──────────────
  if (method === "GET" && pathname === "/api/v1/insights") return publicApiInsightsHandler(req);
  if (method === "GET" && pathname === "/api/v1/agents") return publicApiAgentsHandler(req);
  if (method === "GET" && pathname === "/api/v1/audit") return publicApiAuditHandler(req);
  if (method === "GET" && pathname === "/api/v1/trust-score") return publicApiTrustScoreHandler(req);
  if (method === "GET" && pathname === "/api/v1/cost") return publicApiCostHandler(req);
  if (method === "GET" && pathname === "/api/webhooks") return webhooksListHandler(req);
  if (method === "POST" && pathname === "/api/webhooks") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return webhooksCreateHandler(req);
  }
  const webhookDisableMatch = pathname.match(/^\/api\/webhooks\/([^/]+)\/disable$/);
  if (method === "POST" && webhookDisableMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return webhooksDisableHandler(req, decodeURIComponent(webhookDisableMatch[1]));
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
  const incidentAckMatch = pathname.match(/^\/api\/incidents\/([^/]+)\/ack$/);
  if (method === "POST" && incidentAckMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return incidentAckHandler(decodeURIComponent(incidentAckMatch[1]));
  }
  const incidentResolveMatch = pathname.match(/^\/api\/incidents\/([^/]+)\/resolve$/);
  if (method === "POST" && incidentResolveMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return incidentResolveHandler(decodeURIComponent(incidentResolveMatch[1]), req);
  }
  const incidentPostMortemMatch = pathname.match(/^\/api\/incidents\/([^/]+)\/post-mortem$/);
  if (method === "POST" && incidentPostMortemMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return incidentPostMortemHandler(decodeURIComponent(incidentPostMortemMatch[1]), req);
  }
  if (method === "GET" && pathname === "/api/data-explorer/tables") return dataExplorerTablesHandler();
  const dataExplorerTableMatch = pathname.match(/^\/api\/data-explorer\/table\/([^/]+)$/);
  if (method === "GET" && dataExplorerTableMatch) {
    return dataExplorerTableHandler(decodeURIComponent(dataExplorerTableMatch[1]), url);
  }
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
  if (method === "POST" && pathname === "/api/builder/workflows") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return builderCreateWorkflowHandler(req);
  }
  const builderWorkflowMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)$/);
  if (builderWorkflowMatch) {
    if (method === "GET") return builderWorkflowHandler(builderWorkflowMatch[1]);
    if (method === "PUT") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return builderUpdateWorkflowHandler(req, builderWorkflowMatch[1]);
    }
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return builderDeleteWorkflowHandler(builderWorkflowMatch[1]);
    }
  }
  const builderWorkflowActionMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/(start|pause|resume|stop|doctor-review|lifecycle)$/);
  if (method === "POST" && builderWorkflowActionMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    const workflowId = builderWorkflowActionMatch[1];
    const action = builderWorkflowActionMatch[2];
    if (action === "lifecycle") return builderSetLifecycleHandler(workflowId, req);
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
  const builderWorkflowPlanMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/plan$/);
  if (method === "GET" && builderWorkflowPlanMatch) {
    return builderWorkflowPlanHandler(builderWorkflowPlanMatch[1]);
  }
  const builderWorkflowIterateMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/iterate$/);
  if (method === "POST" && builderWorkflowIterateMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return builderWorkflowIterateHandler(builderWorkflowIterateMatch[1], req);
  }
  const builderPreviewMatch = pathname.match(/^\/api\/builder\/workflows\/([^/]+)\/preview$/);
  if (builderPreviewMatch) {
    const wfId = builderPreviewMatch[1];
    if (method === "GET") return builderWorkflowPreviewStatusHandler(wfId);
    if (method === "POST") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return builderWorkflowPreviewStartHandler(wfId, req);
    }
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return builderWorkflowPreviewStopHandler(wfId);
    }
  }
  const builderPassLiveMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/pass-live$/);
  if (method === "GET" && builderPassLiveMatch) {
    return builderPassLiveHandler(builderPassLiveMatch[1]);
  }
  const builderRunSummaryMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/summary$/);
  if (method === "GET" && builderRunSummaryMatch) {
    return builderRunSummaryHandler(builderRunSummaryMatch[1]);
  }
  const builderRunRepairMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/repair-baseline$/);
  if (method === "POST" && builderRunRepairMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return builderRepairBaselineHandler(builderRunRepairMatch[1], req);
  }
  const builderPassDiagnosisMatch = pathname.match(/^\/api\/builder\/passes\/([^/]+)\/diagnosis$/);
  if (method === "GET" && builderPassDiagnosisMatch) {
    return builderPassDiagnosisHandler(builderPassDiagnosisMatch[1]);
  }
  const builderRunActionMatch = pathname.match(/^\/api\/builder\/runs\/([^/]+)\/(retry|cancel)$/);
  if (method === "POST" && builderRunActionMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "GET" && pathname === "/api/traces/gateway") return gatewayTracesHandler(req, url);

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
  if (method === "PUT" && pathname === "/api/scout/config") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return updateScoutConfig(req);
  }
  if (method === "POST" && pathname === "/api/scout/trigger") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return triggerScoutRun(req);
  }

  // ── Finance Intel ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/finance-intel/stats") return getFinanceStats(req);
  if (method === "GET" && pathname === "/api/finance-intel/runs") return getFinanceRuns(req);
  if (method === "GET" && pathname === "/api/finance-intel/enrichments") return getFinanceEnrichments(req);
  if (method === "GET" && (pathname === "/api/finance-intel/portfolio-config" || pathname === "/api/finance-intel/portfolio-configs")) {
    return getPortfolioConfigs(req);
  }
  const financeTriggerMatch = pathname.match(/^\/api\/finance-intel\/(trigger-analysis|portfolio-configs?)$/);
  if (method === "POST" && financeTriggerMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
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
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "POST" && dossierInjectMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return injectDossierNotes(req, dossierInjectMatch[1], dossierInjectMatch[2]);
  }

  // ── Model Routing ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/models/routing-log") return getRoutingLogs(req);
  if (method === "GET" && pathname === "/api/models/routing-stats") return getRoutingStats(req);
  if (method === "POST" && pathname === "/api/models/force-route") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return forceRouteModel(req);
  }
  const modelForceMatch = pathname.match(/^\/api\/models\/force-route\/([^/]+)$/);
  if (method === "DELETE" && modelForceMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return clearForceRoute(req);
  }

  // Gateway
  if (method === "GET" && pathname === "/api/gateway/status") return gatewayStatusHandler();
  if (method === "GET" && pathname === "/api/gateway") return gatewayStatusHandler();
  if (method === "GET" && pathname === "/api/gateway/models") return gatewayModelsHandler();
  if (method === "GET" && pathname === "/api/gateway/ledger") return gatewayLedgerHandler(url);
  if (method === "GET" && pathname === "/api/gateway/stats") return gatewayStatsHandler(url);
  if (method === "GET" && pathname === "/api/gateway/showback") return gatewayShowbackHandler(req);
  const gatewayCircuitMatch = pathname.match(/^\/api\/gateway\/circuits\/([^/]+)\/(reset|half-open)$/);
  if (method === "POST" && gatewayCircuitMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return gatewayCircuitActionHandler(req, gatewayCircuitMatch[1], gatewayCircuitMatch[2] as "reset" | "half-open");
  }
  if (method === "POST" && pathname === "/api/gateway/probe") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return gatewayProbeHandler(req);
  }
  if (method === "POST" && pathname === "/api/gateway/route-healthiest") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return gatewayRouteHealthiestHandler(req);
  }
  if (method === "GET" && pathname === "/api/gateway/keys") {
    return listGatewayKeysHandler(req);
  }
  if (method === "POST" && pathname === "/api/gateway/keys") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return createGatewayKeyHandler(req);
  }
  const gatewayKeyRevokeMatch = pathname.match(/^\/api\/gateway\/keys\/([^/]+)\/revoke$/);
  if (method === "POST" && gatewayKeyRevokeMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return revokeGatewayKeyHandler(req, decodeURIComponent(gatewayKeyRevokeMatch[1]));
  }

  // Cost Alias
  if (method === "GET" && pathname === "/api/cost") return getCostSummary(req);
  // OpenAI-compatible surface
  if (method === "POST" && pathname === "/v1/chat/completions") return v1ChatCompletionsHandler(req);
  if (method === "GET" && pathname === "/v1/models") return v1ModelsHandler();

  if (method === "POST" && pathname === "/api/builder/provision") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return builderProvisionHandler(req);
  }

  // Mission Control, Today, Workload, Settings
  if (method === "GET" && pathname === "/api/mission-control") return missionControlHandler();
  if (method === "GET" && pathname === "/api/today") return todayHandler();
  if (method === "GET" && pathname === "/api/workload") return workloadHandler(req);
  if (method === "GET" && pathname === "/api/settings/auth-status") return settingsAuthStatusHandler();
  if (method === "GET" && pathname === "/api/settings/access") return settingsAccessHandler(req);
  if (method === "POST" && pathname === "/api/settings/access/invite") return settingsAccessInviteHandler(req);
  const settingsAccessRoleMatch = pathname.match(/^\/api\/settings\/access\/users\/([^/]+)\/role$/);
  if (method === "PUT" && settingsAccessRoleMatch) {
    return settingsAccessRoleHandler(req, decodeURIComponent(settingsAccessRoleMatch[1]));
  }
  if (method === "GET" && pathname === "/api/settings/state") {
    if (!checkToken(req)) return unauthorized();
    return settingsStateHandler(url);
  }
  const settingsStateKeyMatch = pathname.match(/^\/api\/settings\/state\/([^/]+)$/);
  if (method === "PUT" && settingsStateKeyMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return settingsStatePutHandler(req, settingsStateKeyMatch[1]);
  }

  // ── Governance ──────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/governance/policies") return governancePoliciesHandler();
  if (method === "POST" && pathname === "/api/governance/policies/reload") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return governancePoliciesReloadHandler();
  }
  if (method === "GET" && pathname === "/api/governance/rbac/me") return governanceRbacMeHandler(req);
  if (method === "GET" && pathname === "/api/governance/approvals") return governanceApprovalsListHandler(req);
  const govApprovalMatch = pathname.match(/^\/api\/governance\/approvals\/([^/]+)\/(approve|reject)$/);
  if (method === "POST" && govApprovalMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return governanceApprovalDecideHandler(req, govApprovalMatch[1], govApprovalMatch[2] as "approve" | "reject");
  }

  // ── Approvals (4-eyes) ──────────────────────────────────────────────────────
  if (method === "POST" && pathname === "/api/approvals") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return approvalCreateHandler(req);
  }
  if (method === "GET" && pathname === "/api/approvals") return approvalsListHandler(req);
  const approvalGetMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (method === "GET" && approvalGetMatch) {
    return approvalGetHandler(req, approvalGetMatch[1]);
  }
  if (method === "POST" && approvalGetMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return approvalVoteHandler(req, approvalGetMatch[1]);
  }
  const approvalExpireMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/expire$/);
  if (method === "POST" && approvalExpireMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "POST" && pathname === "/api/autopipeline/command") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return autopipelineCommandHandler(req);
  }
  if (method === "POST" && pathname === "/api/models/action") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return modelsActionHandler(req);
  }
  if (method === "POST" && pathname === "/api/doctor/scan") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return doctorScanHandler(req);
  }
  if (method === "POST" && pathname === "/api/doctor/requeue") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return doctorRequeuHandler(req);
  }
  if (method === "POST" && pathname === "/api/newsbites/deploy") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return newsBitesDeployHandler(req);
  }

  const articleSlugMatch = pathname.match(/^\/api\/newsbites\/articles\/([^/]+)$/);
  if (articleSlugMatch) {
    const slug = decodeURIComponent(articleSlugMatch[1]);
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return deleteArticleHandler(req, slug);
    }
  }
  const articleActionMatch = pathname.match(/^\/api\/newsbites\/articles\/([^/]+)\/([^/]+)$/);
  if (articleActionMatch) {
    const slug = decodeURIComponent(articleActionMatch[1]);
    const action = articleActionMatch[2];
    if (method === "GET"  && action === "dossier-path")   return articleDossierPathHandler(req, slug);
    if (method === "POST" && action === "refresh-image") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return refreshArticleImageHandler(req, slug);
    }
    if (method === "POST" && action === "upload-image") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return uploadArticleImageHandler(req, slug);
    }
  }

  if (method === "POST" && pathname === "/api/infra/service-restart") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return infraServiceRestartHandler(req);
  }
  if (method === "POST" && pathname === "/api/infra/run-timer") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return infraRunTimerHandler(req);
  }
  if (method === "POST" && pathname === "/api/notifications/rules") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return notificationRuleUpsertHandler(req);
  }
  const notificationRuleMatch = pathname.match(/^\/api\/notifications\/rules\/([^/]+)$/);
  if (method === "POST" && notificationRuleMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return notificationRuleUpsertHandler(req, notificationRuleMatch[1]);
  }
  if (method === "POST" && pathname === "/api/channels/brief/preview") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return channelsBriefPreviewHandler();
  }
  if (method === "POST" && pathname === "/api/channels/brief/send") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return channelsBriefSendHandler();
  }
  if (method === "POST" && pathname === "/api/agents/vault-log") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return agentsVaultLogHandler(req);
  }
  if (method === "POST" && pathname === "/api/actions/execute") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return executeActionHandler(req);
  }

  // ── Codex tab ─────────────────────────────────────────────────────────────
  if (pathname.startsWith("/api/codex/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/codex/sessions") return codexListHandler();
  if (method === "POST" && pathname === "/api/codex/sessions") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return codexCreateHandler(req);
  }
  const codexSessionMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)$/);
  if (codexSessionMatch) {
    if (method === "GET") return codexGetHandler(codexSessionMatch[1]);
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return codexDeleteHandler(codexSessionMatch[1]);
    }
  }
  const codexSendMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/message$/);
  if (method === "POST" && codexSendMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return codexSendHandler(req, codexSendMatch[1]);
  }
  const codexStreamMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && codexStreamMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return codexStreamHandler(req, codexStreamMatch[1]);
  }
  const codexStopMatch = pathname.match(/^\/api\/codex\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && codexStopMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return codexStopHandler(codexStopMatch[1]);
  }

  // ── Claude tab ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/claude/health") return claudeHealthHandler();
  if (pathname.startsWith("/api/claude/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/claude/sessions") return claudeListHandler();
  if (method === "POST" && pathname === "/api/claude/sessions") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return claudeCreateHandler(req);
  }
  const claudeSessionMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)$/);
  if (claudeSessionMatch) {
    if (method === "GET") return claudeGetHandler(claudeSessionMatch[1]);
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return claudeDeleteHandler(claudeSessionMatch[1]);
    }
  }
  const claudeStreamMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && claudeStreamMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return claudeStreamHandler(req, claudeStreamMatch[1]);
  }
  const claudeStopMatch = pathname.match(/^\/api\/claude\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && claudeStopMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return claudeStopHandler(claudeStopMatch[1]);
  }

  // ── Gemini tab ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/gemini/health") return geminiHealthHandler();
  if (pathname.startsWith("/api/gemini/") && !checkToken(req)) return unauthorized();
  if (method === "GET" && pathname === "/api/gemini/sessions") return geminiListHandler();
  if (method === "POST" && pathname === "/api/gemini/sessions") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return geminiCreateHandler(req);
  }
  const geminiSessionMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)$/);
  if (geminiSessionMatch) {
    if (method === "GET") return geminiGetHandler(geminiSessionMatch[1]);
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return geminiDeleteHandler(geminiSessionMatch[1]);
    }
  }
  const geminiStreamMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)\/stream$/);
  if (method === "POST" && geminiStreamMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return geminiStreamHandler(req, geminiStreamMatch[1]);
  }
const geminiStopMatch = pathname.match(/^\/api\/gemini\/sessions\/([^/]+)\/stop$/);
  if (method === "POST" && geminiStopMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return geminiStopHandler(geminiStopMatch[1]);
  }

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
    if (method === "POST") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return reasonerResolveIncidentHandler(reasonerIncidentMatch[1]);
    }
  }
  const reasonerPostMortemMatch = pathname.match(/^\/api\/reasoner\/incidents\/([^/]+)\/post-mortem$/);
  if (method === "GET" && reasonerPostMortemMatch) {
    return reasonerIncidentPostMortemHandler(reasonerPostMortemMatch[1]);
  }
  if (method === "GET" && pathname === "/api/reasoner/playbooks") return reasonerPlaybooksHandler();
  const reasonerApplyPlaybookMatch = pathname.match(/^\/api\/reasoner\/playbooks\/([^/]+)\/apply$/);
  if (method === "POST" && reasonerApplyPlaybookMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return reasonerApplyPlaybookHandler(reasonerApplyPlaybookMatch[1], req);
  }

  if (method === "GET" && pathname === "/api/orchestrator/signals") {
    if (!checkToken(req)) return unauthorized();
    return orchestratorSignalsListHandler(url);
  }
  if (method === "POST" && pathname === "/api/orchestrator/signals") {
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "POST" && pathname === "/api/tenants") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return tenantsCreateHandler(req);
  }
  const tenantMatch = pathname.match(/^\/api\/tenants\/([^/]+)$/);
  if (tenantMatch) {
    if (method === "GET") return tenantGetHandler(req, tenantMatch[1]);
    if (method === "PATCH") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return tenantPatchHandler(req, tenantMatch[1]);
    }
  }
  const tenantTmuxMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/tmux-status$/);
  if (tenantTmuxMatch) {
    if (method === "GET") return tenantTmuxStatusHandler(req, tenantTmuxMatch[1]);
  }

  // ── Projects ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/projects") return projectsListHandler(req, url);
  if (method === "POST" && pathname === "/api/projects") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return projectsCreateHandler(req);
  }
  if (method === "POST" && pathname === "/api/projects/detect") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return projectsDetectHandler(req);
  }
  const projectMatch = pathname.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch) {
    if (method === "GET") return projectGetHandler(req, projectMatch[1]);
    if (method === "PATCH") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return projectPatchHandler(req, projectMatch[1]);
    }
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return projectDeleteHandler(req, projectMatch[1]);
    }
  }

  // ── SSO ────────────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/sso/config") return ssoConfigGetHandler(req);
  if (method === "PUT" && pathname === "/api/sso/config") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return ssoConfigPutHandler(req);
  }
  if (method === "POST" && pathname === "/api/sso/config") {
    return ssoConfigPostHandler(req);
  }
  if (method === "GET" && pathname === "/api/sso/login") return ssoLoginHandler(req);
  if (method === "GET" && pathname === "/api/sso/callback") return ssoCallbackHandler(req);
  if (method === "POST" && pathname === "/api/sso/logout") return ssoLogoutHandler(req);
  if (method === "GET" && pathname === "/api/sso/session") return ssoSessionHandler(req);

  // ── Marketplace ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/marketplace/skills") return marketplaceListHandler(req);
  if (method === "POST" && pathname === "/api/marketplace/skills/install") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return marketplaceInstallHandler(req);
  }
  const marketplaceDeleteMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)$/);
  if (method === "DELETE" && marketplaceDeleteMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return marketplaceDeleteHandler(req, marketplaceDeleteMatch[1]);
  }
  const marketplaceEnableMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/enable$/);
  if (method === "POST" && marketplaceEnableMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return marketplaceEnableHandler(req, marketplaceEnableMatch[1]);
  }
  const marketplaceDisableMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/disable$/);
  if (method === "POST" && marketplaceDisableMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return marketplaceDisableHandler(req, marketplaceDisableMatch[1]);
  }
  const marketplaceRunMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/run$/);
  if (method === "POST" && marketplaceRunMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return marketplaceRunHandler(req, marketplaceRunMatch[1]);
  }
  const marketplaceRunsMatch = pathname.match(/^\/api\/marketplace\/skills\/([^/]+)\/runs$/);
  if (method === "GET" && marketplaceRunsMatch) return marketplaceRunsHandler(req, marketplaceRunsMatch[1]);

  // ── Reports ─────────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/reports") return reportsListHandler(req);
  if (method === "GET" && pathname === "/api/reports/templates") return reportsTemplatesHandler();
  if (method === "POST" && pathname === "/api/reports/run") {
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "POST" && pathname === "/api/reports/digest") {
    const denied = requireMutation(req);
    if (denied) return denied;
    try {
      const { text, sent } = await generateOperatorDigest({ force: true });
      return new Response(
        JSON.stringify({ sent, preview: text.slice(0, 200), length: text.length }),
        { headers: { "Content-Type": "application/json" } },
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return new Response(JSON.stringify({ error: errMsg }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const reportVaultMatch = pathname.match(/^\/api\/reports\/([^/]+)\/export-vault$/);
  if (method === "POST" && reportVaultMatch) {
    const denied = requireMutation(req);
    if (denied) return denied;
    return reportsExportVaultHandler(req, reportVaultMatch[1]);
  }

  // ── Tenant Settings ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/tenant/settings") return tenantSettingsGetHandler(req);
  if (method === "PUT" && pathname === "/api/tenant/settings") {
    const denied = requireMutation(req);
    if (denied) return denied;
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
  if (method === "POST" && pathname === "/api/onboarding/step") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return onboardingStepHandler(req);
  }

  // ── Docs / Tutorials ──────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/docs/tutorials") return docsTutorialsHandler();

  // ── Cloud Tier ────────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/cloud-tier/status") return cloudTierStatusHandler();

  // ── Cost Management ───────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/cost/budgets") return getBudgets(req);
  if (method === "POST" && pathname === "/api/cost/budgets") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return createBudget(req);
  }
  if (method === "GET" && pathname === "/api/cost/spend") return getSpend(req);
  if (method === "GET" && pathname === "/api/cost/runway/vast") return getVastRunway(req);
  if (method === "GET" && pathname.startsWith("/api/cost/attribution/")) return getAttribution(req);
  if (method === "GET" && pathname === "/api/cost/fallbacks") return getFallbacks(req);
  if (method === "POST" && pathname === "/api/cost/recommendations") return getRecommendations(req);
  if (method === "GET" && pathname === "/api/cost/summary") return getCostSummary(req);

  // ── AI Discovery & Inventory (Phase 4a) ─────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/discovery/assets") return discoveryListAssetsHandler(req, url);
  if (method === "POST" && pathname === "/api/discovery/rescan") return discoveryRescanHandler(req);
  const discoveryAssetRegMatch = pathname.match(/^\/api\/discovery\/assets\/([^/]+)\/register$/);
  if (method === "POST" && discoveryAssetRegMatch) return discoveryRegisterAssetHandler(req, decodeURIComponent(discoveryAssetRegMatch[1]));
  const discoveryAssetIgnoreMatch = pathname.match(/^\/api\/discovery\/assets\/([^/]+)\/ignore$/);
  if (method === "POST" && discoveryAssetIgnoreMatch) return discoveryIgnoreAssetHandler(req, decodeURIComponent(discoveryAssetIgnoreMatch[1]));

  // ── Compliance (Phase 7) ────────────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/compliance/dpa") return complianceDpaHandler(req);
  if (method === "GET" && pathname === "/api/compliance/subprocessors") return complianceSubprocessorsHandler();
  if (method === "GET" && pathname === "/api/compliance/soc2-mapping") return complianceSoc2MappingHandler();
  if (method === "GET" && pathname === "/api/compliance/summary") return complianceSummaryHandler(req);
  if (method === "GET" && pathname === "/api/compliance/evidence-bundle") return complianceEvidenceBundleHandler(req);
  if (method === "POST" && pathname === "/api/compliance/evidence-pack") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return complianceEvidencePackGenerateHandler(req);
  }
  const evidencePackMatch = pathname.match(/^\/api\/compliance\/evidence-pack\/([^/]+)$/);
  if (method === "GET" && evidencePackMatch) {
    const roleErr = requireInsightPermission(req, "insights.view");
    if (roleErr) return roleErr;
    return complianceEvidencePackGetHandler(req, decodeURIComponent(evidencePackMatch[1]));
  }

  // ── Feature Flags (Phase 15) ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/feature-flags") return featureFlagsListHandler(req);
  if (method === "POST" && pathname === "/api/feature-flags") {
    const denied = requireMutation(req);
    if (denied) return denied;
    return featureFlagsCreateHandler(req);
  }
  const featureFlagMatch = pathname.match(/^\/api\/feature-flags\/([^/]+)$/);
  if (featureFlagMatch) {
    const flagId = decodeURIComponent(featureFlagMatch[1]);
    if (method === "GET") return featureFlagsGetHandler(req, flagId);
    if (method === "PATCH" || method === "POST") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return featureFlagsUpdateHandler(req, flagId);
    }
    if (method === "DELETE") {
      const denied = requireMutation(req);
      if (denied) return denied;
      return featureFlagsDeleteHandler(req, flagId);
    }
  }
  const featureFlagHistoryMatch = pathname.match(/^\/api\/feature-flags\/([^/]+)\/history$/);
  if (method === "GET" && featureFlagHistoryMatch) {
    return featureFlagsHistoryHandler(req, decodeURIComponent(featureFlagHistoryMatch[1]));
  }

  // ── Brainstormer ─────────────────────────────────────────────────────────────────
  if (pathname.startsWith('/api/brainstorm/preflight/')) {
    const strippedPath = pathname.replace('/api/brainstorm/preflight', '');
    const innerReq = new Request(new URL(strippedPath + url.search, url.origin).toString(), req);
    return preflightApp.fetch(innerReq);
  }
  if (pathname === '/api/brainstorm/stream') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const { tenantId } = getCurrentTenantContext();
    return brainstormStreamHandler(tenantId, sessionId);
  }
  if (pathname.startsWith('/api/brainstorm/')) {
    const strippedPath = pathname.replace('/api/brainstorm', '');
    const innerReq = new Request(new URL(strippedPath + url.search, url.origin).toString(), req);
    return brainstormApp.fetch(innerReq);
  }

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

async function complianceEvidencePackGenerateHandler(req: Request): Promise<Response> {
  const result = generateEvidencePack();

  try {
    writeActionAudit({
      actorSource: "dashboard",
      actionKind: "compliance.evidence-pack",
      targetType: "compliance",
      targetId: result.id,
      risk: "low",
      resultStatus: "success",
      resultJson: { id: result.id },
    });
  } catch (auditErr) {
    console.error("[compliance/evidence-pack] failed to write audit row", auditErr);
  }

  const envelope: ApiEnvelope<{ id: string }> = ok({ id: result.id });
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}

function complianceEvidencePackGetHandler(req: Request, id: string): Response {
  const pack = readEvidencePackById(id);
  if (!pack) {
    return new Response(
      JSON.stringify({ error: "Evidence pack not found. Generate a new one with POST /api/compliance/evidence-pack." }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }

  const envelope: ApiEnvelope<typeof pack> = ok(pack);
  return new Response(JSON.stringify(envelope), {
    headers: { "Content-Type": "application/json" },
  });
}
