/**
 * Deterministic acceptance evaluator for the model-routing repair arc.
 *
 * This module deliberately performs no I/O and never reads the clock. The CLI
 * supplies rows, observations, and `generatedAt`; tests can therefore exercise
 * every gate without touching the live database, filesystem, journal, or edge.
 */

export const R0_CUTOFF_MS = 1_784_293_856_000;
export const R1_ACCEPTANCE_START_MS = 1_784_387_842_000;
export const R1_MAX_STATE_AGE_MS = 4 * 60 * 60 * 1_000;
export const R2_RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
export const R2_RATE_LIMIT_MIN_AGE_MS = 48 * 60 * 60 * 1_000;
export const R2_RECOVERY_RULE = "explicit-request+ledger-ok+no-current-prune+3-scheduled-exact-200";

export type CheckVerdict = "PASS" | "PENDING" | "UNVERIFIABLE" | "FAIL";
export type RepairArcOverall = "verified" | "partial" | "unverifiable" | "regressed";
export type MetricValue = number | string | boolean | null;

export interface CheckResult {
  id: string;
  verdict: CheckVerdict;
  note: string;
  metrics: Record<string, MetricValue>;
  evidence: Array<Record<string, unknown>>;
}

export interface RepairArcReport {
  generatedAt: number;
  overall: RepairArcOverall;
  checks: CheckResult[];
}

export interface GatewayCallRow {
  id: number | string;
  ts: number;
  logical_model: string;
  resolved_model: string;
  backend: string;
  success: number | boolean;
  latency_ms: number | null;
  error_class: string | null;
  trace_id: string | null;
  caller?: string | null;
  tenant_id?: string | null;
}

export interface R1HistoryEntry {
  code: number | null;
  category: string;
  streak: number;
  since: number;
  latency: number | null;
}

export interface R1Observation {
  stateTs: number;
  changed: boolean;
  pool: string[];
  live: string[];
  limited: string[];
  dead: string[];
  hang: string[];
  timeout: string[];
  history: Record<string, R1HistoryEntry>;
  malformedHistoryModels?: string[];
  priorPool?: string[];
  priorPoolSource?: "prior-observation" | "unchanged-render";
  invocationId: string;
  invocationResult: string;
  invocationStartedAt?: number;
  invocationFinishedAt?: number;
  timerTriggeredAt?: number;
  timerTriggerId?: string;
  serviceJobId?: string;
  bootId?: string;
  receiptTokenId?: string;
  triggerReceiptVerified?: boolean;
  triggerReceiptPath?: string;
  triggerReceiptSha256?: string;
  terminalReceiptVerified?: boolean;
  terminalReceiptPath?: string;
  terminalReceiptSha256?: string;
  execMainStatus?: number | null;
  invocationMode?: "normal";
  stateSha256?: string;
  scheduled: boolean;
  restartCount24h: number;
}

export interface R1FailureObservation {
  serviceJobId: string | null;
  invocationId: string | null;
  bootId: string | null;
  opportunityId: string;
  receiptTokenId: string;
  triggerReceiptPath: string;
  triggerReceiptSha256: string;
  terminalReceiptPath: string;
  terminalReceiptSha256: string;
  receiptVerified: boolean;
  startedAt: number;
  finishedAt: number;
  result: "failed" | "timeout" | "aborted" | "prestart-failed";
  execMainStatus: number | null;
}

export interface R1ReceiptCoverage {
  status: "complete" | "incomplete" | "unavailable" | "unverifiable" | "violated";
  settledOpportunities: number;
  coveredOpportunities: number;
  missingOpportunityIds?: string[];
  error?: string;
}

export interface R1Input {
  journalAvailable: boolean;
  observations: R1Observation[];
  failures?: R1FailureObservation[];
  receiptCoverage?: R1ReceiptCoverage;
  rollingRestartCount24h?: number;
  acceptanceStartAt?: number;
  error?: string;
}

export interface R2Route {
  logicalName: string;
  resolvedModel?: string | null;
  modelId?: string | null;
  eligible: boolean;
  eligibilityKnown?: boolean;
}

export interface R2ShadowObservation {
  invocationId: string;
  stateTs?: number;
  decisionAt?: number;
  policyVersion?: number;
  ledgerAvailable?: boolean;
  enforced?: boolean;
  scheduled: boolean;
  success: boolean;
  wouldPrune: string[];
  wouldQuarantine: string[];
  litellmBeforeHash?: string;
  litellmAfterHash?: string;
  gatewayBeforeHash?: string;
  gatewayAfterHash?: string;
  litellmChanged?: boolean | null;
  gatewayChanged?: boolean | null;
}

export interface R2Tombstone {
  logicalName: string;
  active: boolean;
  reason?: string;
  recoveryEvidence?: string | null;
}

export interface Exact429Clock {
  logicalName: string;
  first429At: number | null;
  last429At: number | null;
  currentCode: number | null;
  resetAt?: number | null;
  action?: "limited" | "demoted" | "pruned" | null;
}

export interface R2Baseline {
  applyAt: number;
  windowStartAt: number;
  windowEndAt: number;
  capturedAt: number;
  baselineCalls: number;
  baselineRateLimits: number;
  evidenceRef: string;
}

export type R2LiveModeEvidence =
  | { status: "verified"; policyVersion: number; mode: string; enforced: boolean; asOf: number }
  | { status: "missing" }
  | { status: "unavailable"; error: string };

export interface R2Input {
  available: boolean;
  error?: string;
  rows: GatewayCallRow[];
  recentCutoff: number;
  classifierFixAt?: number;
  routes: R2Route[];
  pool: string[];
  managedChains: Record<string, string[]>;
  managedChainsAvailable?: boolean;
  mode: "shadow" | "enforced";
  /** Read directly from the live reprobe state; operator JSON cannot set it. */
  liveModeEvidence?: R2LiveModeEvidence;
  /** Set only by a live, strict enforcement-state reader; operator JSON cannot set it. */
  enforcementStateVerified?: boolean;
  enforcementStateError?: string;
  shadowObservations?: R2ShadowObservation[];
  tombstones?: R2Tombstone[];
  durableRecoveryRule?: string | null;
  policyApproval?: {
    approvedBy: string;
    approvedAt: number;
    activationProvenance: "spec45-manifest";
    recoveryProof: "three-exact-200" | "three-exact-200-plus-canary";
    decayWindowMs: number;
    mixedThrottlePolicy: string;
    implementationTestsPassed: boolean;
    evidenceRef: string;
  } | null;
  transientLedgerFailure?: boolean;
  exact429Clocks?: Exact429Clock[];
  /** Set only after a live exact-code state reader validates the persisted clock. */
  exact429StateVerified?: boolean;
  decayWindowMs?: number;
  baseline?: R2Baseline | null;
  /** Set only after a candidate-bound immutable baseline receipt is validated. */
  baselineVerified?: boolean;
}

export interface ModelsApiObservation {
  available: boolean;
  error?: string;
  anonymousStatus: number | null;
  authenticatedStatus: number | null;
  authConfigured: boolean;
  payload?: unknown;
}

export interface LiveSurfaceObservation {
  available: boolean;
  error?: string;
  healthStatus?: number | null;
  healthOk?: boolean;
  versionStatus?: number | null;
  deployedCommit?: string | null;
  candidateCommit?: string | null;
  modelsShellStatus?: number | null;
  modelsShellContentType?: string | null;
  modelsShellMarker?: boolean | null;
  serviceActive?: boolean | null;
  newErrorEntries?: number | null;
}

export interface WorkRunObservation {
  authorized: boolean;
  authorizationId?: string | null;
  id?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
  success?: boolean | null;
  traceIds?: string[];
  orderedHops?: string[];
  traces?: Array<{ traceId: string; orderedHops: string[] }>;
  hardDeadRouteUsed?: boolean;
  validatorPassed?: boolean | null;
  evidenceRef?: string | null;
  receiptSha256?: string | null;
  receiptVerified?: boolean;
  receiptError?: string | null;
  attemptCount?: number;
  candidateCommit?: string | null;
  expectedCaller?: string | null;
  expectedTenant?: string | null;
  workflowId?: string | null;
  stageId?: string | null;
  builderPassId?: string | null;
  validatorEvidenceRef?: string | null;
  validatorEvidenceSha256?: string | null;
  validatorVerified?: boolean;
  subjectVerified?: boolean;
  deployedCommit?: string | null;
  deploymentObservedAt?: number | null;
  deploymentConfirmedAt?: number | null;
  priorFailures?: Array<{ evidenceRef: string; at: number; reason: string }>;
}

export interface ValidationObservation {
  recordedAt: number;
  commit: string;
  manifestVerified?: boolean;
  candidateTrackedClean?: boolean;
  manifestError?: string;
  classifier: {
    sourceVerified: boolean;
    testsPassed: boolean;
    cases: number;
    evidenceRef: string;
  };
  bounded: {
    focusedTestsPassed: boolean;
    testFiles: number;
    typecheckPassed: boolean;
    buildPassed: boolean;
    forbiddenProcessesSpawned: boolean;
    evidenceRef: string;
  };
  ui: {
    contractTestsPassed: boolean;
    assertions: number;
    evidenceRef: string;
  };
  freshHost: {
    apiOnly: boolean;
    total: number;
    honest: number;
    leak: number;
    crash: number;
    error5xx: number;
    commit: string;
    evidenceRef: string;
  };
}

export interface EvidenceHistoryObservation {
  available: boolean;
  sourceTreesClean?: boolean;
  artifacts: number;
  r1Observations: number;
  r2Observations: number;
  error?: string;
}

export interface AcceptanceLogObservation {
  available: boolean;
  path: string;
  evidencePath: string;
  commit: string;
  recordedAt: number;
  error?: string;
}

export interface OperatorDisposition {
  status: "recovered" | "removed" | "deferred" | "added" | "declined";
  at: number;
  reason?: string | null;
}

export interface RepairArcInput {
  generatedAt: number;
  gatewayRows?: GatewayCallRow[];
  gatewayError?: string;
  r1?: R1Input;
  r2?: R2Input;
  r3?: ModelsApiObservation;
  liveSurface?: LiveSurfaceObservation;
  realWork?: {
    editorial?: WorkRunObservation;
    builder?: WorkRunObservation;
  };
  validation?: ValidationObservation;
  evidenceHistory?: EvidenceHistoryObservation;
  acceptanceLog?: AcceptanceLogObservation;
  r4Disposition?: OperatorDisposition;
  r5Disposition?: OperatorDisposition;
}

const HEALTH_STATES = ["live", "limited", "slow", "degraded", "dead", "hang", "unknown"] as const;
const HEALTH_BUCKETS = ["healthy", "unhealthy", "unknown"] as const;
const TRUSTED_FAILURES = new Set(["rate_limit", "auth", "timeout", "unavailable"]);
const TERMINAL_CODES = new Set([400, 401, 402, 403, 404, 410]);
const ROUTABLE_CODES = new Set([200, 429, 500, 503]);
const NATURAL_CALLERS = new Set(["insights-ai", "admin-briefing"]);
const SECRET_KEY = /^(?:authorization|(?:api|access|refresh|auth|operator)?[_-]?token|secret|password|credential|api[_-]?key|request[_-]?body|environment|env)$/i;
const SYNTHETIC_IDENTITY = /(?:^|[-_.:/])(demo|test|synthetic|fixture|fresh[-_]?host|spec)(?:$|[-_.:/])/i;
const MAX_CHECK_EVIDENCE_ROWS = 256;
const MAX_EVIDENCE_ARRAY_ITEMS = 256;
const MAX_EVIDENCE_STRING_CHARS = 2_048;

function boundEvidenceValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED_DEPTH]";
  if (typeof value === "string") {
    return value.length <= MAX_EVIDENCE_STRING_CHARS ? value : `${value.slice(0, MAX_EVIDENCE_STRING_CHARS)}[TRUNCATED]`;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_EVIDENCE_ARRAY_ITEMS).map((entry) => boundEvidenceValue(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .slice(0, 64)
      .map(([key, entry]) => [key, boundEvidenceValue(entry, depth + 1)]));
  }
  return value;
}

function result(
  id: string,
  verdict: CheckVerdict,
  note: string,
  metrics: Record<string, MetricValue> = {},
  evidence: Array<Record<string, unknown>> = [],
): CheckResult {
  const bounded = evidence.slice(0, MAX_CHECK_EVIDENCE_ROWS)
    .map((entry) => boundEvidenceValue(entry) as Record<string, unknown>);
  const boundedMetrics = evidence.length > MAX_CHECK_EVIDENCE_ROWS
    ? { ...metrics, evidenceRowsTotal: evidence.length, evidenceRowsRetained: bounded.length, evidenceTruncated: true }
    : metrics;
  return { id, verdict, note, metrics: boundedMetrics, evidence: bounded };
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isExactRouteName(value: unknown): value is string {
  return isNonEmpty(value) && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value);
}

function isCommitId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{7,40}$/i.test(value);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function r1OpportunityAt(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^model-fallback-reprobe\.timer@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)$/);
  if (!match) return null;
  const parsed = Date.parse(match[1]!);
  return Number.isFinite(parsed) ? parsed : null;
}

function isR1ReceiptPath(value: unknown, kind: "trigger" | "terminal"): value is string {
  if (typeof value !== "string") return false;
  return kind === "trigger"
    ? /^\/var\/lib\/mimule\/model-fallback-reprobe\.triggers\/consumed\/trigger-\d{8}T\d{6}Z-[a-f0-9-]{36}\.json$/i.test(value)
    : /^\/var\/lib\/mimule\/model-fallback-reprobe\.receipts\/terminal-\d{8}T\d{6}Z-[a-f0-9-]{36}\.json$/i.test(value);
}

function commitsMatch(left: string, right: string): boolean {
  return left.startsWith(right) || right.startsWith(left);
}

function isSuccess(value: number | boolean): boolean {
  return value === true || value === 1;
}

function validLatency(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeEpochMs(value: number): number {
  return value > 0 && value < 100_000_000_000 ? value * 1_000 : value;
}

function probeCategory(code: number): "routable" | "dead" | "timeout" | "other" {
  if (ROUTABLE_CODES.has(code)) return "routable";
  if (TERMINAL_CODES.has(code)) return "dead";
  if (code === 0 || code === 408) return "timeout";
  return "other";
}

function compareRows(a: GatewayCallRow, b: GatewayCallRow): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  const aId = typeof a.id === "number" ? a.id : String(a.id);
  const bId = typeof b.id === "number" ? b.id : String(b.id);
  if (typeof aId === "number" && typeof bId === "number") return aId - bId;
  return String(aId).localeCompare(String(bId), "en", { numeric: true });
}

function canonicalList(values: readonly string[]): string[] {
  return [...new Set(values.filter(isNonEmpty))].sort();
}

function canonicalDecision(prune: readonly string[], quarantine: readonly string[]): string {
  return JSON.stringify({ prune: canonicalList(prune), quarantine: canonicalList(quarantine) });
}

function stateDistributionKey(observation: R1Observation): string {
  return JSON.stringify({
    live: canonicalList(observation.live),
    limited: canonicalList(observation.limited),
    dead: canonicalList(observation.dead),
    hang: canonicalList(observation.hang),
    timeout: canonicalList(observation.timeout),
  });
}

function poolKey(observation: R1Observation): string {
  // Pool order is routing policy and is intentionally not sorted.
  return JSON.stringify(observation.pool);
}

export function overallFromChecks(checks: CheckResult[]): RepairArcOverall {
  if (checks.some((check) => check.verdict === "FAIL")) return "regressed";
  if (checks.some((check) => check.verdict === "UNVERIFIABLE")) return "unverifiable";
  if (checks.some((check) => check.verdict === "PENDING")) return "partial";
  return "verified";
}

export function exitCodeForOverall(overall: RepairArcOverall): 0 | 2 | 3 {
  if (overall === "verified") return 0;
  if (overall === "regressed") return 2;
  return 3;
}

export function evaluateR0(rows: GatewayCallRow[] | undefined, readError?: string, generatedAt = Number.POSITIVE_INFINITY): CheckResult[] {
  if (!rows) {
    const note = readError ? `Gateway ledger could not be read: ${sanitizeError(readError)}` : "Gateway ledger input is unavailable.";
    return [
      result("r0.trace_coverage", "UNVERIFIABLE", note),
      result("r0.request_outcomes", "UNVERIFIABLE", note),
    ];
  }
  const futureRows = rows.filter((row) => Number.isFinite(row.ts) && row.ts > generatedAt);
  if (futureRows.length > 0) {
    const evidence = futureRows.map((row) => ({ id: row.id, ts: row.ts, invariant: "row_within_query_ceiling" }));
    return [
      result("r0.trace_coverage", "FAIL", "Gateway rows exceed the attested query-window ceiling.", { futureRows: futureRows.length }, evidence),
      result("r0.request_outcomes", "FAIL", "Gateway rows exceed the attested query-window ceiling.", { futureRows: futureRows.length }, evidence),
    ];
  }

  const postCutoff = rows.filter((row) => Number.isFinite(row.ts) && row.ts >= R0_CUTOFF_MS).sort(compareRows);
  const litellm = postCutoff.filter((row) => row.backend === "litellm");
  const direct = postCutoff.filter((row) => row.backend === "cli-direct");
  const missingLiteTrace = litellm.filter((row) => !isNonEmpty(row.trace_id));
  const missingDirectTrace = direct.filter((row) => !isNonEmpty(row.trace_id));
  const missingDirectTenant = direct.filter((row) => !isNonEmpty(row.tenant_id));
  const writerRows = litellm.length + direct.length;
  const covered = writerRows > 0
    && missingLiteTrace.length === 0
    && missingDirectTrace.length === 0
    && missingDirectTenant.length === 0;
  const traceMetrics = {
    cutoffMs: R0_CUTOFF_MS,
    postCutoffRows: postCutoff.length,
    requiredWriterRows: writerRows,
    litellmRows: litellm.length,
    cliDirectRows: direct.length,
    litellmTraceCoveragePct: litellm.length === 0 ? null : ((litellm.length - missingLiteTrace.length) / litellm.length) * 100,
    cliDirectTraceCoveragePct: direct.length === 0 ? null : ((direct.length - missingDirectTrace.length) / direct.length) * 100,
    cliDirectTenantCoveragePct: direct.length === 0 ? null : ((direct.length - missingDirectTenant.length) / direct.length) * 100,
  };
  const missingEvidence = [
    ...missingLiteTrace.map((row) => ({ writer: "litellm", id: row.id, missing: "trace_id" })),
    ...missingDirectTrace.map((row) => ({ writer: "cli-direct", id: row.id, missing: "trace_id" })),
    ...missingDirectTenant.map((row) => ({ writer: "cli-direct", id: row.id, missing: "tenant_id" })),
  ];
  const traceCheck = writerRows === 0
    ? result("r0.trace_coverage", "PENDING", postCutoff.length === 0
      ? "No rows exist after the exact R0/R0b cutoff."
      : "Post-cutoff rows exist, but none came from a required LiteLLM or cli-direct writer.", traceMetrics)
    : covered
      ? result("r0.trace_coverage", "PASS", "Post-cutoff LiteLLM trace and direct-writer trace/tenant coverage are 100%.", traceMetrics)
      : result("r0.trace_coverage", "FAIL", "At least one post-cutoff writer row is missing a required identifier.", traceMetrics, missingEvidence);

  if (postCutoff.length === 0 || litellm.length === 0) {
    return [
      traceCheck,
      result("r0.request_outcomes", "PENDING", "No post-cutoff LiteLLM requests are available for request-level evaluation.", {
        requests: 0,
        successfulRequests: 0,
        requestSuccessRatePct: null,
        naturalMultiHopRequests: 0,
        wastedAttempts: 0,
      }),
    ];
  }

  const untraceable = litellm.filter((row) => !isNonEmpty(row.trace_id));
  if (untraceable.length > 0) {
    return [
      traceCheck,
      result("r0.request_outcomes", "FAIL", "Request-level grouping is inconsistent because a LiteLLM row lacks trace_id.", {
        requests: 0,
        successfulRequests: 0,
        requestSuccessRatePct: null,
        naturalMultiHopRequests: 0,
        wastedAttempts: 0,
      }, untraceable.map((row) => ({ id: row.id, ts: row.ts }))),
    ];
  }

  const grouped = new Map<string, GatewayCallRow[]>();
  for (const row of litellm) {
    const trace = row.trace_id!.trim();
    const group = grouped.get(trace) ?? [];
    group.push(row);
    grouped.set(trace, group);
  }

  let successfulRequests = 0;
  let naturalMultiHopRequests = 0;
  let wastedAttempts = 0;
  const postSuccessViolations: Array<Record<string, unknown>> = [];
  const requestEvidence: Array<Record<string, unknown>> = [];
  for (const [traceId, unsorted] of grouped) {
    const attempts = [...unsorted].sort(compareRows);
    const natural = !SYNTHETIC_IDENTITY.test(traceId) && attempts.every((row) => {
      const tenant = row.tenant_id;
      const caller = row.caller;
      return tenant === "mimule" && NATURAL_CALLERS.has(caller ?? "")
        && !SYNTHETIC_IDENTITY.test(tenant ?? "")
        && !SYNTHETIC_IDENTITY.test(caller ?? "");
    });
    if (attempts.length > 1 && natural) naturalMultiHopRequests += 1;
    const firstSuccess = attempts.findIndex((row) => isSuccess(row.success));
    if (firstSuccess >= 0) successfulRequests += 1;
    const through = firstSuccess >= 0 ? attempts.slice(0, firstSuccess + 1) : attempts;
    const wasted = through.filter((row) => !isSuccess(row.success) && row.error_class !== "gateway_unreachable").length;
    wastedAttempts += wasted;
    const timeToFirstSuccessMs = firstSuccess < 0
      ? null
      : through.reduce((sum, row) => sum + (validLatency(row.latency_ms) ?? 0), 0);
    const trailing = firstSuccess < 0 ? [] : attempts.slice(firstSuccess + 1);
    if (trailing.length > 0) {
      postSuccessViolations.push({ traceId, firstSuccessId: attempts[firstSuccess]!.id, trailingIds: trailing.map((row) => row.id) });
    }
    requestEvidence.push({
      traceId,
      attempts: attempts.length,
      success: firstSuccess >= 0,
      natural,
      wastedAttempts: wasted,
      timeToFirstSuccessMs,
    });
  }

  const requests = grouped.size;
  const requestMetrics = {
    requests,
    successfulRequests,
    requestSuccessRatePct: requests === 0 ? null : (successfulRequests / requests) * 100,
    naturalMultiHopRequests,
    wastedAttempts,
    postSuccessViolations: postSuccessViolations.length,
  };
  const requestCheck = postSuccessViolations.length > 0
    ? result("r0.request_outcomes", "FAIL", "One or more traces contain rows after the first successful hop.", requestMetrics, postSuccessViolations)
    : naturalMultiHopRequests < 5
      ? result("r0.request_outcomes", "PENDING", "Request math is valid, but fewer than five natural multi-hop requests exist.", requestMetrics, requestEvidence)
      : result("r0.request_outcomes", "PASS", "Natural multi-hop evidence meets the trust floor with consistent request ordering.", requestMetrics, requestEvidence);
  return [traceCheck, requestCheck];
}

export function evaluateR1(input: R1Input | undefined, generatedAt: number): CheckResult {
  if (!input) return result("r1.stability", "PENDING", "No R1 scheduled-cycle observations were supplied.");
  const acceptanceStartAt = input.acceptanceStartAt ?? Number.NEGATIVE_INFINITY;
  const rollingRestartCount24h = input.rollingRestartCount24h
    ?? Math.max(0, ...input.observations.map((entry) => entry.restartCount24h));
  if (!Number.isInteger(rollingRestartCount24h) || rollingRestartCount24h < 0) {
    return result("r1.stability", "UNVERIFIABLE", "The current rolling LiteLLM restart count is malformed.");
  }
  if (rollingRestartCount24h > 1) {
    return result("r1.stability", "FAIL", "The rolling LiteLLM restart target was exceeded.", {
      receiptCoverage: input.receiptCoverage?.status ?? "missing",
      settledOpportunities: input.receiptCoverage?.settledOpportunities ?? 0,
      coveredOpportunities: input.receiptCoverage?.coveredOpportunities ?? 0,
      restartCount24h: rollingRestartCount24h,
    }, [{ invariant: "restart_target", restartCount24h: rollingRestartCount24h }]);
  }
  const recordedFailures = input.failures ?? [];
  const validFailure = (entry: R1FailureObservation): boolean => !(entry.receiptVerified !== true
    || !isUuidV4(entry.receiptTokenId)
    || !isR1ReceiptPath(entry.triggerReceiptPath, "trigger") || !isSha256(entry.triggerReceiptSha256)
    || !isR1ReceiptPath(entry.terminalReceiptPath, "terminal") || !isSha256(entry.terminalReceiptSha256)
    || !entry.triggerReceiptPath.endsWith(`-${entry.receiptTokenId}.json`)
    || !entry.terminalReceiptPath.endsWith(`-${entry.receiptTokenId}.json`)
    || r1OpportunityAt(entry.opportunityId) === null
    || !(entry.result === "prestart-failed"
      ? entry.serviceJobId === null && entry.invocationId === null && entry.bootId === null && entry.execMainStatus === null
      : typeof entry.serviceJobId === "string" && /^\d+$/.test(entry.serviceJobId)
        && typeof entry.invocationId === "string" && /^[a-f0-9]{32}$/i.test(entry.invocationId)
        && typeof entry.bootId === "string" && /^[a-f0-9]{32}$/i.test(entry.bootId)
        && Number.isInteger(entry.execMainStatus))
    || !Number.isFinite(entry.startedAt) || !Number.isFinite(entry.finishedAt)
    || entry.startedAt < acceptanceStartAt || entry.finishedAt < entry.startedAt || entry.finishedAt > generatedAt
    || r1OpportunityAt(entry.opportunityId)! > entry.startedAt
    || !["failed", "timeout", "aborted", "prestart-failed"].includes(entry.result));
  const validFailures = recordedFailures.filter(validFailure);
  if (validFailures.length !== new Set(validFailures.map((entry) => entry.receiptTokenId)).size
    || validFailures.length !== new Set(validFailures.map((entry) => entry.opportunityId)).size
    || validFailures.length !== new Set(validFailures.map((entry) => entry.terminalReceiptSha256)).size) {
    return result("r1.stability", "FAIL", "A timer opportunity or terminal failure receipt was replayed.");
  }
  if (validFailures.length > 0) {
    return result("r1.stability", "FAIL", "A reprobe service job failed or aborted during the acceptance window.", {
      failedInvocations: validFailures.length,
      malformedFailureReceipts: recordedFailures.length - validFailures.length,
    }, validFailures.map((entry) => ({
      serviceJobId: entry.serviceJobId,
      invocationId: entry.invocationId,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      result: entry.result,
    })));
  }
  if (recordedFailures.length > 0) {
    return result("r1.stability", "UNVERIFIABLE", "A persisted reprobe failure receipt is malformed or future-dated.");
  }
  if (!input.journalAvailable) {
    return result("r1.stability", "UNVERIFIABLE", input.error ? `R1 journal is unavailable: ${sanitizeError(input.error)}` : "R1 journal is unavailable.");
  }
  const observations = input.observations
    .filter((observation) => normalizeEpochMs(observation.stateTs) >= acceptanceStartAt)
    .sort((a, b) => normalizeEpochMs(a.stateTs) - normalizeEpochMs(b.stateTs));
  const receiptQualified = (observation: R1Observation): boolean => observation.scheduled
    && observation.triggerReceiptVerified === true && observation.terminalReceiptVerified === true;
  const failed = observations.filter((observation) => receiptQualified(observation) && observation.invocationResult !== "success");
  if (failed.length > 0) {
    return result("r1.stability", "FAIL", "A scheduled reprobe invocation failed or aborted.", {
      scheduledObservations: observations.filter((entry) => entry.scheduled).length,
      failedInvocations: failed.length,
    }, failed.map((entry) => ({ invocationId: entry.invocationId, result: entry.invocationResult, stateTs: entry.stateTs })));
  }

  const successful = observations.filter((observation) => receiptQualified(observation) && observation.invocationResult === "success");
  const distinct = new Map<string, R1Observation>();
  for (const observation of successful) {
    // Preserve the first immutable capture of an invocation. Re-running the
    // verifier during the same one-shot service execution must not replace its
    // genuine pre-cycle pool with that cycle's resulting pool.
    if (isNonEmpty(observation.invocationId) && !distinct.has(observation.invocationId)) {
      distinct.set(observation.invocationId, observation);
    }
  }
  const samples = [...distinct.values()].sort((a, b) => normalizeEpochMs(a.stateTs) - normalizeEpochMs(b.stateTs));
  const newest = samples.at(-1);
  const violations: Array<Record<string, unknown>> = [];
  const coverage = input.receiptCoverage;
  const coverageMetrics = {
    receiptCoverage: coverage?.status ?? "missing",
    settledOpportunities: coverage?.settledOpportunities ?? 0,
    coveredOpportunities: coverage?.coveredOpportunities ?? 0,
  };
  const malformedCoverage = Boolean(coverage && (!Number.isInteger(coverage.settledOpportunities) || coverage.settledOpportunities < 0
    || !Number.isInteger(coverage.coveredOpportunities) || coverage.coveredOpportunities < 0
    || coverage.coveredOpportunities > coverage.settledOpportunities
    || (coverage.missingOpportunityIds !== undefined && (!Array.isArray(coverage.missingOpportunityIds)
      || coverage.missingOpportunityIds.some((entry) => r1OpportunityAt(entry) === null)
      || new Set(coverage.missingOpportunityIds).size !== coverage.missingOpportunityIds.length))));
  if (!coverage) {
    return result("r1.stability", "PENDING", "No unit-boundary receipt coverage exists; journal timing cannot prove scheduled origin.", coverageMetrics);
  }
  if (malformedCoverage) {
    return result("r1.stability", "UNVERIFIABLE", "The scheduled-opportunity receipt coverage summary is malformed.", coverageMetrics);
  }
  if (coverage.status === "violated") {
    return result("r1.stability", "FAIL", "A settled scheduled opportunity has missing, conflicting, or replayed receipt evidence.", coverageMetrics,
      (coverage.missingOpportunityIds ?? []).map((opportunityId) => ({ opportunityId })));
  }
  if (coverage.status === "unverifiable") {
    return result("r1.stability", "UNVERIFIABLE", coverage.error
      ? `Scheduled receipt coverage is untrustworthy: ${sanitizeError(coverage.error)}`
      : "Scheduled receipt coverage is untrustworthy.", coverageMetrics);
  }
  if (coverage.status !== "complete" || coverage.settledOpportunities < 3
    || coverage.coveredOpportunities !== coverage.settledOpportunities
    || (coverage.missingOpportunityIds?.length ?? 0) > 0) {
    return result("r1.stability", "PENDING", coverage.status === "unavailable"
      ? "The timer-only receipt producer is not installed; R1 remains operational evidence only."
      : "Not every settled timer opportunity has an immutable terminal receipt yet.", coverageMetrics,
    (coverage.missingOpportunityIds ?? []).map((opportunityId) => ({ opportunityId })));
  }
  if (samples.length !== coverage.coveredOpportunities) {
    return result("r1.stability", "UNVERIFIABLE", "Receipt coverage and the distinct terminal success observations disagree.", {
      ...coverageMetrics,
      successfulScheduledCycles: samples.length,
    });
  }
  if (newest && (normalizeEpochMs(newest.stateTs) > generatedAt
    || generatedAt - normalizeEpochMs(newest.stateTs) > R1_MAX_STATE_AGE_MS)) {
    violations.push({ invariant: "fresh_nonfuture_state", stateTs: newest.stateTs, ageMs: generatedAt - normalizeEpochMs(newest.stateTs) });
  }

  const inspected = samples.slice(-3);
  const incomplete: Array<Record<string, unknown>> = [];
  for (const observation of inspected) {
    const stateTs = normalizeEpochMs(observation.stateTs);
    const startedAt = observation.invocationStartedAt;
    const finishedAt = observation.invocationFinishedAt;
    const timerTriggeredAt = observation.timerTriggeredAt;
    const expectedOpportunityId = typeof timerTriggeredAt === "number" && Number.isInteger(timerTriggeredAt)
      && timerTriggeredAt >= 0 && timerTriggeredAt <= 8_640_000_000_000_000
      ? `model-fallback-reprobe.timer@${new Date(timerTriggeredAt).toISOString()}`
      : null;
    if (typeof startedAt !== "number" || typeof finishedAt !== "number" || typeof timerTriggeredAt !== "number"
      || !Number.isInteger(timerTriggeredAt)
      || expectedOpportunityId === null || observation.timerTriggerId !== expectedOpportunityId
      || !/^\d+$/.test(observation.serviceJobId ?? "")
      || !/^[a-f0-9]{32}$/i.test(observation.invocationId)
      || !/^[a-f0-9]{32}$/i.test(observation.bootId ?? "")
      || !isUuidV4(observation.receiptTokenId)
      || observation.triggerReceiptVerified !== true
      || !isR1ReceiptPath(observation.triggerReceiptPath, "trigger")
      || !isSha256(observation.triggerReceiptSha256)
      || observation.terminalReceiptVerified !== true
      || !isR1ReceiptPath(observation.terminalReceiptPath, "terminal")
      || !isSha256(observation.terminalReceiptSha256)
      || !observation.triggerReceiptPath!.endsWith(`-${observation.receiptTokenId}.json`)
      || !observation.terminalReceiptPath!.endsWith(`-${observation.receiptTokenId}.json`)
      || observation.execMainStatus !== 0 || observation.invocationMode !== "normal"
      || !isSha256(observation.stateSha256)) {
      incomplete.push({ invariant: "invocation_bounds_required", invocationId: observation.invocationId });
    } else if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt
      || stateTs + 999 < startedAt || stateTs > finishedAt
      || !Number.isFinite(timerTriggeredAt) || startedAt < timerTriggeredAt
      || startedAt - timerTriggeredAt > 4 * 60 * 1_000
      || finishedAt - startedAt > 10 * 60 * 1_000) {
      violations.push({ invariant: "state_within_scheduled_invocation", invocationId: observation.invocationId, stateTs, startedAt, finishedAt, timerTriggeredAt });
    }
    if (stateTs > generatedAt
      || (typeof startedAt === "number" && startedAt > generatedAt)
      || (typeof finishedAt === "number" && finishedAt > generatedAt)
      || (typeof timerTriggeredAt === "number" && timerTriggeredAt > generatedAt)) {
      violations.push({ invariant: "observation_not_future", invocationId: observation.invocationId, stateTs, startedAt, finishedAt, timerTriggeredAt, generatedAt });
    }
    if (observation.changed) violations.push({ invariant: "changed_false", invocationId: observation.invocationId });
    const pool = new Set(observation.pool);
    const stateArrays = [observation.live, observation.limited, observation.dead, observation.hang, observation.timeout];
    const allStateNames = stateArrays.flat();
    const malformedNames = new Set(observation.malformedHistoryModels ?? []);
    const historyNames = Object.keys(observation.history);
    const invalidNames = [...observation.pool, ...allStateNames, ...historyNames, ...(observation.malformedHistoryModels ?? [])]
      .filter((name) => !isExactRouteName(name));
    if (invalidNames.length > 0) violations.push({ invariant: "valid_route_names", invocationId: observation.invocationId });
    for (const [label, values] of [["pool", observation.pool], ["live", observation.live], ["limited", observation.limited], ["dead", observation.dead], ["hang", observation.hang], ["timeout", observation.timeout]] as const) {
      if (new Set(values).size !== values.length) violations.push({ invariant: "unique_state_members", state: label, invocationId: observation.invocationId });
    }
    if (new Set(allStateNames).size !== allStateNames.length) {
      violations.push({ invariant: "disjoint_state_membership", invocationId: observation.invocationId });
    }
    for (const logicalName of allStateNames) {
      if (!Object.hasOwn(observation.history, logicalName) && !malformedNames.has(logicalName)) {
        violations.push({ invariant: "state_member_has_history", logicalName, invocationId: observation.invocationId });
      }
    }
    const hasPriorPool = Array.isArray(observation.priorPool)
      && (observation.priorPoolSource === "prior-observation" || observation.priorPoolSource === "unchanged-render");
    const priorPool = new Set(observation.priorPool ?? []);
    if (!hasPriorPool) incomplete.push({ invariant: "prior_pool_with_provenance_required", invocationId: observation.invocationId });
    const exactBuckets = [
      ["live", observation.live, (code: number) => code === 200],
      ["limited", observation.limited, (code: number) => code === 429],
      ["dead", observation.dead, (code: number) => TERMINAL_CODES.has(code)],
      ["hang", observation.hang, (code: number) => code === 0],
      ["timeout", observation.timeout, (code: number) => code === 408],
    ] as const;
    for (const [bucket, members, accepts] of exactBuckets) {
      for (const logicalName of members) {
        const history = observation.history[logicalName];
        if (history && !accepts(history.code ?? -1)) {
          violations.push({ invariant: "state_bucket_matches_history", bucket, logicalName, code: history.code, invocationId: observation.invocationId });
        }
      }
    }
    for (const logicalName of observation.pool) {
      const history = observation.history[logicalName];
      if (!history) {
        if (!malformedNames.has(logicalName)) {
          violations.push({ invariant: "pool_member_has_history", logicalName, invocationId: observation.invocationId });
        }
        continue;
      }
      const heldTimeout = (history.code === 0 || history.code === 408)
        && history.streak < 3 && hasPriorPool && priorPool.has(logicalName);
      if (history.category !== "routable" && !heldTimeout) {
        violations.push({ invariant: "pool_member_routable_or_held_timeout", logicalName, code: history.code, streak: history.streak, invocationId: observation.invocationId });
      }
    }
    for (const [logicalName, history] of Object.entries(observation.history)) {
      if (!Number.isInteger(history.code) || history.code === null || history.code < 0 || history.code > 599
        || history.category !== probeCategory(history.code)
        || !Number.isInteger(history.streak) || history.streak < 1
        || !Number.isInteger(history.since) || history.since <= 0 || normalizeEpochMs(history.since) > stateTs
        || !(history.latency === null || (Number.isInteger(history.latency) && history.latency >= 0))) {
        violations.push({ invariant: "validated_history_record", logicalName, invocationId: observation.invocationId });
        continue;
      }
      if (normalizeEpochMs(history.since) > generatedAt) {
        violations.push({ invariant: "history_since_not_future", logicalName, since: history.since, invocationId: observation.invocationId });
      }
      const expectedBucket = history.code === 200 ? observation.live
        : history.code === 429 ? observation.limited
          : TERMINAL_CODES.has(history.code) ? observation.dead
            : history.code === 0 ? observation.hang
              : history.code === 408 ? observation.timeout
                : null;
      if (expectedBucket && !expectedBucket.includes(logicalName)) {
        violations.push({ invariant: "history_matches_state_bucket", logicalName, code: history.code, invocationId: observation.invocationId });
      }
      if (!Number.isFinite(history.streak) || history.streak < 1) continue;
      if (TERMINAL_CODES.has(history.code ?? -1) && pool.has(logicalName)) {
        violations.push({ invariant: "terminal_dead_absent", logicalName, code: history.code, invocationId: observation.invocationId });
      }
      if (hasPriorPool && (history.code === 0 || history.code === 408) && priorPool.has(logicalName)) {
        if (history.streak < 3 && !pool.has(logicalName)) {
          violations.push({ invariant: "timeout_hold", logicalName, code: history.code, streak: history.streak, invocationId: observation.invocationId });
        }
        if (history.streak >= 3 && pool.has(logicalName)) {
          violations.push({ invariant: "timeout_prune", logicalName, code: history.code, streak: history.streak, invocationId: observation.invocationId });
        }
      }
      if (hasPriorPool && (history.code === 0 || history.code === 408) && !priorPool.has(logicalName) && pool.has(logicalName)) {
        violations.push({ invariant: "timeout_nonincumbent_absent", logicalName, code: history.code, invocationId: observation.invocationId });
      }
      if (hasPriorPool && ROUTABLE_CODES.has(history.code ?? -1) && !priorPool.has(logicalName)) {
        if (history.streak < 3 && pool.has(logicalName)) {
          violations.push({ invariant: "promotion_hysteresis", logicalName, streak: history.streak, invocationId: observation.invocationId });
        }
        if (history.streak >= 3 && !pool.has(logicalName)) {
          violations.push({ invariant: "promotion_at_three", logicalName, streak: history.streak, invocationId: observation.invocationId });
        }
      }
    }
    for (const logicalName of observation.malformedHistoryModels ?? []) {
      const evidence = { invariant: "validated_history_required", logicalName, invocationId: observation.invocationId };
      if (priorPool.has(logicalName) && pool.has(logicalName)) {
        violations.push({ ...evidence, invariant: "malformed_history_no_hold" });
      } else {
        incomplete.push(evidence);
      }
    }
  }

  if (samples.length >= 3) {
    const stateTimes = inspected.map((entry) => normalizeEpochMs(entry.stateTs));
    if (new Set(stateTimes).size !== 3 || stateTimes.some((ts, index) => index > 0 && ts <= stateTimes[index - 1]!)) {
      violations.push({ invariant: "state_timestamp_advances", stateTimes });
    }
    const timerTimes = inspected.map((entry) => entry.timerTriggeredAt!);
    const triggerIds = inspected.map((entry) => entry.timerTriggerId!);
    const jobIds = inspected.map((entry) => `${entry.bootId}:${entry.serviceJobId}`);
    const receiptTokens = inspected.map((entry) => entry.receiptTokenId!);
    const triggerReceipts = inspected.map((entry) => entry.triggerReceiptSha256!);
    const terminalReceipts = inspected.map((entry) => entry.terminalReceiptSha256!);
    if (new Set(timerTimes).size !== 3 || timerTimes.some((ts, index) => index > 0 && ts <= timerTimes[index - 1]!)
      || new Set(triggerIds).size !== 3 || new Set(jobIds).size !== 3 || new Set(receiptTokens).size !== 3
      || new Set(triggerReceipts).size !== 3 || new Set(terminalReceipts).size !== 3) {
      violations.push({ invariant: "distinct_advancing_timer_triggers_and_jobs", timerTimes, triggerIds, jobIds, receiptTokens, triggerReceipts, terminalReceipts });
    }
    const poolHashes = inspected.map(poolKey);
    const distributionHashes = inspected.map(stateDistributionKey);
    if (new Set(poolHashes).size !== 1) violations.push({ invariant: "stable_pool", poolHashes });
    if (new Set(distributionHashes).size !== 1) violations.push({ invariant: "stable_distribution", distributionHashes });
  }

  const metrics: Record<string, MetricValue> = {
    successfulScheduledCycles: samples.length,
    newestStateTs: newest ? normalizeEpochMs(newest.stateTs) : null,
    newestStateAgeMs: newest ? generatedAt - normalizeEpochMs(newest.stateTs) : null,
    restartCount24h: rollingRestartCount24h,
    stablePoolKey: inspected.length === 3 && new Set(inspected.map(poolKey)).size === 1 ? poolKey(inspected[0]!) : null,
    stableDistributionKey: inspected.length === 3 && new Set(inspected.map(stateDistributionKey)).size === 1 ? stateDistributionKey(inspected[0]!) : null,
    acceptanceStartAt: Number.isFinite(acceptanceStartAt) ? acceptanceStartAt : null,
    incompleteSamples: incomplete.length,
    receiptCoverage: coverage.status,
    settledOpportunities: coverage.settledOpportunities,
    coveredOpportunities: coverage.coveredOpportunities,
  };
  if (violations.length > 0) return result("r1.stability", "FAIL", "A scheduled-cycle stability invariant was violated.", metrics, violations);
  if (samples.length < 3) {
    return result("r1.stability", "PENDING", "Fewer than three distinct successful scheduled reprobe cycles are available.", metrics,
      samples.map((entry) => ({ invocationId: entry.invocationId, stateTs: entry.stateTs, changed: entry.changed })));
  }
  if (incomplete.length > 0) {
    return result("r1.stability", "PENDING", "Three scheduled cycles exist, but invocation bounds or a trustworthy pre-cycle pool are missing.", metrics, incomplete);
  }
  return result("r1.stability", "PASS", "The latest three scheduled cycles are fresh, unchanged, stable, and within the restart target.", metrics,
    inspected.map((entry) => ({ invocationId: entry.invocationId, stateTs: entry.stateTs, changed: entry.changed })));
}

interface RouteAggregate {
  logicalName: string;
  eligible: boolean;
  recentCalls: number;
  recentSuccesses: number;
  recentAuth: number;
  recentRateLimit: number;
  recentTimeout: number;
  recentUnavailable: number;
  allCalls: number;
  allSuccesses: number;
  firstRateLimitAt: number | null;
  lastRateLimitAt: number | null;
}

export interface R2Analysis {
  aggregates: RouteAggregate[];
  hardDead: string[];
  wouldQuarantine: string[];
  excluded: Record<string, number>;
  trustedRows: number;
  eligibleTrustedRows: number;
}

interface RouteAliasIndex {
  unique: Map<string, R2Route>;
  ambiguous: Set<string>;
}

function routeLedgerKeys(route: R2Route): string[] {
  // The live model roster can expose a provider-facing `modelId` that differs
  // from both the logical route and the rendered `resolvedModel`. Ledger rows
  // may carry either provider identity, so index every exact non-empty alias.
  return canonicalList([route.resolvedModel ?? "", route.modelId ?? "", route.logicalName]);
}

function buildRouteAliases(routes: R2Route[]): RouteAliasIndex {
  const claims = new Map<string, Map<string, R2Route>>();
  for (const route of routes) {
    if (!isNonEmpty(route.logicalName)) continue;
    for (const value of routeLedgerKeys(route)) {
      if (!isNonEmpty(value)) continue;
      const claimants = claims.get(value) ?? new Map<string, R2Route>();
      claimants.set(route.logicalName, route);
      claims.set(value, claimants);
    }
  }
  const unique = new Map<string, R2Route>();
  const ambiguous = new Set<string>();
  for (const [identity, claimants] of claims) {
    if (claimants.size === 1) unique.set(identity, [...claimants.values()][0]!);
    else ambiguous.add(identity);
  }
  return { unique, ambiguous };
}

export function analyzeR2(input: R2Input): R2Analysis {
  const aliases = buildRouteAliases(input.routes);
  const aggregate = new Map<string, RouteAggregate>();
  for (const route of input.routes) {
    aggregate.set(route.logicalName, {
      logicalName: route.logicalName,
      eligible: route.eligible,
      recentCalls: 0,
      recentSuccesses: 0,
      recentAuth: 0,
      recentRateLimit: 0,
      recentTimeout: 0,
      recentUnavailable: 0,
      allCalls: 0,
      allSuccesses: 0,
      firstRateLimitAt: null,
      lastRateLimitAt: null,
    });
  }
  const excluded: Record<string, number> = {
    cliDirect: 0,
    otherBackend: 0,
    nonMimuleTenant: 0,
    gatewayUnreachable: 0,
    legacyUnknown: 0,
    serverErrorPreFix: 0,
    serverErrorOther: 0,
    untrustedFailure: 0,
    unmappedRoute: 0,
    ambiguousRoute: 0,
    unknownEligibility: 0,
  };
  let trustedRows = 0;
  let eligibleTrustedRows = 0;

  for (const row of input.rows) {
    if (row.backend === "cli-direct") { excluded.cliDirect += 1; continue; }
    if (row.tenant_id !== null && row.tenant_id !== "mimule") {
      excluded.nonMimuleTenant += 1; continue;
    }
    if (row.error_class === "gateway_unreachable") { excluded.gatewayUnreachable += 1; continue; }
    if (!isSuccess(row.success) && row.error_class === "unknown") { excluded.legacyUnknown += 1; continue; }
    if (!isSuccess(row.success) && row.error_class === "server_error") {
      if (input.classifierFixAt !== undefined && row.ts < input.classifierFixAt) excluded.serverErrorPreFix += 1;
      else excluded.serverErrorOther += 1;
      continue;
    }
    if (!isSuccess(row.success) && !TRUSTED_FAILURES.has(row.error_class ?? "")) {
      excluded.untrustedFailure += 1; continue;
    }
    if (!isNonEmpty(row.resolved_model)) { excluded.unmappedRoute += 1; continue; }
    if (aliases.ambiguous.has(row.resolved_model)) { excluded.ambiguousRoute += 1; continue; }
    const route = aliases.unique.get(row.resolved_model);
    if (!route) { excluded.unmappedRoute += 1; continue; }
    if (route.eligibilityKnown !== true) { excluded.unknownEligibility += 1; continue; }
    const item = aggregate.get(route.logicalName)!;
    trustedRows += 1;
    item.allCalls += 1;
    if (isSuccess(row.success)) item.allSuccesses += 1;
    if (row.ts < input.recentCutoff) continue;
    if (route.eligible) eligibleTrustedRows += 1;
    item.recentCalls += 1;
    if (isSuccess(row.success)) item.recentSuccesses += 1;
    else if (row.error_class === "auth") item.recentAuth += 1;
    else if (row.error_class === "rate_limit") {
      item.recentRateLimit += 1;
      item.firstRateLimitAt = item.firstRateLimitAt === null ? row.ts : Math.min(item.firstRateLimitAt, row.ts);
      item.lastRateLimitAt = item.lastRateLimitAt === null ? row.ts : Math.max(item.lastRateLimitAt, row.ts);
    } else if (row.error_class === "timeout") item.recentTimeout += 1;
    else if (row.error_class === "unavailable") item.recentUnavailable += 1;
  }

  const aggregates = [...aggregate.values()].sort((a, b) => a.logicalName.localeCompare(b.logicalName));
  const hardDead: string[] = [];
  const wouldQuarantine: string[] = [];
  for (const item of aggregates) {
    if (!item.eligible) continue;
    const earned = item.allCalls >= 50 && item.allSuccesses / item.allCalls >= 0.6;
    const zeroRecent = item.recentCalls > 0 && item.recentSuccesses === 0;
    const credentialOrQuota = item.recentAuth + item.recentRateLimit;
    if (earned && zeroRecent && credentialOrQuota >= 5) wouldQuarantine.push(item.logicalName);
    if (earned || item.recentCalls < 20 || !zeroRecent) continue;
    const onlyRateLimit = item.recentRateLimit === item.recentCalls;
    const hasRateLimit = item.recentRateLimit > 0;
    const rateLimitAge = item.firstRateLimitAt === null || item.lastRateLimitAt === null
      ? 0
      : item.lastRateLimitAt - item.firstRateLimitAt;
    // Mixed rate-limit/error failures remain an undecided R2b policy. A pure
    // rate-limit failure becomes destructive evidence only after 48 hours.
    if (hasRateLimit && (!onlyRateLimit || rateLimitAge < R2_RATE_LIMIT_MIN_AGE_MS)) continue;
    hardDead.push(item.logicalName);
  }
  return { aggregates, hardDead, wouldQuarantine, excluded, trustedRows, eligibleTrustedRows };
}

export interface TombstoneTransitionInput {
  logicalName: string;
  previous: R2Tombstone | null;
  ledgerAvailable: boolean;
  destructiveEvidencePresent: boolean;
  recoverySatisfied: boolean;
  recoveryEvidence?: string | null;
}

export function reconcileTombstone(input: TombstoneTransitionInput): R2Tombstone | null {
  if (!input.ledgerAvailable && input.previous?.active) return { ...input.previous };
  if (input.previous?.active) {
    if (!input.destructiveEvidencePresent && input.recoverySatisfied && isNonEmpty(input.recoveryEvidence)) {
      return { ...input.previous, active: false, recoveryEvidence: input.recoveryEvidence };
    }
    return { ...input.previous };
  }
  if (input.destructiveEvidencePresent) {
    return { logicalName: input.logicalName, active: true, reason: "trusted hard-dead evidence", recoveryEvidence: null };
  }
  return input.previous ? { ...input.previous } : null;
}

export interface Exact429TransitionInput {
  previous: Exact429Clock | null;
  logicalName: string;
  observedAt: number;
  code: number;
}

export function updateExact429Clock(input: Exact429TransitionInput): Exact429Clock {
  if (input.code === 200) {
    return { logicalName: input.logicalName, first429At: null, last429At: null, currentCode: 200, resetAt: input.observedAt, action: "limited" };
  }
  if (input.code === 429) {
    const continueClock = input.previous?.currentCode === 429 && input.previous.first429At !== null;
    return {
      logicalName: input.logicalName,
      first429At: continueClock ? input.previous!.first429At : input.observedAt,
      last429At: input.observedAt,
      currentCode: 429,
      resetAt: input.previous?.resetAt ?? null,
      action: input.previous?.action ?? "limited",
    };
  }
  return {
    logicalName: input.logicalName,
    first429At: null,
    last429At: null,
    currentCode: input.code,
    resetAt: input.observedAt,
    action: "limited",
  };
}

export function evaluateR2(input: R2Input | undefined, generatedAt = Number.POSITIVE_INFINITY): { checks: CheckResult[]; hardDead: string[] } {
  if (!input) {
    return { checks: [
      result("r2.reconciliation", "PENDING", "No R2 ledger reconciliation input was supplied."),
      result("r2.exact_429", "PENDING", "No exact-code 429 timing evidence was supplied."),
      result("r2.outcome_delta", "PENDING", "No frozen pre-R2 cohort was supplied."),
    ], hardDead: [] };
  }
  const retainedTombstones = canonicalList((input.tombstones ?? [])
    .filter((entry) => entry.active)
    .map((entry) => entry.logicalName));
  const modeEvidence = input.liveModeEvidence;
  if (modeEvidence?.status === "missing" || modeEvidence?.status === "unavailable") {
    const note = modeEvidence.status === "unavailable"
      ? `The live ledger mode cannot be verified: ${sanitizeError(modeEvidence.error)}`
      : "The live reprobe state has no ledger mode evidence.";
    return { checks: [
      result("r2.reconciliation", "UNVERIFIABLE", note),
      result("r2.exact_429", "PENDING", "Exact-code timing cannot replace missing live ledger-mode evidence."),
      result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted without live ledger-mode evidence."),
    ], hardDead: retainedTombstones };
  }
  if (modeEvidence?.status === "verified") {
    const malformed = modeEvidence.policyVersion !== 1 || !isExactRouteName(modeEvidence.mode)
      || modeEvidence.mode.length > 64 || !Number.isInteger(modeEvidence.asOf) || modeEvidence.asOf <= 0;
    if (malformed) {
      return { checks: [
        result("r2.reconciliation", "UNVERIFIABLE", "The live ledger-mode evidence is malformed."),
        result("r2.exact_429", "PENDING", "Exact-code timing cannot replace malformed live mode evidence."),
        result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted from malformed live mode evidence."),
      ], hardDead: retainedTombstones };
    }
    if (modeEvidence.asOf > generatedAt) {
      return { checks: [
        result("r2.reconciliation", "FAIL", "The live ledger-mode decision is future-dated.", {}, [{ ...modeEvidence, invariant: "live_mode_not_future" }]),
        result("r2.exact_429", "PENDING", "Exact-code timing cannot be accepted from future-dated live mode evidence."),
        result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted from future-dated live mode evidence."),
      ], hardDead: retainedTombstones };
    }
    if (modeEvidence.mode !== "shadow" || modeEvidence.enforced !== false) {
      return { checks: [
        result("r2.reconciliation", "FAIL", "Live ledger enforcement is asserted during the planning-only shadow slice.", {
          policyVersion: modeEvidence.policyVersion,
          liveMode: modeEvidence.mode,
          liveEnforced: modeEvidence.enforced,
        }, [{ ...modeEvidence, invariant: "planning_slice_remains_shadow" }]),
        result("r2.exact_429", "PENDING", "Exact-code timing cannot authorize unexpected enforcement."),
        result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted from an unauthorized enforcement state."),
      ], hardDead: retainedTombstones };
    }
  }
  const assertedEnforcement = (input.shadowObservations ?? []).filter((entry) => entry.enforced === true);
  if (assertedEnforcement.length > 0) {
    return { checks: [
      result("r2.reconciliation", "FAIL", "A captured shadow observation asserts enforcement.", {
        assertedEnforcement: assertedEnforcement.length,
      }, assertedEnforcement.map((entry) => ({ invocationId: entry.invocationId, enforced: true, invariant: "shadow_observation_not_enforced" }))),
      result("r2.exact_429", "PENDING", "Exact-code timing cannot authorize unexpected enforcement."),
      result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted from an unauthorized enforcement observation."),
    ], hardDead: retainedTombstones };
  }
  if (!input.available) {
    const note = input.error ? `R2 ledger is unavailable: ${sanitizeError(input.error)}` : "R2 ledger is unavailable.";
    return { checks: [
      result("r2.reconciliation", "UNVERIFIABLE", note),
      result("r2.exact_429", "PENDING", "Exact-code 429 evidence cannot replace the unavailable ledger."),
      result("r2.outcome_delta", "PENDING", "Outcome delta cannot be measured without ledger access."),
    ], hardDead: retainedTombstones };
  }
  const futureRows = input.rows.filter((row) => Number.isFinite(row.ts) && row.ts > generatedAt);
  if (futureRows.length > 0) {
    return { checks: [
      result("r2.reconciliation", "FAIL", "Ledger rows exceed the attested query-window ceiling.", { futureRows: futureRows.length },
        futureRows.map((row) => ({ id: row.id, ts: row.ts, invariant: "row_within_query_ceiling" }))),
      result("r2.exact_429", "PENDING", "Exact-code timing cannot be accepted from an invalid ledger window."),
      result("r2.outcome_delta", "PENDING", "Outcome delta cannot be accepted from an invalid ledger window."),
    ], hardDead: retainedTombstones };
  }

  const analysis = analyzeR2(input);
  const hardDead = analysis.hardDead;
  const effectiveHardDead = canonicalList([
    ...hardDead,
    ...(input.tombstones ?? []).filter((entry) => entry.active).map((entry) => entry.logicalName),
  ]);
  const excludedEvidence = Object.entries(analysis.excluded).map(([reason, count]) => ({ reason, count }));
  const decisionEvidence: Array<Record<string, unknown>> = [
    { enforced: input.mode === "enforced", would_prune: hardDead, would_quarantine: analysis.wouldQuarantine },
    ...excludedEvidence,
  ];
  const allShadow = input.shadowObservations ?? [];
  const futureShadow = allShadow.filter((entry) =>
    (entry.stateTs !== undefined && normalizeEpochMs(entry.stateTs) > generatedAt)
    || (entry.decisionAt !== undefined && normalizeEpochMs(entry.decisionAt) > generatedAt));
  const rawSuccessfulShadow = allShadow.filter((entry) => entry.scheduled && entry.success);
  const distinctShadow = new Map<string, R2ShadowObservation>();
  for (const entry of rawSuccessfulShadow) {
    const stateTs = entry.stateTs === undefined ? null : normalizeEpochMs(entry.stateTs);
    const decisionAt = entry.decisionAt === undefined ? null : normalizeEpochMs(entry.decisionAt);
    if (isNonEmpty(entry.invocationId)
      && stateTs !== null && Number.isFinite(stateTs) && stateTs > 0
      && decisionAt !== null && Number.isFinite(decisionAt) && decisionAt > 0
      && Math.abs(decisionAt - stateTs) <= 60_000
      && entry.policyVersion === 1 && entry.ledgerAvailable === true && entry.enforced === false
      && !distinctShadow.has(entry.invocationId)) {
      distinctShadow.set(entry.invocationId, entry);
    }
  }
  const successfulShadow = [...distinctShadow.values()]
    .sort((a, b) => normalizeEpochMs(a.stateTs!) - normalizeEpochMs(b.stateTs!));
  const provesLayerUnchanged = (before: string | undefined, after: string | undefined, changed: boolean | null | undefined): boolean =>
    changed === false || (isNonEmpty(before) && isNonEmpty(after) && before === after);
  const shadowRoutingMutation = allShadow.filter((entry) => entry.litellmChanged === true || entry.gatewayChanged === true
    || (isNonEmpty(entry.litellmBeforeHash) && isNonEmpty(entry.litellmAfterHash) && entry.litellmBeforeHash !== entry.litellmAfterHash)
    || (isNonEmpty(entry.gatewayBeforeHash) && isNonEmpty(entry.gatewayAfterHash) && entry.gatewayBeforeHash !== entry.gatewayAfterHash));
  const latestShadow = successfulShadow.slice(-3);
  const stableConfigHashes = latestShadow.length === 3
    && latestShadow.every((entry) => isNonEmpty(entry.litellmAfterHash) && isNonEmpty(entry.gatewayAfterHash))
    && new Set(latestShadow.map((entry) => entry.litellmAfterHash)).size === 1
    && new Set(latestShadow.map((entry) => entry.gatewayAfterHash)).size === 1;
  const stableShadow = latestShadow.length === 3
    && new Set(latestShadow.map((entry) => canonicalDecision(entry.wouldPrune, entry.wouldQuarantine))).size === 1
    && new Set(latestShadow.map((entry) => normalizeEpochMs(entry.stateTs!))).size === 3
    && stableConfigHashes;
  const expectedDecision = canonicalDecision(hardDead, analysis.wouldQuarantine);
  const shadowMatchesCurrent = stableShadow
    && latestShadow.every((entry) => canonicalDecision(entry.wouldPrune, entry.wouldQuarantine) === expectedDecision);
  const shadowRoutingProven = latestShadow.length === 3 && latestShadow.every((entry) =>
    provesLayerUnchanged(entry.litellmBeforeHash, entry.litellmAfterHash, entry.litellmChanged)
    && provesLayerUnchanged(entry.gatewayBeforeHash, entry.gatewayAfterHash, entry.gatewayChanged));

  const baseline = input.baseline;
  const baselineShapeValid = Boolean(baseline
    && Number.isInteger(baseline.applyAt) && baseline.applyAt >= R0_CUTOFF_MS && baseline.applyAt <= generatedAt
    && Number.isInteger(baseline.windowStartAt) && baseline.windowStartAt >= R0_CUTOFF_MS
    && Number.isInteger(baseline.windowEndAt) && baseline.windowEndAt > baseline.windowStartAt
    && baseline.windowEndAt <= baseline.capturedAt
    && Number.isInteger(baseline.capturedAt) && baseline.capturedAt <= baseline.applyAt
    && Number.isInteger(baseline.baselineCalls) && baseline.baselineCalls >= 20
    && Number.isInteger(baseline.baselineRateLimits) && baseline.baselineRateLimits >= 0
    && baseline.baselineRateLimits <= baseline.baselineCalls
    && isNonEmpty(baseline.evidenceRef));
  let reconciliation: CheckResult;
  if (futureShadow.length > 0) {
    reconciliation = result("r2.reconciliation", "FAIL", "A shadow observation is future-dated relative to this evidence run.", {
      futureShadowObservations: futureShadow.length,
      enforced: input.mode === "enforced",
    }, futureShadow.map((entry) => ({ invocationId: entry.invocationId, stateTs: entry.stateTs ?? null, decisionAt: entry.decisionAt ?? null })));
  } else if (shadowRoutingMutation.length > 0) {
    reconciliation = result("r2.reconciliation", "FAIL", "Shadow mode changed a rendered routing layer.", {
      trustedRows: analysis.trustedRows,
      eligibleTrustedRows: analysis.eligibleTrustedRows,
      shadowCycles: successfulShadow.length,
      enforced: input.mode === "enforced",
    }, [...decisionEvidence, ...shadowRoutingMutation.map((entry) => ({ invocationId: entry.invocationId, invariant: "shadow_is_read_only" }))]);
  } else if (analysis.excluded.ambiguousRoute > 0) {
    reconciliation = result("r2.reconciliation", "UNVERIFIABLE", "Trusted ledger rows have an ambiguous route identity and cannot support reconciliation.", {
      trustedRows: analysis.trustedRows,
      eligibleTrustedRows: analysis.eligibleTrustedRows,
      ambiguousRows: analysis.excluded.ambiguousRoute,
      enforced: input.mode === "enforced",
    }, decisionEvidence);
  } else if (analysis.excluded.unknownEligibility > 0) {
    reconciliation = result("r2.reconciliation", "PENDING", "Trusted ledger rows map to routes whose editorial eligibility is not proven; supply the authoritative eligible roster.", {
      trustedRows: analysis.trustedRows,
      eligibleTrustedRows: analysis.eligibleTrustedRows,
      unknownEligibilityRows: analysis.excluded.unknownEligibility,
      enforced: input.mode === "enforced",
    }, decisionEvidence);
  } else if (analysis.eligibleTrustedRows === 0) {
    reconciliation = result("r2.reconciliation", "PENDING", "No eligible trusted ledger evidence exists; an empty disagreement set is not proof.", {
      trustedRows: analysis.trustedRows,
      eligibleTrustedRows: 0,
      wouldPrune: hardDead.length,
      wouldQuarantine: analysis.wouldQuarantine.length,
      enforced: input.mode === "enforced",
    }, decisionEvidence);
  } else if (input.mode === "shadow") {
    if (stableShadow && !shadowMatchesCurrent) {
      reconciliation = result("r2.reconciliation", "FAIL", "Stable shadow decisions disagree with the trusted ledger computation.", {
        trustedRows: analysis.trustedRows,
        eligibleTrustedRows: analysis.eligibleTrustedRows,
        shadowCycles: successfulShadow.length,
        stableShadowSet: true,
        shadowMatchesCurrent: false,
        enforced: false,
      }, decisionEvidence);
    } else {
      reconciliation = result("r2.reconciliation", "PENDING",
        stableShadow && shadowRoutingProven
          ? "Three scheduled shadow decisions agree; apply remains pending until durable tombstone/recovery policy is enabled."
          : "R2 is in shadow mode and needs three matching scheduled decisions with proof that both routing layers stayed unchanged.", {
          trustedRows: analysis.trustedRows,
          eligibleTrustedRows: analysis.eligibleTrustedRows,
          shadowCycles: successfulShadow.length,
          stableShadowSet: stableShadow,
          stableConfigHashes,
          shadowMatchesCurrent,
          shadowRoutingProven,
          wouldPrune: hardDead.length,
          wouldQuarantine: analysis.wouldQuarantine.length,
          enforced: false,
        }, decisionEvidence);
    }
  } else {
    // SPEC 46 is planning-only. Until a strict live reader validates the full
    // tombstone transition/recovery schema, no asserted enforced state can be
    // accepted by this evaluator, even in a hand-built library input.
    reconciliation = result("r2.reconciliation", "UNVERIFIABLE", input.enforcementStateError
      ? `R2 prune enforcement is not implemented: ${sanitizeError(input.enforcementStateError)}`
      : "R2 prune enforcement is not implemented; SPEC 46 tombstone lifecycle assertions cannot be accepted.", {
      trustedRows: analysis.trustedRows,
      eligibleTrustedRows: analysis.eligibleTrustedRows,
      hardDeadRoutes: hardDead.length,
      activeTombstones: (input.tombstones ?? []).filter((entry) => entry.active).length,
      enforced: true,
    }, decisionEvidence);
  }

  const clocks = input.exact429Clocks ?? [];
  const recent429Routes = analysis.aggregates
    .filter((entry) => entry.eligible && entry.recentRateLimit > 0)
    .map((entry) => entry.logicalName);
  let exact429: CheckResult;
  if (input.exact429StateVerified !== true) {
    exact429 = result("r2.exact_429", clocks.length === 0 ? "PENDING" : "UNVERIFIABLE", clocks.length === 0
      ? "No live exact-code 429 state exists yet; category timing is not accepted as a substitute."
      : "Exact-code 429 clocks were not read from a strictly validated live persisted state; operator assertions are not accepted.", {
      exact429Clocks: clocks.length,
      recent429Routes: recent429Routes.length,
      decayWindowMs: input.decayWindowMs ?? null,
    });
  } else if (clocks.length === 0) {
    exact429 = result("r2.exact_429", "PENDING", "No separately validated exact-code 429 clock exists; category since is not accepted.", {
      exact429Clocks: 0,
      recent429Routes: recent429Routes.length,
      decayWindowMs: input.decayWindowMs ?? null,
    });
  } else if (input.managedChainsAvailable !== true) {
    exact429 = result("r2.exact_429", "UNVERIFIABLE", "Managed fallback chains are unavailable, so exact-429 demotion or pruning cannot be verified.", {
      exact429Clocks: clocks.length,
      recent429Routes: recent429Routes.length,
      decayWindowMs: input.decayWindowMs ?? null,
    });
  } else {
    const decay = input.decayWindowMs;
    if (typeof decay !== "number" || !Number.isFinite(decay) || decay < R2_RATE_LIMIT_MIN_AGE_MS) {
      exact429 = result("r2.exact_429", "PENDING", "The exact-code clock exists, but a valid decay window of at least 48 hours is not configured.", {
        exact429Clocks: clocks.length,
        decayWindowMs: decay ?? null,
      });
    } else {
      const clockViolations: Array<Record<string, unknown>> = [];
      const clockByRoute = new Map<string, Exact429Clock>();
      const validTimestamp = (value: number | null | undefined): value is number =>
        typeof value === "number" && Number.isFinite(value) && value > 0;
      for (const clock of clocks) {
        if (!isNonEmpty(clock.logicalName)) {
          clockViolations.push({ logicalName: null, invariant: "nonempty_logical_name" });
          continue;
        }
        if (clockByRoute.has(clock.logicalName)) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "unique_clock_per_route" });
          continue;
        }
        clockByRoute.set(clock.logicalName, clock);
        if (!Number.isInteger(clock.currentCode) || clock.currentCode! < 0 || clock.currentCode! > 599) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "valid_current_code", currentCode: clock.currentCode });
          continue;
        }
        const firstPresent = clock.first429At !== null;
        const lastPresent = clock.last429At !== null;
        if (firstPresent !== lastPresent
          || (firstPresent && (!validTimestamp(clock.first429At) || !validTimestamp(clock.last429At)))
          || (validTimestamp(clock.first429At) && validTimestamp(clock.last429At)
            && normalizeEpochMs(clock.last429At) < normalizeEpochMs(clock.first429At))) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "ordered_429_clock", first429At: clock.first429At, last429At: clock.last429At });
        }
        if (clock.resetAt !== null && clock.resetAt !== undefined && !validTimestamp(clock.resetAt)) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "valid_reset_time", resetAt: clock.resetAt });
        }
        if (clock.currentCode !== 429 && (firstPresent || lastPresent || !validTimestamp(clock.resetAt))) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "non_429_resets_clock", currentCode: clock.currentCode, first429At: clock.first429At, last429At: clock.last429At, resetAt: clock.resetAt ?? null });
        }
        if (clock.currentCode === 429 && (!validTimestamp(clock.first429At) || !validTimestamp(clock.last429At))) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "429_requires_exact_clock" });
        }
        if (clock.currentCode === 429 && clock.first429At !== null && clock.last429At !== null) {
          const age = normalizeEpochMs(clock.last429At) - normalizeEpochMs(clock.first429At);
          const route = analysis.aggregates.find((entry) => entry.logicalName === clock.logicalName);
          if (clock.action !== "limited" && clock.action !== "demoted" && clock.action !== "pruned") {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "429_action_required", action: clock.action ?? null });
          }
          if ((route?.recentSuccesses ?? 0) > 0 && clock.action !== "limited") {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "successful_429_stays_limited", action: clock.action ?? null });
          }
          if (clock.action === "pruned" && route && route.recentRateLimit > 0 && route.recentRateLimit !== route.recentCalls) {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "mixed_429_policy_non_destructive", action: clock.action });
          }
          if (age >= decay && clock.action !== "demoted" && clock.action !== "pruned") {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "aged_429_policy", ageMs: age, action: clock.action ?? null });
          }
          const isChainHead = Object.values(input.managedChains).some((chain) => chain[0] === clock.logicalName);
          if (isChainHead) {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "current_429_deprioritized_from_chain_heads", ageMs: age });
          }
          if (clock.action === "pruned" && Object.values(input.managedChains).some((chain) => chain.includes(clock.logicalName))) {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "pruned_429_absent_from_all_managed_chains", ageMs: age });
          }
        }
        const aggregate = analysis.aggregates.find((entry) => entry.logicalName === clock.logicalName);
        const first429At = validTimestamp(clock.first429At) ? normalizeEpochMs(clock.first429At) : null;
        const last429At = validTimestamp(clock.last429At) ? normalizeEpochMs(clock.last429At) : null;
        const resetAt = validTimestamp(clock.resetAt) ? normalizeEpochMs(clock.resetAt) : null;
        if ([first429At, last429At, resetAt].some((value) => value !== null && value > generatedAt)) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "clock_not_future" });
        }
        if (clock.currentCode === 429 && resetAt !== null && first429At !== null && resetAt >= first429At) {
          clockViolations.push({ logicalName: clock.logicalName, invariant: "reset_precedes_current_429_run", resetAt, first429At });
        }
        if (aggregate?.lastRateLimitAt !== null && aggregate?.lastRateLimitAt !== undefined) {
          const trustedLast429At = normalizeEpochMs(aggregate.lastRateLimitAt);
          if (clock.currentCode !== 429 && (resetAt === null || resetAt < trustedLast429At)) {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "reset_after_latest_trusted_429", resetAt, trustedLast429At });
          }
          if (clock.currentCode === 429 && (last429At === null || last429At < trustedLast429At)) {
            clockViolations.push({ logicalName: clock.logicalName, invariant: "clock_covers_latest_trusted_429", last429At, trustedLast429At });
          }
        }
      }
      const missingRoutes = recent429Routes.filter((logicalName) => !clockByRoute.has(logicalName));
      const metrics = { exact429Clocks: clocks.length, recent429Routes: recent429Routes.length, missingRecentRoutes: missingRoutes.length, decayWindowMs: decay };
      if (clockViolations.length > 0) {
        exact429 = result("r2.exact_429", "FAIL", "An exact-code 429 clock is malformed or violates decay/reset policy.", metrics, clockViolations);
      } else if (missingRoutes.length > 0) {
        exact429 = result("r2.exact_429", "PENDING", "At least one route with recent trusted 429 evidence lacks an exact-code clock.", metrics,
          missingRoutes.map((logicalName) => ({ logicalName, invariant: "exact_clock_required" })));
      } else if (recent429Routes.length === 0) {
        exact429 = result("r2.exact_429", "PENDING", "Exact-code clock shape is valid, but no recent trusted 429 route exercises the policy.", metrics);
      } else {
        exact429 = result("r2.exact_429", "PASS", "Every recent trusted 429 route has a valid independent exact-code clock with decay/reset policy enforced.", metrics,
          clocks.map((clock) => ({ logicalName: clock.logicalName, currentCode: clock.currentCode, action: clock.action ?? null })));
      }
    }
  }

  let outcome: CheckResult;
  if (!baseline) {
    outcome = result("r2.outcome_delta", "PENDING", "No frozen timestamped pre-R2 comparable cohort exists.");
  } else if (input.baselineVerified !== true || !baselineShapeValid) {
    outcome = result("r2.outcome_delta", "UNVERIFIABLE", "The frozen baseline has an invalid cohort shape or provenance.", {
      applyAt: Number.isFinite(baseline.applyAt) ? baseline.applyAt : null,
      baselineCalls: Number.isFinite(baseline.baselineCalls) ? baseline.baselineCalls : null,
      baselineRateLimits: Number.isFinite(baseline.baselineRateLimits) ? baseline.baselineRateLimits : null,
    });
  } else if (input.mode !== "enforced" || input.enforcementStateVerified !== true || reconciliation.verdict !== "PASS") {
    outcome = result("r2.outcome_delta", "PENDING", "A valid baseline exists, but no strictly verified R2 enforcement apply point exists yet.", {
      applyAt: baseline.applyAt,
      baselineCalls: baseline.baselineCalls,
      baselineRateLimits: baseline.baselineRateLimits,
      enforced: input.mode === "enforced",
      enforcementStateVerified: input.enforcementStateVerified === true,
    });
  } else {
    const postAttemptRows = input.rows.filter((row) => row.ts >= baseline.applyAt && row.backend !== "cli-direct"
      && (row.tenant_id === null || row.tenant_id === "mimule"));
    const aliases = buildRouteAliases(input.routes);
    const comparableAttempts = postAttemptRows.filter((row) => row.error_class !== "gateway_unreachable"
      && (isSuccess(row.success) || TRUSTED_FAILURES.has(row.error_class ?? "")));
    const identityViolations = comparableAttempts.filter((row) => !isNonEmpty(row.resolved_model)
      || aliases.ambiguous.has(row.resolved_model) || !aliases.unique.has(row.resolved_model));
    const mappedPostAttempts = comparableAttempts.filter((row) => isNonEmpty(row.resolved_model)
      && !aliases.ambiguous.has(row.resolved_model) && aliases.unique.has(row.resolved_model));
    const postRows = mappedPostAttempts;
    const postRateLimits = postRows.filter((row) => !isSuccess(row.success) && row.error_class === "rate_limit").length;
    const baselineShare = baseline.baselineCalls > 0 ? baseline.baselineRateLimits / baseline.baselineCalls : null;
    const postShare = postRows.length > 0 ? postRateLimits / postRows.length : null;
    const hardDeadAttempts = mappedPostAttempts.filter((row) => {
      const route = aliases.unique.get(row.resolved_model);
      return route ? effectiveHardDead.includes(route.logicalName) : false;
    }).length;
    const metrics = {
      applyAt: baseline.applyAt,
      baselineCalls: baseline.baselineCalls,
      baselineRateLimitSharePct: baselineShare === null ? null : baselineShare * 100,
      postApplyCalls: postRows.length,
      postApplyRateLimitSharePct: postShare === null ? null : postShare * 100,
      hardDeadAttempts,
      identityViolations: identityViolations.length,
    };
    if (hardDeadAttempts > 0) outcome = result("r2.outcome_delta", "FAIL", "A post-apply real request attempted a hard-dead route.", metrics);
    else if (identityViolations.length > 0) outcome = result("r2.outcome_delta", "UNVERIFIABLE", "Post-apply LiteLLM rows have ambiguous or unmapped route identities and cannot support the comparable cohort.", metrics,
      identityViolations.map((row) => ({ id: row.id, resolvedModel: row.resolved_model, invariant: "exact_route_identity" })));
    else if (postRows.length < 20) outcome = result("r2.outcome_delta", "PENDING", "Fewer than 20 comparable post-apply calls exist.", metrics);
    else if (postShare !== null && postShare >= baselineShare) outcome = result("r2.outcome_delta", "FAIL", "Post-apply rate-limit share did not improve against the frozen comparable baseline.", metrics);
    else outcome = result("r2.outcome_delta", "PASS", "Comparable post-apply rate-limit share improved and no hard-dead route was attempted.", metrics);
  }

  return { checks: [reconciliation, exact429, outcome], hardDead: effectiveHardDead };
}

export interface ModelsApiValidation {
  valid: boolean;
  modelCount: number;
  healthy: number;
  unhealthy: number;
  unknown: number;
  errors: string[];
}

export function validateModelsApi(payload: unknown): ModelsApiValidation {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, modelCount: 0, healthy: 0, unhealthy: 0, unknown: 0, errors: ["payload must be an object"] };
  }
  const data = (payload as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { valid: false, modelCount: 0, healthy: 0, unhealthy: 0, unknown: 0, errors: ["data must be an object"] };
  }
  const models = (data as Record<string, unknown>).models;
  const summary = (data as Record<string, unknown>).summary;
  if (!Array.isArray(models)) errors.push("data.models must be an array");
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) errors.push("data.summary must be an object");
  if (!Array.isArray(models) || !summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { valid: false, modelCount: 0, healthy: 0, unhealthy: 0, unknown: 0, errors };
  }
  const stateCounts = Object.fromEntries(HEALTH_STATES.map((state) => [state, 0])) as Record<(typeof HEALTH_STATES)[number], number>;
  const bucketCounts = Object.fromEntries(HEALTH_BUCKETS.map((bucket) => [bucket, 0])) as Record<(typeof HEALTH_BUCKETS)[number], number>;
  const logicalNames = new Set<string>();
  models.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errors.push(`models[${index}] must be an object`); return; }
    const row = raw as Record<string, unknown>;
    if (!isExactRouteName(row.logicalName)) errors.push(`models[${index}].logicalName is invalid`);
    else if (logicalNames.has(row.logicalName)) errors.push(`models[${index}].logicalName is duplicated`);
    else logicalNames.add(row.logicalName);
    if (!isNonEmpty(row.resolvedModel)) errors.push(`models[${index}].resolvedModel is empty`);
    if (!HEALTH_STATES.includes(row.healthState as (typeof HEALTH_STATES)[number])) errors.push(`models[${index}].healthState is invalid`);
    else stateCounts[row.healthState as (typeof HEALTH_STATES)[number]] += 1;
    if (!HEALTH_BUCKETS.includes(row.healthBucket as (typeof HEALTH_BUCKETS)[number])) errors.push(`models[${index}].healthBucket is invalid`);
    else bucketCounts[row.healthBucket as (typeof HEALTH_BUCKETS)[number]] += 1;
    const expectedBucket = row.healthState === "live" || row.healthState === "limited" || row.healthState === "slow"
      ? "healthy"
      : row.healthState === "degraded" || row.healthState === "dead" || row.healthState === "hang"
        ? "unhealthy"
        : row.healthState === "unknown" ? "unknown" : null;
    if (expectedBucket !== null && row.healthBucket !== expectedBucket) errors.push(`models[${index}].healthBucket does not match healthState`);
    if (!isNonEmpty(row.healthReason)) errors.push(`models[${index}].healthReason is empty`);
  });
  const summaryRecord = summary as Record<string, unknown>;
  const states = summaryRecord.healthStateSummary;
  const buckets = summaryRecord.healthBucketSummary;
  if (!states || typeof states !== "object" || Array.isArray(states)) errors.push("healthStateSummary must be an object");
  else {
    if (JSON.stringify(Object.keys(states).sort()) !== JSON.stringify([...HEALTH_STATES].sort())) errors.push("healthStateSummary keys are not exact");
    for (const state of HEALTH_STATES) {
      if ((states as Record<string, unknown>)[state] !== stateCounts[state]) errors.push(`healthStateSummary.${state} does not match rows`);
    }
  }
  if (!buckets || typeof buckets !== "object" || Array.isArray(buckets)) errors.push("healthBucketSummary must be an object");
  else {
    if (JSON.stringify(Object.keys(buckets).sort()) !== JSON.stringify([...HEALTH_BUCKETS].sort())) errors.push("healthBucketSummary keys are not exact");
    for (const bucket of HEALTH_BUCKETS) {
      if ((buckets as Record<string, unknown>)[bucket] !== bucketCounts[bucket]) errors.push(`healthBucketSummary.${bucket} does not match rows`);
    }
  }
  const stateTotal = Object.values(stateCounts).reduce((sum, count) => sum + count, 0);
  const bucketTotal = Object.values(bucketCounts).reduce((sum, count) => sum + count, 0);
  if (stateTotal !== models.length) errors.push("health-state summary total does not equal models.length");
  if (bucketTotal !== models.length) errors.push("health-bucket summary total does not equal models.length");
  return {
    valid: errors.length === 0,
    modelCount: models.length,
    healthy: bucketCounts.healthy,
    unhealthy: bucketCounts.unhealthy,
    unknown: bucketCounts.unknown,
    errors,
  };
}

export function evaluateR3(input: ModelsApiObservation | undefined): CheckResult {
  if (!input) return result("r3.api_contract", "PENDING", "No live authenticated /api/models observation was supplied.");
  if (!input.available) {
    return result("r3.api_contract", "UNVERIFIABLE", input.error ? `The models API could not be read: ${sanitizeError(input.error)}` : "The models API could not be read.");
  }
  if (input.anonymousStatus !== 401) {
    return result("r3.api_contract", "FAIL", "Anonymous GET /api/models did not return 401.", { anonymousStatus: input.anonymousStatus });
  }
  if (!input.authConfigured || input.authenticatedStatus === null) {
    return result("r3.api_contract", "UNVERIFIABLE", "No authenticated API observation is available.", { anonymousStatus: input.anonymousStatus, authConfigured: input.authConfigured });
  }
  if (input.authenticatedStatus !== 200) {
    return result("r3.api_contract", "FAIL", "Authenticated GET /api/models did not return 200.", {
      anonymousStatus: input.anonymousStatus,
      authenticatedStatus: input.authenticatedStatus,
    });
  }
  const validation = validateModelsApi(input.payload);
  const metrics = {
    anonymousStatus: input.anonymousStatus,
    authenticatedStatus: input.authenticatedStatus,
    models: validation.modelCount,
    healthy: validation.healthy,
    unhealthy: validation.unhealthy,
    unknown: validation.unknown,
  };
  if (!validation.valid) {
    return result("r3.api_contract", "FAIL", "The authenticated models payload violates the health-state contract.", metrics,
      validation.errors.map((error) => ({ error })));
  }
  if (validation.healthy < 1 || validation.unhealthy < 1) {
    return result("r3.api_contract", "PENDING", "The payload is structurally valid but does not yet show both healthy and unhealthy observed routes.", metrics);
  }
  return result("r3.api_contract", "PASS", "Authentication, row enums, reasons, summaries, and observed healthy/unhealthy separation are valid.", metrics);
}

export function evaluateLiveSurface(input: LiveSurfaceObservation | undefined): CheckResult {
  if (!input) return result("live.surface", "PENDING", "No live deployment smoke observation was supplied.");
  const violations: Array<Record<string, unknown>> = [];
  const missing: string[] = [];
  if (input.healthStatus === null || input.healthStatus === undefined) missing.push("/health response");
  else if (input.healthStatus !== 200 || input.healthOk !== true) {
    violations.push({ endpoint: "/health", status: input.healthStatus, ok: input.healthOk ?? false });
  }
  if (input.versionStatus === null || input.versionStatus === undefined) missing.push("/api/version response");
  else if (input.versionStatus !== 200) violations.push({ endpoint: "/api/version", status: input.versionStatus });
  if (input.modelsShellStatus === null || input.modelsShellStatus === undefined) {
    missing.push("/models response");
  } else if (input.modelsShellStatus !== 200) {
    violations.push({ endpoint: "/models", status: input.modelsShellStatus });
  } else {
    if (typeof input.modelsShellContentType !== "string" || !input.modelsShellContentType.toLowerCase().includes("text/html")) {
      violations.push({ endpoint: "/models", invariant: "html_content_type", contentType: input.modelsShellContentType ?? null });
    }
    if (input.modelsShellMarker !== true) violations.push({ endpoint: "/models", invariant: "application_shell_marker" });
  }
  if (input.serviceActive === null || input.serviceActive === undefined) missing.push("service active state");
  else if (!input.serviceActive) violations.push({ invariant: "control-surface.service active", active: false });
  if (input.newErrorEntries === null || input.newErrorEntries === undefined) missing.push("post-deploy error journal count");
  else if (input.newErrorEntries > 0) violations.push({ invariant: "no new error journal entries", count: input.newErrorEntries });
  if (!isCommitId(input.candidateCommit) || !isCommitId(input.deployedCommit)) {
    missing.push("valid candidate/deployed commit identity (7-40 hex characters)");
  } else if (!commitsMatch(input.candidateCommit, input.deployedCommit)) {
    violations.push({ invariant: "candidate deployed", candidateCommit: input.candidateCommit, deployedCommit: input.deployedCommit });
  }
  const metrics = {
    healthStatus: input.healthStatus ?? null,
    versionStatus: input.versionStatus ?? null,
    modelsShellStatus: input.modelsShellStatus ?? null,
    modelsShellMarker: input.modelsShellMarker ?? false,
    serviceActive: input.serviceActive ?? false,
    newErrorEntries: input.newErrorEntries ?? null,
    deployedCommit: input.deployedCommit ?? null,
    candidateCommit: input.candidateCommit ?? null,
  };
  if (violations.length > 0) return result("live.surface", "FAIL", "The live deployment smoke contract has a proven violation.", metrics, violations);
  if (!input.available) {
    return result("live.surface", "UNVERIFIABLE", input.error ? sanitizeError(input.error) : "Live surface evidence is incomplete.", metrics,
      missing.map((field) => ({ missing: field })));
  }
  if (missing.length > 0) return result("live.surface", "PENDING", "The live smoke is incomplete.", metrics, missing.map((field) => ({ missing: field })));
  return result("live.surface", "PASS", "Live health, version, shell, service, and journal smoke checks pass.", metrics);
}

export function evaluateValidation(
  input: ValidationObservation | undefined,
  candidateCommit: string | null | undefined,
  generatedAt: number,
): CheckResult[] {
  const ids = ["classifier.contract", "validation.bounded", "r3.ui_contract", "fresh_host.api_only"] as const;
  if (!input) return ids.map((id) => result(id, "PENDING", "No immutable validation observation was supplied for this candidate."));
  if (input.manifestVerified !== true) {
    const note = input.manifestError
      ? `The immutable validation manifest is untrustworthy: ${sanitizeError(input.manifestError)}`
      : "No strictly validated immutable validation manifest was supplied for this candidate.";
    return ids.map((id) => result(id, "UNVERIFIABLE", note));
  }
  if (input.candidateTrackedClean !== true) {
    return ids.map((id) => result(id, "FAIL", "Relevant candidate files are dirty or untracked, so HEAD cannot identify the validated source."));
  }

  const provenance: Array<Record<string, unknown>> = [];
  if (!Number.isFinite(input.recordedAt) || input.recordedAt < R0_CUTOFF_MS || input.recordedAt > generatedAt) {
    provenance.push({ invariant: "validation_timestamp", recordedAt: input.recordedAt });
  }
  if (!isCommitId(input.commit)) provenance.push({ invariant: "validation_commit", commit: input.commit });
  if (isCommitId(input.commit) && isCommitId(candidateCommit) && !commitsMatch(input.commit, candidateCommit)) {
    provenance.push({ invariant: "validation_matches_candidate", validationCommit: input.commit, candidateCommit });
  }
  const baseMetrics = { recordedAt: Number.isFinite(input.recordedAt) ? input.recordedAt : null, commit: isCommitId(input.commit) ? input.commit : null };

  const classifierComplete = input.classifier && typeof input.classifier.sourceVerified === "boolean"
    && typeof input.classifier.testsPassed === "boolean" && Number.isInteger(input.classifier.cases)
    && isNonEmpty(input.classifier.evidenceRef);
  const classifierViolations = [...provenance];
  if (classifierComplete && (!input.classifier.sourceVerified || !input.classifier.testsPassed || input.classifier.cases < 12)) {
    classifierViolations.push({ invariant: "anchored_classifier_and_cases", sourceVerified: input.classifier.sourceVerified, testsPassed: input.classifier.testsPassed, cases: input.classifier.cases });
  }
  const classifier = !classifierComplete
    ? result("classifier.contract", "PENDING", "Classifier source/test evidence is incomplete.", baseMetrics)
    : classifierViolations.length > 0
      ? result("classifier.contract", "FAIL", "Classifier validation has a proven contract or provenance violation.", { ...baseMetrics, cases: input.classifier.cases }, classifierViolations)
      : result("classifier.contract", "PASS", "Anchored classifier source and focused precedence cases pass for this candidate.", { ...baseMetrics, cases: input.classifier.cases }, [{ evidenceRef: input.classifier.evidenceRef }]);

  const boundedComplete = input.bounded && typeof input.bounded.focusedTestsPassed === "boolean"
    && Number.isInteger(input.bounded.testFiles) && typeof input.bounded.typecheckPassed === "boolean"
    && typeof input.bounded.buildPassed === "boolean" && typeof input.bounded.forbiddenProcessesSpawned === "boolean"
    && isNonEmpty(input.bounded.evidenceRef);
  const boundedViolations = [...provenance];
  if (boundedComplete && (!input.bounded.focusedTestsPassed || input.bounded.testFiles < 6
    || !input.bounded.typecheckPassed || !input.bounded.buildPassed || input.bounded.forbiddenProcessesSpawned)) {
    boundedViolations.push({ invariant: "bounded_validation", focusedTestsPassed: input.bounded.focusedTestsPassed, testFiles: input.bounded.testFiles, typecheckPassed: input.bounded.typecheckPassed, buildPassed: input.bounded.buildPassed, forbiddenProcessesSpawned: input.bounded.forbiddenProcessesSpawned });
  }
  const bounded = !boundedComplete
    ? result("validation.bounded", "PENDING", "Bounded test/typecheck/build evidence is incomplete.", baseMetrics)
    : boundedViolations.length > 0
      ? result("validation.bounded", "FAIL", "Bounded validation has a proven failure or provenance violation.", { ...baseMetrics, testFiles: input.bounded.testFiles }, boundedViolations)
      : result("validation.bounded", "PASS", "Focused tests, typecheck, production build, and forbidden-process guard pass.", { ...baseMetrics, testFiles: input.bounded.testFiles }, [{ evidenceRef: input.bounded.evidenceRef }]);

  const uiComplete = input.ui && typeof input.ui.contractTestsPassed === "boolean"
    && Number.isInteger(input.ui.assertions) && isNonEmpty(input.ui.evidenceRef);
  const uiViolations = [...provenance];
  if (uiComplete && (!input.ui.contractTestsPassed || input.ui.assertions < 1)) {
    uiViolations.push({ invariant: "ui_health_contract", contractTestsPassed: input.ui.contractTestsPassed, assertions: input.ui.assertions });
  }
  const ui = !uiComplete
    ? result("r3.ui_contract", "PENDING", "UI health-presentation contract evidence is incomplete.", baseMetrics)
    : uiViolations.length > 0
      ? result("r3.ui_contract", "FAIL", "UI contract validation has a proven failure or provenance violation.", { ...baseMetrics, assertions: input.ui.assertions }, uiViolations)
      : result("r3.ui_contract", "PASS", "The extracted UI health contract tests pass for this candidate.", { ...baseMetrics, assertions: input.ui.assertions }, [{ evidenceRef: input.ui.evidenceRef }]);

  const freshComplete = input.freshHost && typeof input.freshHost.apiOnly === "boolean"
    && [input.freshHost.total, input.freshHost.honest, input.freshHost.leak, input.freshHost.crash, input.freshHost.error5xx].every(Number.isInteger)
    && isCommitId(input.freshHost.commit) && isNonEmpty(input.freshHost.evidenceRef);
  const freshViolations = [...provenance];
  if (freshComplete && (!input.freshHost.apiOnly || input.freshHost.total < 1
    || input.freshHost.honest !== input.freshHost.total || input.freshHost.leak !== 0
    || input.freshHost.crash !== 0 || input.freshHost.error5xx !== 0
    || (isCommitId(input.commit) && !commitsMatch(input.commit, input.freshHost.commit)))) {
    freshViolations.push({ invariant: "api_only_fresh_host", apiOnly: input.freshHost.apiOnly, total: input.freshHost.total, honest: input.freshHost.honest, leak: input.freshHost.leak, crash: input.freshHost.crash, error5xx: input.freshHost.error5xx, freshHostCommit: input.freshHost.commit });
  }
  const freshHost = !freshComplete
    ? result("fresh_host.api_only", "PENDING", "API-only fresh-host evidence is incomplete.", baseMetrics)
    : freshViolations.length > 0
      ? result("fresh_host.api_only", "FAIL", "Fresh-host validation has a proven failure or provenance violation.", { ...baseMetrics, total: input.freshHost.total, honest: input.freshHost.honest }, freshViolations)
      : result("fresh_host.api_only", "PASS", "Every API-only fresh-host route is honest with zero leak, crash, or 5xx result.", { ...baseMetrics, total: input.freshHost.total, honest: input.freshHost.honest }, [{ evidenceRef: input.freshHost.evidenceRef }]);

  return [classifier, bounded, ui, freshHost];
}

export function evaluateEvidenceHistory(input: EvidenceHistoryObservation | undefined): CheckResult {
  if (!input) return result("evidence.history", "PENDING", "No strict immutable-evidence history observation was supplied.");
  const metrics = {
    artifacts: Number.isInteger(input.artifacts) ? input.artifacts : 0,
    r1Observations: Number.isInteger(input.r1Observations) ? input.r1Observations : 0,
    r2Observations: Number.isInteger(input.r2Observations) ? input.r2Observations : 0,
  };
  if (!input.available) {
    return result("evidence.history", "UNVERIFIABLE", input.error
      ? `Immutable evidence history is not trustworthy: ${sanitizeError(input.error)}`
      : "Immutable evidence history is not trustworthy.", metrics);
  }
  if (input.sourceTreesClean !== true) {
    return result("evidence.history", "FAIL", "Candidate source provenance is dirty or untracked in a routing-relevant worktree.", metrics);
  }
  if ([input.artifacts, input.r1Observations, input.r2Observations].some((value) => !Number.isInteger(value) || value < 0)) {
    return result("evidence.history", "FAIL", "Immutable evidence history counters are malformed.", metrics);
  }
  return result("evidence.history", "PASS", "All prior candidate evidence artifacts accepted by the verifier passed strict provenance and shape validation.", metrics);
}

export function evaluateAcceptanceLog(
  input: AcceptanceLogObservation | undefined,
  candidateCommit: string | null | undefined,
  generatedAt: number,
): CheckResult {
  if (!input) return result("acceptance.log", "PENDING", "The accepted technical-evidence summary has not yet been appended to the UTC AI Vault log.");
  const metrics = { recordedAt: input.recordedAt, commit: input.commit, path: input.path, evidencePath: input.evidencePath };
  if (!input.available) {
    return result("acceptance.log", "UNVERIFIABLE", input.error
      ? `The AI Vault acceptance receipt could not be verified: ${sanitizeError(input.error)}`
      : "The AI Vault acceptance receipt could not be verified.", metrics);
  }
  const violations: Array<Record<string, unknown>> = [];
  const timestampValid = Number.isInteger(input.recordedAt) && input.recordedAt >= R0_CUTOFF_MS
    && input.recordedAt <= generatedAt && input.recordedAt <= 8_640_000_000_000_000;
  const expectedDate = timestampValid ? new Date(input.recordedAt).toISOString().slice(0, 10) : null;
  if (!timestampValid) violations.push({ invariant: "receipt_timestamp" });
  if (expectedDate === null || input.path !== `/opt/ai-vault/daily/${expectedDate}.md`) {
    violations.push({ invariant: "fixed_daily_log_path", expectedDate });
  }
  if (!/^\/var\/lib\/control-surface\/repair-arc-evidence\/\d{8}T\d{6}Z\.json$/.test(input.evidencePath)) violations.push({ invariant: "immutable_evidence_path" });
  if (!isCommitId(input.commit)) violations.push({ invariant: "receipt_commit" });
  else if (isCommitId(candidateCommit) && !commitsMatch(input.commit, candidateCommit)) violations.push({ invariant: "receipt_matches_candidate", candidateCommit });
  return violations.length > 0
    ? result("acceptance.log", "FAIL", "The AI Vault acceptance receipt has a proven provenance violation.", metrics, violations)
    : result("acceptance.log", "PASS", "The UTC AI Vault log references the immutable all-technical-gates evidence for this candidate.", metrics);
}

export function evaluateWorkRun(
  kind: "editorial" | "builder",
  input: WorkRunObservation | undefined,
  hardDead: Set<string>,
  gatewayRows: GatewayCallRow[] | undefined,
  routes: R2Route[],
  generatedAt: number,
  requiredAfter: number,
  candidateCommit?: string | null,
): CheckResult {
  const id = `r6.${kind}`;
  if (!input || !input.authorized) return result(id, "PENDING", `The bounded ${kind} acceptance run lacks explicit operator authorization or evidence.`);
  const traces = input.traces ?? [];
  const traceIds = traces.map((entry) => entry.traceId);
  const metrics = {
    startedAt: input.startedAt ?? null,
    finishedAt: input.finishedAt ?? null,
    success: input.success ?? null,
    traceIds: traceIds.length,
    orderedHops: traces.reduce((sum, entry) => sum + entry.orderedHops.length, 0),
    validatorPassed: input.validatorPassed ?? null,
    ledgerRows: 0,
    attemptCount: input.attemptCount ?? 0,
    workflowId: input.workflowId ?? null,
    stageId: input.stageId ?? null,
    builderPassId: input.builderPassId ?? null,
  };
  if (input.receiptVerified !== true) {
    return result(id, "UNVERIFIABLE", input.receiptError
      ? `The bounded ${kind} receipt is untrustworthy: ${sanitizeError(input.receiptError)}`
      : `The bounded ${kind} run is not backed by a strictly validated immutable receipt.`, metrics);
  }
  if (input.attemptCount !== 1) {
    return result(id, "FAIL", `R6 requires exactly one authorized bounded ${kind} attempt for this candidate.`, metrics);
  }
  if ((input.priorFailures?.length ?? 0) > 0) {
    return result(id, "FAIL", `A prior bounded ${kind} acceptance attempt failed and cannot be erased by a later retry.`, metrics,
      input.priorFailures!.map((failure) => ({ evidenceRef: failure.evidenceRef, at: failure.at, reason: failure.reason })));
  }
  if (input.success === false || input.validatorPassed === false || input.hardDeadRouteUsed === true) {
    return result(id, "FAIL", `The authorized ${kind} acceptance run failed a hard gate.`, metrics, [{
      runId: input.id ?? null,
      success: input.success ?? null,
      validatorPassed: input.validatorPassed ?? null,
      hardDeadRouteUsed: input.hardDeadRouteUsed ?? false,
    }]);
  }
  const naturalIdentifiers = [input.id, input.workflowId, ...traceIds]
    .every((value) => isNonEmpty(value) && !SYNTHETIC_IDENTITY.test(value));
  const typeSpecificIdentity = kind === "editorial"
    ? isNonEmpty(input.stageId) && !SYNTHETIC_IDENTITY.test(input.stageId)
      && (input.builderPassId === null || input.builderPassId === undefined)
    : isNonEmpty(input.builderPassId) && !SYNTHETIC_IDENTITY.test(input.builderPassId)
      && (input.stageId === null || input.stageId === undefined);
  if (!naturalIdentifiers || !typeSpecificIdentity) {
    return result(id, "PENDING", `The ${kind} receipt is not bound to a natural type-specific workflow/run identity.`, metrics);
  }
  const complete = isUuidV4(input.authorizationId) && isNonEmpty(input.id) && isNonEmpty(input.evidenceRef)
    && new RegExp(`^/var/lib/control-surface/repair-arc-evidence/receipts/r6-${kind}-[a-f0-9-]{36}\\.json$`, "i").test(input.evidenceRef)
    && isSha256(input.receiptSha256)
    && isNonEmpty(input.validatorEvidenceRef)
    && new RegExp(`^/var/lib/control-surface/repair-arc-evidence/receipts/r6-validator-${kind}-[a-f0-9-]{36}\\.json$`, "i").test(input.validatorEvidenceRef)
    && isSha256(input.validatorEvidenceSha256) && input.validatorVerified === true && input.subjectVerified === true
    && typeof input.candidateCommit === "string" && /^[a-f0-9]{40}$/i.test(input.candidateCommit)
    && typeof candidateCommit === "string" && input.candidateCommit === candidateCommit
    && typeof input.deployedCommit === "string" && input.deployedCommit === candidateCommit
    && typeof input.deploymentObservedAt === "number" && Number.isFinite(input.deploymentObservedAt)
    && typeof input.deploymentConfirmedAt === "number" && Number.isFinite(input.deploymentConfirmedAt)
    && isNonEmpty(input.expectedCaller) && !SYNTHETIC_IDENTITY.test(input.expectedCaller)
    && input.expectedTenant === "mimule"
    && typeof input.startedAt === "number" && Number.isFinite(input.startedAt)
    && typeof input.finishedAt === "number" && Number.isFinite(input.finishedAt)
    && input.success === true && input.validatorPassed === true && input.hardDeadRouteUsed === false
    && traces.length > 0 && traces.length <= 64 && traceIds.every(isUuidV4) && new Set(traceIds).size === traceIds.length
    && traces.every((entry) => entry && typeof entry === "object" && entry.orderedHops.length > 0
      && entry.orderedHops.length <= 32 && entry.orderedHops.every(isExactRouteName));
  if (!complete) return result(id, "PENDING", `The ${kind} run observation is incomplete.`, metrics);
  if (input.startedAt! < requiredAfter || input.finishedAt! < input.startedAt!
    || input.finishedAt! > generatedAt || input.finishedAt! - input.startedAt! > 4 * 60 * 60 * 1_000
    || input.deploymentObservedAt! < requiredAfter || input.deploymentObservedAt! > input.startedAt!
    || input.deploymentConfirmedAt! < input.finishedAt! || input.deploymentConfirmedAt! > generatedAt) {
    return result(id, "FAIL", `The authorized ${kind} run has stale, future, negative, or unbounded timestamps.`, metrics, [{
      runId: input.id, requiredAfter, generatedAt, startedAt: input.startedAt, finishedAt: input.finishedAt,
    }]);
  }
  if (!gatewayRows) return result(id, "UNVERIFIABLE", "Gateway ledger rows are unavailable for R6 correlation.", metrics);

  const traceSet = new Set(traceIds);
  const everyClaimedTraceRow = gatewayRows.filter((row) => isNonEmpty(row.trace_id) && traceSet.has(row.trace_id));
  const outsideWindow = everyClaimedTraceRow.filter((row) => row.ts < input.startedAt! || row.ts > input.finishedAt!);
  if (outsideWindow.length > 0) {
    return result(id, "FAIL", `A claimed ${kind} trace has ledger rows outside the immutable workload window.`, metrics,
      outsideWindow.map((row) => ({ id: row.id, traceId: row.trace_id, ts: row.ts, invariant: "entire_trace_within_workload_window" })));
  }
  const nonLiteRows = everyClaimedTraceRow.filter((row) => row.backend !== "litellm");
  if (nonLiteRows.length > 0) {
    return result(id, "FAIL", `A claimed ${kind} trace contains a non-LiteLLM writer row.`, metrics,
      nonLiteRows.map((row) => ({ id: row.id, traceId: row.trace_id, backend: row.backend, invariant: "litellm_workload_trace" })));
  }
  const observed = everyClaimedTraceRow
    .sort(compareRows);
  const correlatedMetrics = { ...metrics, ledgerRows: observed.length };
  const observedTraceIds = new Set(observed.map((row) => row.trace_id!));
  const missingTraceIds = traceIds.filter((traceId) => !observedTraceIds.has(traceId));
  if (missingTraceIds.length > 0) {
    return result(id, "FAIL", `The authorized ${kind} run claims trace IDs that do not correlate to its ledger window.`, correlatedMetrics,
      missingTraceIds.map((traceId) => ({ traceId, invariant: "trace_present_in_ledger_window" })));
  }
  const identityMismatches = observed.filter((row) => row.caller !== input.expectedCaller || row.tenant_id !== input.expectedTenant);
  if (identityMismatches.length > 0) {
    return result(id, "FAIL", `The correlated ${kind} ledger rows do not match the caller and tenant bound into the immutable receipt.`, correlatedMetrics,
      identityMismatches.map((row) => ({ id: row.id, caller: row.caller ?? null, tenantId: row.tenant_id ?? null })));
  }
  const aliases = buildRouteAliases(routes);
  const unmapped = observed.filter((row) => !isNonEmpty(row.resolved_model)
    || aliases.ambiguous.has(row.resolved_model)
    || !aliases.unique.has(row.resolved_model));
  if (unmapped.length > 0) {
    return result(id, "FAIL", `The correlated ${kind} run contains an ambiguous or unmapped LiteLLM route hop.`, correlatedMetrics,
      unmapped.map((row) => ({ id: row.id, resolvedModel: row.resolved_model, invariant: "exact_route_identity" })));
  }
  const traceEvidence: Array<Record<string, unknown>> = [];
  const allObservedHops: string[] = [];
  for (const trace of traces) {
    const rows = observed.filter((row) => row.trace_id === trace.traceId).sort(compareRows);
    const firstSuccess = rows.findIndex((row) => isSuccess(row.success));
    if (firstSuccess < 0) {
      return result(id, "FAIL", `At least one correlated ${kind} trace has no successful ledger hop.`, correlatedMetrics,
        [{ traceId: trace.traceId, invariant: "ledger_success" }]);
    }
    if (rows.length > firstSuccess + 1) {
      return result(id, "FAIL", `A correlated ${kind} trace contains rows after its first successful hop.`, correlatedMetrics, [{
        traceId: trace.traceId,
        firstSuccessId: rows[firstSuccess]!.id,
        trailingIds: rows.slice(firstSuccess + 1).map((row) => row.id),
        invariant: "no_rows_after_first_success",
      }]);
    }
    const observedHops = rows.map((row) => aliases.unique.get(row.resolved_model)!.logicalName);
    if (JSON.stringify(observedHops) !== JSON.stringify(trace.orderedHops)) {
      return result(id, "FAIL", `The claimed ${kind} hop order does not match the correlated ledger rows.`, correlatedMetrics, [{
        traceId: trace.traceId, invariant: "ordered_hops_match_ledger", claimed: trace.orderedHops, observed: observedHops,
      }]);
    }
    allObservedHops.push(...observedHops);
    traceEvidence.push({ traceId: trace.traceId, orderedHops: observedHops, ledgerRowIds: rows.map((row) => row.id) });
  }
  const usedHardDead = allObservedHops.filter((hop) => hardDead.has(hop));
  if (usedHardDead.length > 0) {
    return result(id, "FAIL", `The ${kind} run used an R2 hard-dead route.`, correlatedMetrics,
      [...new Set(usedHardDead)].map((logicalName) => ({ logicalName })));
  }
  return result(id, "PASS", `The bounded authorized ${kind} run is correlated to successful ordered ledger hops and validator evidence.`, correlatedMetrics, [{
    runId: input.id,
    evidenceRef: input.evidenceRef,
    validatorEvidenceRef: input.validatorEvidenceRef,
    traces: traceEvidence,
  }]);
}

function evaluateDisposition(
  id: "r4.disposition" | "r5.disposition",
  input: OperatorDisposition | undefined,
  generatedAt: number,
): CheckResult {
  if (!input) return result(id, "PENDING", "An explicit operator disposition is required.");
  if (!Number.isFinite(input.at) || input.at < R0_CUTOFF_MS || input.at > generatedAt) {
    return result(id, "FAIL", "The operator disposition has a stale, invalid, or future UTC timestamp.", { at: Number.isFinite(input.at) ? input.at : null });
  }
  const allowed = id === "r4.disposition" ? new Set(["recovered", "removed", "deferred"]) : new Set(["added", "declined", "deferred"]);
  if (!allowed.has(input.status)) return result(id, "FAIL", `Disposition ${input.status} is not valid for ${id}.`, { at: input.at, status: input.status });
  if (input.status === "deferred" && !isNonEmpty(input.reason)) return result(id, "FAIL", "A deferred disposition requires a reason.", { at: input.at, status: input.status });
  return result(id, "PASS", "An explicit timestamped operator disposition is recorded.", { at: input.at, status: input.status },
    input.reason ? [{ reason: input.reason }] : []);
}

export function verifyRepairArc(input: RepairArcInput): RepairArcReport {
  const checks: CheckResult[] = [];
  checks.push(...evaluateR0(input.gatewayRows, input.gatewayError, input.generatedAt));
  checks.push(evaluateEvidenceHistory(input.evidenceHistory));
  checks.push(evaluateR1(input.r1, input.generatedAt));
  const r2 = evaluateR2(input.r2, input.generatedAt);
  checks.push(...r2.checks);
  checks.push(evaluateR3(input.r3));
  checks.push(...evaluateValidation(input.validation, input.liveSurface?.candidateCommit, input.generatedAt));
  checks.push(evaluateLiveSurface(input.liveSurface));
  const hardDead = new Set(r2.hardDead);
  const routes = input.r2?.routes ?? [];
  const requiredAfter = Math.max(R0_CUTOFF_MS, input.r2?.baseline?.applyAt ?? R0_CUTOFF_MS);
  const editorialInput = input.realWork?.editorial;
  const builderInput = input.realWork?.builder;
  let editorialCheck = evaluateWorkRun("editorial", editorialInput, hardDead, input.gatewayRows, routes, input.generatedAt, requiredAfter, input.liveSurface?.candidateCommit);
  let builderCheck = evaluateWorkRun("builder", builderInput, hardDead, input.gatewayRows, routes, input.generatedAt, requiredAfter, input.liveSurface?.candidateCommit);
  if (editorialInput?.receiptVerified === true && builderInput?.receiptVerified === true) {
    const editorialTraces = (editorialInput.traces ?? []).map((entry) => entry.traceId);
    const builderTraces = (builderInput.traces ?? []).map((entry) => entry.traceId);
    const sharedTraces = editorialTraces.filter((traceId) => builderTraces.includes(traceId));
    const conflicts = [
      ...(isNonEmpty(editorialInput.id) && editorialInput.id === builderInput.id ? [{ invariant: "distinct_cross_kind_run_id", value: editorialInput.id }] : []),
      ...(isNonEmpty(editorialInput.authorizationId) && editorialInput.authorizationId === builderInput.authorizationId
        ? [{ invariant: "distinct_cross_kind_authorization", value: editorialInput.authorizationId }] : []),
      ...sharedTraces.map((traceId) => ({ invariant: "distinct_cross_kind_trace", value: traceId })),
      ...(isNonEmpty(editorialInput.validatorEvidenceRef) && editorialInput.validatorEvidenceRef === builderInput.validatorEvidenceRef
        ? [{ invariant: "distinct_cross_kind_validator_artifact", value: editorialInput.validatorEvidenceRef }] : []),
      ...(isSha256(editorialInput.validatorEvidenceSha256) && editorialInput.validatorEvidenceSha256 === builderInput.validatorEvidenceSha256
        ? [{ invariant: "distinct_cross_kind_validator_hash", value: editorialInput.validatorEvidenceSha256 }] : []),
    ];
    if (conflicts.length > 0) {
      editorialCheck = result("r6.editorial", "FAIL", "Editorial and builder acceptance evidence reuse the same workload identity.", editorialCheck.metrics, conflicts);
      builderCheck = result("r6.builder", "FAIL", "Editorial and builder acceptance evidence reuse the same workload identity.", builderCheck.metrics, conflicts);
    }
  }
  checks.push(editorialCheck, builderCheck);
  checks.push(evaluateDisposition("r4.disposition", input.r4Disposition, input.generatedAt));
  checks.push(evaluateDisposition("r5.disposition", input.r5Disposition, input.generatedAt));
  checks.push(evaluateAcceptanceLog(input.acceptanceLog, input.liveSurface?.candidateCommit, input.generatedAt));
  return { generatedAt: input.generatedAt, overall: overallFromChecks(checks), checks };
}

/** Remove secret-bearing keys and redact common inline credential forms. */
export function sanitizeForEvidence(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") {
    let output = value
      .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [REDACTED]")
      .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
      .replace(/([?&](?:api[_-]?key|token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
      .replace(/\b(?:api[_-]?key|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "credential=[REDACTED]");
    for (const secret of secrets) {
      if (secret.length > 0) output = output.split(secret).join("[REDACTED]");
    }
    return output;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeForEvidence(entry, secrets));
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) continue;
      clean[key] = sanitizeForEvidence(entry, secrets);
    }
    return clean;
  }
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

export function sanitizeError(error: unknown, secrets: readonly string[] = []): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return String(sanitizeForEvidence(message, secrets)).slice(0, 500);
}
