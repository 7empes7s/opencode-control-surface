export type SourceStatus = "ok" | "error" | "stale";

export interface ApiEnvelope<T> {
  generatedAt: string;
  sourceStatus: Record<string, SourceStatus>;
  data: T;
}

export function ok<T>(data: T, sources: Record<string, SourceStatus> = {}): ApiEnvelope<T> {
  return { generatedAt: new Date().toISOString(), sourceStatus: sources, data };
}

// ── Shared primitives ─────────────────────────────────────────────────────

export interface EvidenceRef {
  label: string;
  kind: "file" | "api" | "command" | "log" | "git" | "url" | "db";
  ref: string;
  redacted?: boolean;
}

// ── Dossier types ─────────────────────────────────────────────────────

export interface DossierSource {
  url: string;
  type: string;
  publisher: string;
  date: string;
  notes: string;
}

export interface DossierClaim {
  claim: string;
  sources: string;
  evidenceQuality: string;
  confidence: string;
  notes: string;
}

export interface AgentRun {
  id: string;
  stage: string;
  startedAt: string;
  durationMs: number | null;
  metadata: any;
  response: any;
}

export interface DossierArtifacts {
  slug: string;
  date: string;
  header: {
    slug: string;
    headline: string;
    vertical: string;
    owner: string;
    created: string;
    updated: string;
    status: string;
  };
  sources: DossierSource[];
  claims: DossierClaim[];
  draftContent: string;
  verifyContent: string | null;
  publishContent: string;
  notesContent: string;
  agentRuns: AgentRun[];
}

export interface ActionDescriptor {
  id: string;
  label: string;
  kind:
    | "navigate"
    | "refresh"
    | "run-command"
    | "start-job"
    | "mutate-policy"
    | "open-shell"
    | "open-workspace"
    | "open-source"
    | "create-agent-task"
    | "acknowledge"
    | "resolve"
    | "mute"
    | "external-link"
    | "copy-command"
    | "export"
    | "preview";
  targetType: string;
  targetId: string;
  risk: "low" | "medium" | "high" | "destructive";
  confirm: boolean;
  reasonRequired: boolean;
  disabled?: boolean;
  disabledReason?: string;
  evidenceRefs: EvidenceRef[];
  impactPreview?: string;
  rollbackHint?: string;
  expectedDurationMs?: number;
  jobKind?: string;
  sourceRoute?: string;
  requiresOnline?: boolean;
}

export interface ActionableEntity<T> {
  entity: T;
  health: "ok" | "warn" | "critical" | "unknown";
  freshness: "fresh" | "stale" | "missing";
  evidence: EvidenceRef[];
  actions: ActionDescriptor[];
}

export interface ServicePill {
  name: string;
  status: "active" | "inactive" | "failed" | "unknown";
}

export interface TimerInfo {
  name: string;
  active: boolean;
  nextElapseMs: number | null;
  lastTrigger: string | null;
}

// ── Home payload ──────────────────────────────────────────────────────────

export interface HomeData {
  services: ServicePill[];
  gpu: GpuWidget;
  vast: VastWidget;
  hetzner: HetznerWidget;
  newsbites: NewsBitesWidget;
  autopipeline: AutopipelineWidget;
  doctor: DoctorWidget;
  models: ModelsWidget;
  incidents: IncidentsWidget;
  opencode: OpenCodeWidget;
}

export interface OpenCodeWidget {
  reachable: boolean;
  sessionCount: number | null;
  active24h: number | null;
  latestUpdatedAt: number | null;
}

export interface GpuWidget {
  status: "up" | "down" | "off" | "unknown";
  gpuUtil: number | null;
  loadedModels: string[];
  probeMs: number | null;
  checkedAgo: number;
  note: string | null;
}

export interface VastWidget {
  balance: number | null;
  credit: number | null;
  hourlyRate: number | null;
  runwayHours: number | null;
  instanceStatus: string | null;
  gpu: string | null;
}

export interface HetznerWidget {
  load1: number;
  load5: number;
  load15: number;
  memUsedPct: number;
  diskUsedPct: number;
}

export interface NewsBitesWidget {
  totalPublished: number;
  publishedToday: number;
  publishedLast7d: number[];
  topVerticals: { vertical: string; count: number }[];
  latestArticles: { slug: string; title: string; vertical: string; date: string }[];
  siteReachable: boolean;
}

export interface AutopipelineWidget {
  queueDepth: number;
  approvalsWaiting: number;
  oldestApprovalAgeMs: number | null;
  currentStory: { slug?: string; stage: string; id: string } | null;
  paused: boolean;
  pauseReason: string | null;
  stageBreakdown: Record<string, number>;
}

export interface DoctorWidget {
  last24h: {
    total: number;
    success: number;
    errorClasses: { type: string; count: number }[];
    topFailingModels: { model: string; count: number }[];
    topFailingStages: { stage: string; count: number }[];
    verdictMix: { action: string; count: number }[];
    rateLimitProviders?: { provider: string; count: number; models: string[]; storySlugs: string[] }[];
    fallbackCascades?: { model: string; stage: string; count: number; errorType: string; storySlugs: string[] }[];
  };
  lastDecision: { ts: string; slug: string; action: string; reason: string } | null;
}

export interface ModelsWidget {
  bestLocal: string | null;
  bestCloudHeavy: string | null;
  bestCloudFast: string | null;
  availableByCapability: { heavy: number; medium: number; light: number };
  qualitySummary: { blocked: number; degraded: number; probation: number };
  newModelsAdded: string[];
  lastFullCheckAgo: number;
  lastQuickCheckAgo: number;
  cooldownsActive: number;
  soonestCooldownExpiresMs: number | null;
}

export interface IncidentsWidget {
  activeCount: number;
  recentAlerts: { key: string; ts: number }[];
}

// ── Detail page payloads ──────────────────────────────────────────────────────

export interface AutopipelineDetail {
  queue: {
    id: string;
    slug?: string;
    stage: string;
    priority: number;
    waitingApproval: boolean;
    running: boolean;
    createdAt?: number;
    elapsedMs?: number;
    dossierDate?: string;
    dossierSlug?: string;
  }[];
  current: { id: string; slug?: string; stage: string } | null;
  paused: boolean;
  pauseReason: string | null;
  stats: {
    queueDepth: number;
    approvalsWaiting: number;
    oldestApprovalAgeMs: number | null;
    stageBreakdown: Record<string, number>;
  };
  stageDurations: { stage: string; p50Ms: number; p95Ms: number; sampleCount: number }[];
}

export interface DoctorDetail {
  entries: {
    ts: string;
    slug: string;
    stage: string;
    action: string;
    reason: string;
    errorType: string;
    failedModel: string;
    nextStage?: string;
    cooldownMs?: number;
  }[];
  stats: {
    total: number;
    successRate: number;
    errorClasses: { type: string; count: number }[];
    topFailingModels: { model: string; count: number }[];
    topFailingStages: { stage: string; count: number }[];
    verdictMix: { action: string; count: number }[];
  };
  lastDecision: { ts: string; slug: string; action: string; reason: string } | null;
}

export interface WorkloadScores {
  json: number | null;
  coding: number | null;
  writing: number | null;
  reasoning: number | null;
  lastProbedAt?: number | null;
}

export interface RatingBreakdown {
  score: number;
  confidence: number;
  sources: string[];
  missing: string[];
  components: Record<string, { score: number; weight: number; contribution: number }>;
}

export interface ModelsDetail {
  models: {
    logicalName: string;
    provider: string;
    capability: string;
    available: boolean;
    latency: number | null;
    jsonOk: boolean;
    checkedAt: number;
    qualityStatus: string;
    recentFailures: number;
    consecutiveGarbage: number;
    isFree: boolean;
    isPaid: boolean;
    isOpenCode: boolean;
    isCli: boolean;
    providerType: "openrouter" | "groq" | "github" | "cerebras" | "local" | "zen" | "nvidia" | "cloudflare" | "opencode" | "alibaba" | "other";
    contextWindow: number | null;
    params: number | null;
    resolvedModel: string | null;
    pricingTier?: string | null;
    rating100?: number | null;
    ratingBreakdown?: RatingBreakdown | null;
    workloadScores?: WorkloadScores | null;
  }[];
  cooldowns: { model: string; startedAt: number | null; expiresAt: number; reason?: string }[];
  fallbacks: Record<string, string[]>;
  summary: {
    bestCloudHeavy: string | null;
    bestCloudFast: string | null;
    bestLocal: string | null;
    availableByCapability: { heavy: number; medium: number; light: number };
    qualitySummary: { blocked: number; degraded: number; probation: number };
    lastFullCheckAgo: number;
    lastQuickCheckAgo: number;
    newModelsAdded: string[];
  };
  discoveryLog: { ts: string; newModelsAdded: string[]; totalModelCount: number }[];
}

export interface NewsBitesDetail {
  articles: {
    slug: string;
    title: string;
    status: string;
    date: string;
    vertical: string;
    wordCount: number;
  }[];
  stats: {
    totalPublished: number;
    totalApproved: number;
    totalDraft: number;
    publishedToday: number;
    publishedLast30d: { date: string; count: number }[];
    verticalMix: { vertical: string; count: number }[];
  };
  deploy: {
    lastDeployAt: string | null;
    lastCommitHash: string | null;
    siteReachable: boolean;
  };
}

export interface IncidentsDetail {
  entries: {
    ts: number;
    type: "pipeline-failed" | "doctor-abandoned";
    slug: string;
    stage: string;
    errorType: string;
    severity: "error" | "warning";
  }[];
  stats: {
    total: number;
    last24h: number;
    byErrorType: { type: string; count: number }[];
    byStage: { stage: string; count: number }[];
  };
}

export interface InfraDetail {
  hetzner: {
    load1: number; load5: number; load15: number;
    memTotalKb: number; memUsedKb: number; memUsedPct: number;
    diskTotalGb: number; diskUsedGb: number; diskUsedPct: number;
  };
  vastInstance: {
    id: string; status: string; gpu: string;
    vcpus: number; ramGb: number; diskGb: number;
    hourlyRate: number; ip: string; sshPort: number;
  } | null;
  vastBalance: { balance: number; credit: number; runwayHours: number | null } | null;
  vastHost: {
    status: "ok" | "off" | "unreachable" | "unknown";
    reason: string | null;
    cpuPct: number | null; ramPct: number | null; diskPct: number | null;
    gpuUtilPct: number | null; sampledAt: number;
  } | null;
  gpu: { status: string; gpuUtil: number | null; loadedModels: string[]; checkedAgo: number; note: string | null };
  services: { name: string; status: string }[];
  timers: {
    name: string; active: boolean; runnable?: boolean;
    lastTrigger: string | null; nextElapse: string | null; lastResult: string | null;
  }[];
}

// ── Scout types ─────────────────────────────────────────────────────

export interface ScoutTopic {
  headline: string;
  vertical: string;
  source: string;
  recencyScore: number;
  noveltyScore: number;
  finalScore: number;
  selected: boolean;
  reason: string;
}

export interface ScoutRun {
  id: string;
  runAt: string;
  trigger: string;
  topics: ScoutTopic[];
  queued: string[];
  config: Record<string, any>;
}

export interface ScoutTrace extends ScoutRun {
  id: string;
}

export interface ScoutConfig {
  enabled: boolean;
  frequency: string;
  verticals: string[];
  maxTopicsPerRun: number;
  minNoveltyScore: number;
  minRecencyHours: number;
  autoQueueThreshold: number;
}

// ── System Config types ─────────────────────────────────────────────

export interface SystemConfig {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  config: {
    financeAgent?: {
      enabled: boolean;
      modelOverride?: string;
      processingTimeout?: number;
    };
    pipelineStages?: {
      research?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      write?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      publishPrep?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      verify?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      scout?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
      rank?: {
        model: string;
        enabled: boolean;
        timeout: number;
      };
    };
    alertThresholds?: {
      pipelineFailureRate: number;
      modelResponseTimeMs: number;
      gpuUtilization: number;
    };
    autoPublish?: {
      enabled: boolean;
      verticals: string[];
      approvalRequired: string[];
    };
    approvalWorkflows?: {
      enabled: boolean;
      requiredVerticals: string[];
      maxArticlesPerDay: number;
    };
  };
}

export interface SystemConfigHistory {
  id: string;
  timestamp: string;
  changedBy: string;
  changes: string[];
  configSnapshot: Record<string, any>;
}

// ── LiteLLM Routing Types ──────────────────────────────────────────────────────

export interface LiteLLMRoutingLogEntry {
  id: number;
  loggedAt: string;
  logicalName: string;
  triedModels: Array<{
    model: string;
    status: string;
    latencyMs: number;
    errorCode?: string;
  }>;
  finalModel: string | null;
  totalLatencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  caller: string | null;
  status: 'ok' | 'fallback' | 'failed';
}

export interface LiteLLMRoutingStats {
  logicalName: string;
  totalRequests: number;
  avgLatencyMs: number;
  successCount: number;
  fallbackCount: number;
  failedCount: number;
  avgPromptTokens: number | null;
  avgCompletionTokens: number | null;
}

export interface ForceRouteRequest {
  logicalName: string;
  targetModel: string;
  reason?: string;
}

export interface ForceRouteResponse {
  success: boolean;
  logicalName: string;
  targetModel: string;
  message: string;
}

// ── Agent Team types ────────────────────────────────────────────────────────
 
export interface AgentTeamJobItem {
  id: string;
  type: string;
  goal: string;
  dir: string;
  created: number;
}

export interface AgentTeamJobsState {
  state: string;
  count: number;
  items: AgentTeamJobItem[];
}

export interface AgentTeamCooldown {
  provider: string;
  until: number;
  untilIso: string;
  secondsRemaining: number;
  scope: string;
  msg: string;
}

export interface AgentTeamModels {
  count: number;
  providers: string[];
  usableFree: number;
}

export interface AgentTeamRole {
  role: string;
  mode: string;
  chain: string[];
}

export type AgentTeamLatestReport = {
  file: string;
  head: string;
} | null;

export interface AgentTeamProject {
  name: string;
  path: string;
  capability: string;
  lastImprove: number;
  counts: { queue: number; running: number; done: number; failed: number; rejected: number };
}

export interface AgentTeamDetail {
  jobs: AgentTeamJobsState[];
  cooldowns: AgentTeamCooldown[];
  models: AgentTeamModels;
  roles: AgentTeamRole[];
  projects: AgentTeamProject[];
  latestReport: AgentTeamLatestReport;
  recentActivity: string[];
  selfCorrection?: AgentTeamSelfCorrection;
  generatedAt: string;
}

export interface AgentTeamSelfCorrectionEvent {
  jobId: string;
  goal: string;
  outcome: "rolled-back" | "shipped";
  verdict: string;
  finding: string;
  ts: number;
}

export interface AgentTeamSelfCorrection {
  summary: { audited: number; rolledBack: number; shipped: number };
  events: AgentTeamSelfCorrectionEvent[];
}

export interface AgentTeamJobFile {
  name: string;
  content: string;
}

export interface AgentTeamJobDetail {
  id: string;
  files: AgentTeamJobFile[];
}

// ── Builder Run Outcome types ──────────────────────────────────────────────

export interface PlanProgressSection {
  title: string;
  done: number;
  total: number;
}

export interface PlanNextStep {
  text: string;
  section: string;
}

export interface ChangedFile {
  path: string;
  status: "edited" | "created" | "deleted";
  patchArtifactId?: string | null;
  patchArtifactPath?: string | null;
}

export interface ValidationResultSummary {
  kind: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  items: Array<{
    id: string;
    command: string | null;
    url: string | null;
    status: string;
    error: string | null;
    startedAt: number | null;
    finishedAt: number | null;
  }>;
}

export interface CostModelTraceEntry {
  passId: string;
  passSequence: number;
  agent: string | null;
  model: string | null;
  provider: string | null;
  estimatedCostUsd: number | null;
  latencyMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface FailureDiagnosis {
  failureClass: string;
  title: string;
  whatHappened: string;
  lastActivity: string;
  likelyCause: string;
  suggestedActions: string[];
  confidence: "high" | "medium" | "low";
  evidence: string[];
}

export interface BuilderRunOutcomeResponse {
  runId: string;
  workflowId: string;
  status: string;
  trigger: string;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  passCount: number;
  successPasses: number;
  failedPasses: number;

  planProgress: {
    sections: PlanProgressSection[];
    totalDone: number;
    totalItems: number;
    percentDone: number;
    lastParsedAt: number;
    nextSteps: PlanNextStep[];
    planFile: string;
    error?: string;
  };

  changedFiles: ChangedFile[];

  validationResults: ValidationResultSummary[];

  costModelTrace: CostModelTraceEntry[];

  failureDiagnosis: FailureDiagnosis | null;

  stopReason: string | null;

  recommendedAction: string | null;

  degraded: boolean;
  reason?: string;
}
