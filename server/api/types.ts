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
}

export interface GpuWidget {
  status: "up" | "down" | "unknown";
  gpuUtil: number | null;
  loadedModels: string[];
  probeMs: number | null;
  checkedAgo: number;
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
    cpuPct: number; ramPct: number; diskPct: number;
    gpuUtilPct: number; sampledAt: number;
  } | null;
  gpu: { status: string; gpuUtil: number | null; loadedModels: string[]; checkedAgo: number };
  services: { name: string; status: string }[];
  timers: {
    name: string; active: boolean;
    lastTrigger: string | null; nextElapse: string | null; lastResult: string | null;
  }[];
}
