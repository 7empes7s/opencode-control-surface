import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  R0_CUTOFF_MS,
  R2_RATE_LIMIT_MIN_AGE_MS,
  analyzeR2,
  evaluateAcceptanceLog,
  evaluateR0,
  evaluateR1,
  evaluateR2,
  evaluateR3,
  evaluateLiveSurface,
  evaluateValidation,
  evaluateWorkRun,
  exitCodeForOverall,
  overallFromChecks,
  reconcileTombstone,
  sanitizeForEvidence,
  updateExact429Clock,
  validateModelsApi,
  verifyRepairArc,
  type CheckResult,
  type GatewayCallRow,
  type R1Input,
  type R1Observation,
  type R2Input,
  type ValidationObservation,
} from "./repairArcVerify.ts";
import {
  deriveR2Routes,
  collectValidationManifest,
  collectR2LiveMode,
  loadPriorEvidence,
  parseCliArgs,
  parseReprobeState,
  readOperatorInput,
  writeEvidenceSnapshot,
  type EvidenceEnvelope,
} from "../../scripts/verify-repair-arc.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function gatewayRow(overrides: Partial<GatewayCallRow> = {}): GatewayCallRow {
  return {
    id: 1,
    ts: R0_CUTOFF_MS,
    logical_model: "editorial-heavy",
    resolved_model: "provider/model-a",
    backend: "litellm",
    success: 1,
    latency_ms: 100,
    error_class: null,
    trace_id: "trace-1",
    caller: "test",
    tenant_id: "mimule",
    ...overrides,
  };
}

function getCheck(checks: CheckResult[], id: string): CheckResult {
  const check = checks.find((entry) => entry.id === id);
  if (!check) throw new Error(`missing check ${id}`);
  return check;
}

const requiredCheckIds = [
  "r0.trace_coverage", "r0.request_outcomes", "evidence.history", "r1.stability",
  "r2.reconciliation", "r2.exact_429", "r2.outcome_delta", "r3.api_contract",
  "classifier.contract", "validation.bounded", "r3.ui_contract", "fresh_host.api_only",
  "live.surface", "r6.editorial", "r6.builder", "r4.disposition", "r5.disposition", "acceptance.log",
] as const;

function allPassingRequiredChecks(): CheckResult[] {
  return requiredCheckIds.map((id) => ({ id, verdict: "PASS", note: "passed", metrics: {}, evidence: [] }));
}

function stableObservation(index: number, now: number): R1Observation {
  const stateTs = now - (4 - index) * 30 * 60 * 1_000;
  const scheduledAt = stateTs - 500;
  const receiptTokenId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
  return {
    stateTs,
    changed: false,
    pool: ["route-a", "route-b"],
    live: ["route-a"],
    limited: ["route-b"],
    dead: [],
    hang: [],
    timeout: [],
    history: {
      "route-a": { code: 200, category: "routable", streak: 3, since: Math.floor(stateTs / 1_000), latency: 100 },
      "route-b": { code: 429, category: "routable", streak: 3, since: Math.floor(stateTs / 1_000), latency: 120 },
    },
    priorPool: ["route-a", "route-b"],
    priorPoolSource: "prior-observation",
    invocationId: index.toString(16).padStart(32, "0"),
    invocationResult: "success",
    invocationStartedAt: stateTs - 500,
    invocationFinishedAt: stateTs + 500,
    timerTriggeredAt: scheduledAt,
    timerTriggerId: `model-fallback-reprobe.timer@${new Date(scheduledAt).toISOString()}`,
    serviceJobId: String(index),
    bootId: "11111111222233334444555555555555",
    receiptTokenId,
    triggerReceiptVerified: true,
    triggerReceiptPath: `/var/lib/mimule/model-fallback-reprobe.triggers/consumed/trigger-20260718T181700Z-${receiptTokenId}.json`,
    triggerReceiptSha256: index.toString(16).repeat(64),
    terminalReceiptVerified: true,
    terminalReceiptPath: `/var/lib/mimule/model-fallback-reprobe.receipts/terminal-20260718T181800Z-${receiptTokenId}.json`,
    terminalReceiptSha256: (index + 3).toString(16).repeat(64),
    execMainStatus: 0,
    invocationMode: "normal",
    stateSha256: (index + 6).toString(16).repeat(64),
    scheduled: true,
    restartCount24h: 1,
  };
}

function r1Input(observations: R1Observation[], overrides: Partial<R1Input> = {}): R1Input {
  return {
    journalAvailable: true,
    observations,
    receiptCoverage: {
      status: observations.length >= 3 ? "complete" : "incomplete",
      settledOpportunities: observations.length,
      coveredOpportunities: observations.length,
    },
    ...overrides,
  };
}

function r2Input(overrides: Partial<R2Input> = {}): R2Input {
  return {
    available: true,
    rows: [],
    recentCutoff: 1_000,
    classifierFixAt: 5_000,
    routes: [{ logicalName: "route-a", resolvedModel: "provider/model-a", eligible: true, eligibilityKnown: true }],
    pool: ["route-a"],
    managedChains: { editorial: ["route-a"] },
    managedChainsAvailable: true,
    mode: "shadow",
    ...overrides,
  };
}

function promotableEnvelope(generatedAt: number): EvidenceEnvelope {
  return {
    schemaVersion: 2,
    generatedAt,
    generatedAtUtc: new Date(generatedAt).toISOString(),
    sourceCommits: { controlSurface: "a".repeat(40), mimoun: "b".repeat(40) },
    sourceClean: { controlSurface: true, mimounReprobe: true },
    cutoffs: { r0Unified: R0_CUTOFF_MS },
    queryWindows: {
      r0: { from: R0_CUTOFF_MS, to: generatedAt },
      r2Recent: { from: generatedAt - 7 * 24 * 60 * 60 * 1_000, to: generatedAt },
      r1Restarts: { from: generatedAt - 24 * 60 * 60 * 1_000, to: generatedAt },
    },
    observations: { r1Current: stableObservation(3, generatedAt), r2Current: null, r1Failures: [] },
    report: { generatedAt, overall: "verified", checks: allPassingRequiredChecks() },
  };
}

function modelsPayload(models: Array<{ healthState: string; healthBucket: string; healthReason: string; logicalName?: string; resolvedModel?: string }>): unknown {
  const states = { live: 0, limited: 0, slow: 0, degraded: 0, dead: 0, hang: 0, unknown: 0 };
  const buckets = { healthy: 0, unhealthy: 0, unknown: 0 };
  const rows = models.map((model, index) => ({
    logicalName: model.logicalName ?? `route-${index}`,
    resolvedModel: model.resolvedModel ?? `provider/route-${index}`,
    ...model,
  }));
  for (const model of rows) {
    (states as Record<string, number>)[model.healthState] += 1;
    (buckets as Record<string, number>)[model.healthBucket] += 1;
  }
  return { data: { models: rows, summary: { healthStateSummary: states, healthBucketSummary: buckets } } };
}

function validationObservation(now: number, commit = "abcdef0123456789abcdef0123456789abcdef01"): ValidationObservation {
  return {
    recordedAt: now - 1_000,
    commit,
    manifestVerified: true,
    candidateTrackedClean: true,
    classifier: { sourceVerified: true, testsPassed: true, cases: 12, evidenceRef: "classifier-test-output" },
    bounded: {
      focusedTestsPassed: true,
      testFiles: 6,
      typecheckPassed: true,
      buildPassed: true,
      forbiddenProcessesSpawned: false,
      evidenceRef: "bounded-validation-output",
    },
    ui: { contractTestsPassed: true, assertions: 25, evidenceRef: "ui-test-output" },
    freshHost: {
      apiOnly: true,
      total: 145,
      honest: 145,
      leak: 0,
      crash: 0,
      error5xx: 0,
      commit,
      evidenceRef: "detached-worktree-report",
    },
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeImmutableTestFile(path: string, value: string): { path: string; sha256: string; bytes: number } {
  writeFileSync(path, value);
  chmodSync(path, 0o444);
  return { path, sha256: sha256(value), bytes: Buffer.byteLength(value) };
}

function validationBundle(options: { omitRoute?: boolean; reportCommit?: string } = {}) {
  const receiptRoot = mkdtempSync(join(tmpdir(), "repair-validation-receipts-"));
  temporaryDirectories.push(receiptRoot);
  const sourceRoot = mkdtempSync(join(tmpdir(), "repair-validation-source-"));
  temporaryDirectories.push(sourceRoot);
  const commit = "a".repeat(40);
  const tree = "b".repeat(40);
  const runId = options.omitRoute
    ? "10000000-0000-4000-8000-000000000002"
    : "10000000-0000-4000-8000-000000000001";
  const startedAt = Date.UTC(2026, 6, 18, 16, 0, 0);
  const routerPath = join(sourceRoot, "api-router.ts");
  const classifierPath = join(sourceRoot, "gateway-router.ts");
  writeFileSync(routerPath, [
    'if (method === "GET" && pathname === "/api/health") {}',
    'if (method === "GET" && pathname === "/api/stream") {}',
  ].join("\n"));
  writeFileSync(classifierPath, 'if (/^litellm 5\\d\\d:/.test(msg)) return "server_error";\n');
  const commandTimes = {
    focused: [startedAt, startedAt + 1_000],
    typecheck: [startedAt + 1_000, startedAt + 2_000],
    build: [startedAt + 2_000, startedAt + 3_000],
    freshHost: [startedAt + 3_000, startedAt + 4_000],
  } as const;
  const logs = Object.fromEntries((["focused", "typecheck", "build", "freshHost"] as const).map((key) => [
    key,
    writeImmutableTestFile(join(receiptRoot, `validation-${commit}-${runId}-${key}.log`), `${key} passed\n`),
  ])) as Record<"focused" | "typecheck" | "build" | "freshHost", { path: string; sha256: string; bytes: number }>;
  const results = [
    { route: "/", status: 200, verdict: "HONEST", elapsedMs: 1, detail: "len=1" },
    ...(!options.omitRoute ? [{ route: "/api/health", status: 200, verdict: "HONEST", elapsedMs: 2, detail: "" }] : []),
  ];
  const freshReport = JSON.stringify({
    schemaVersion: 2,
    kind: "fresh-host-api-report",
    runId,
    candidateCommit: options.reportCommit ?? commit,
    candidateTree: tree,
    generatedAt: startedAt + 3_500,
    counts: { HONEST: results.length, LEAK: 0, CRASH: 0, "ERROR-5xx": 0 },
    results,
  });
  const report = writeImmutableTestFile(join(receiptRoot, `fresh-host-${commit}-${runId}.json`), freshReport);
  const commands = {
    focused: {
      startedAt: commandTimes.focused[0], finishedAt: commandTimes.focused[1],
      argv: ["bun", "test", "server/gateway/router.test.ts", "server/api/modelHealthState.test.ts", "server/api/models.test.ts", "server/api/router.test.ts", "server/api/repairArcVerify.test.ts", "app/routes/modelsHealthView.test.ts", "--timeout=60000", "--max-concurrency=4", "--reporter=dots"],
      env: { DASHBOARD_DB: "1" }, exitCode: 0, output: logs.focused,
    },
    typecheck: { startedAt: commandTimes.typecheck[0], finishedAt: commandTimes.typecheck[1], argv: ["bun", "run", "typecheck"], env: {}, exitCode: 0, output: logs.typecheck },
    build: { startedAt: commandTimes.build[0], finishedAt: commandTimes.build[1], argv: ["bun", "run", "build"], env: {}, exitCode: 0, output: logs.build },
    freshHost: {
      startedAt: commandTimes.freshHost[0], finishedAt: commandTimes.freshHost[1], argv: ["e2e/fresh-host/run.sh"], env: {}, exitCode: 0,
      output: logs.freshHost,
      source: { head: commit, tree, detached: true, cleanBefore: true },
      report,
    },
  };
  const manifestValue = JSON.stringify({
    schemaVersion: 2,
    kind: "spec45-validation",
    runId,
    candidateCommit: commit,
    candidateTree: tree,
    recordedAt: startedAt + 4_100,
    commands,
  });
  const manifest = writeImmutableTestFile(join(receiptRoot, `validation-${commit}-${runId}.json`), manifestValue);
  return { receiptRoot, sourceRoot, routerPath, classifierPath, commit, tree, now: startedAt + 5_000, manifest };
}

test("R0 uses the exact unified cutoff and empty post-cutoff data is pending without NaN", () => {
  const before = gatewayRow({ id: 1, ts: R0_CUTOFF_MS - 1 });
  const checks = evaluateR0([before]);
  expect(getCheck(checks, "r0.trace_coverage").verdict).toBe("PENDING");
  const request = getCheck(checks, "r0.request_outcomes");
  expect(request.verdict).toBe("PENDING");
  expect(request.metrics.requestSuccessRatePct).toBeNull();
  expect(JSON.stringify(checks)).not.toContain("NaN");

  const atCutoff = evaluateR0([gatewayRow({ ts: R0_CUTOFF_MS })]);
  expect(getCheck(atCutoff, "r0.trace_coverage").metrics.postCutoffRows).toBe(1);
});

test("R0 requires 100% writer identifier coverage and checks cli-direct tenant separately", () => {
  const checks = evaluateR0([
    gatewayRow({ id: 1, trace_id: "" }),
    gatewayRow({ id: 2, backend: "cli-direct", trace_id: "direct", tenant_id: null }),
  ]);
  const trace = getCheck(checks, "r0.trace_coverage");
  expect(trace.verdict).toBe("FAIL");
  expect(trace.evidence).toContainEqual({ writer: "litellm", id: 1, missing: "trace_id" });
  expect(trace.evidence).toContainEqual({ writer: "cli-direct", id: 2, missing: "tenant_id" });
});

test("R0 orders by timestamp/id and computes cumulative latency and model waste through first success", () => {
  const rows: GatewayCallRow[] = [];
  for (let trace = 0; trace < 5; trace += 1) {
    rows.push(gatewayRow({ id: trace * 10 + 2, ts: R0_CUTOFF_MS + trace, trace_id: `trace-${trace}`, caller: "insights-ai", success: 1, latency_ms: 30 }));
    rows.push(gatewayRow({ id: trace * 10 + 1, ts: R0_CUTOFF_MS + trace, trace_id: `trace-${trace}`, caller: "insights-ai", success: 0, latency_ms: 20, error_class: trace === 0 ? "gateway_unreachable" : "timeout" }));
    rows.push(gatewayRow({ id: trace * 10 + 3, backend: "cli-direct", trace_id: `direct-${trace}`, tenant_id: "mimule", success: 1 }));
  }
  const check = getCheck(evaluateR0(rows), "r0.request_outcomes");
  expect(check.verdict).toBe("PASS");
  expect(check.metrics.requests).toBe(5);
  expect(check.metrics.successfulRequests).toBe(5);
  expect(check.metrics.wastedAttempts).toBe(4);
  expect(check.evidence.find((entry) => entry.traceId === "trace-0")?.timeToFirstSuccessMs).toBe(50);
});

test("R0 treats a row after first success as a consistency failure", () => {
  const rows = [
    gatewayRow({ id: 1, success: 1 }),
    gatewayRow({ id: 2, success: 0, error_class: "timeout" }),
  ];
  const check = getCheck(evaluateR0(rows), "r0.request_outcomes");
  expect(check.verdict).toBe("FAIL");
  expect(check.metrics.postSuccessViolations).toBe(1);
});

test("R0 does not let unrelated writers or synthetic/demo traces prove natural coverage", () => {
  const unrelated = gatewayRow({ backend: "openai" });
  expect(getCheck(evaluateR0([unrelated]), "r0.trace_coverage").verdict).toBe("PENDING");

  const synthetic: GatewayCallRow[] = [];
  for (let trace = 0; trace < 5; trace += 1) {
    synthetic.push(gatewayRow({ id: trace * 10, trace_id: `demo-${trace}`, caller: "synthetic-test", tenant_id: "demo", success: 0, error_class: "timeout" }));
    synthetic.push(gatewayRow({ id: trace * 10 + 1, trace_id: `demo-${trace}`, caller: "synthetic-test", tenant_id: "demo", success: 1 }));
  }
  const request = getCheck(evaluateR0(synthetic), "r0.request_outcomes");
  expect(request.verdict).toBe("PENDING");
  expect(request.metrics.naturalMultiHopRequests).toBe(0);

  const syntheticTraceOnly = Array.from({ length: 5 }, (_, index) => [
    gatewayRow({ id: 100 + index * 2, trace_id: `synthetic-spec-${index}`, caller: "insights-ai", tenant_id: "mimule", success: 0, error_class: "timeout" }),
    gatewayRow({ id: 101 + index * 2, trace_id: `synthetic-spec-${index}`, caller: "insights-ai", tenant_id: "mimule", success: 1 }),
  ]).flat();
  expect(getCheck(evaluateR0(syntheticTraceOnly), "r0.request_outcomes").verdict).toBe("PENDING");
});

test("R1 needs three distinct scheduled samples and passes three stable fresh cycles", () => {
  const now = 2_000_000_000_000;
  expect(evaluateR1(r1Input([stableObservation(1, now), stableObservation(2, now)]), now).verdict).toBe("PENDING");
  const passed = evaluateR1(r1Input([1, 2, 3].map((index) => stableObservation(index, now))), now);
  expect(passed.verdict).toBe("PASS");
  expect(passed.metrics.successfulScheduledCycles).toBe(3);
});

test("R1 keeps evaluating the latest three after a fourth fully covered opportunity", () => {
  const now = 2_000_000_000_000;
  const observations = [1, 2, 3, 4].map((index) => stableObservation(index, now));
  const passed = evaluateR1(r1Input(observations), now + 1_000);
  expect(passed.verdict).toBe("PASS");
  expect(passed.metrics.successfulScheduledCycles).toBe(4);
  expect(passed.evidence.map((entry) => entry.invocationId)).toEqual(observations.slice(-3).map((entry) => entry.invocationId));
});

test("R1 cannot infer scheduled origin from journal proximity without complete unit-boundary receipts", () => {
  const now = 2_000_000_000_000;
  const observations = [1, 2, 3].map((index) => stableObservation(index, now));
  const unavailable = evaluateR1(r1Input(observations, {
    receiptCoverage: { status: "unavailable", settledOpportunities: 3, coveredOpportunities: 0 },
  }), now);
  expect(unavailable.verdict).toBe("PENDING");
  expect(unavailable.note).toContain("not installed");

  delete observations[2]!.terminalReceiptVerified;
  const omittedTerminal = evaluateR1(r1Input(observations, {
    receiptCoverage: {
      status: "incomplete",
      settledOpportunities: 3,
      coveredOpportunities: 2,
      missingOpportunityIds: [observations[2]!.timerTriggerId!],
    },
  }), now);
  expect(omittedTerminal.verdict).toBe("PENDING");
  expect(omittedTerminal.metrics.coveredOpportunities).toBe(2);
});

test("R1 never lets malformed coverage mask a proven restart-target violation", () => {
  const now = 2_000_000_000_000;
  for (const receiptCoverage of [
    { status: "complete" as const, settledOpportunities: 2, coveredOpportunities: 3 },
    { status: "complete" as const, settledOpportunities: 3, coveredOpportunities: 3 },
  ]) {
    const check = evaluateR1({ journalAvailable: true, observations: [], rollingRestartCount24h: 2, receiptCoverage }, now);
    expect(check.verdict).toBe("FAIL");
    expect(check.evidence).toContainEqual({ invariant: "restart_target", restartCount24h: 2 });
  }
});

test("R1 reports absent journal as unverifiable and proven failures as fail", () => {
  const now = 2_000_000_000_000;
  expect(evaluateR1({ journalAvailable: false, observations: [], error: "permission denied" }, now).verdict).toBe("UNVERIFIABLE");
  const failed = stableObservation(1, now);
  failed.invocationResult = "failed";
  expect(evaluateR1(r1Input([failed]), now).verdict).toBe("FAIL");

  const stale = [1, 2, 3].map((index) => stableObservation(index, now - 10 * 60 * 60 * 1_000));
  expect(evaluateR1(r1Input(stale), now).verdict).toBe("FAIL");

  const future = [1, 2, 3].map((index) => stableObservation(index, now + 4 * 60 * 60 * 1_000));
  expect(evaluateR1(r1Input(future), now).verdict).toBe("FAIL");

  const failureReceipt = {
    serviceJobId: "99",
    invocationId: "f".repeat(32),
    bootId: "e".repeat(32),
    opportunityId: `model-fallback-reprobe.timer@${new Date(now - 3_000).toISOString()}`,
    receiptTokenId: "10000000-0000-4000-8000-000000000099",
    triggerReceiptPath: "/var/lib/mimule/model-fallback-reprobe.triggers/consumed/trigger-20330518T033317Z-10000000-0000-4000-8000-000000000099.json",
    triggerReceiptSha256: "a".repeat(64),
    terminalReceiptPath: "/var/lib/mimule/model-fallback-reprobe.receipts/terminal-20330518T033319Z-10000000-0000-4000-8000-000000000099.json",
    terminalReceiptSha256: "b".repeat(64),
    receiptVerified: true,
    startedAt: now - 2_000,
    finishedAt: now - 1_000,
    result: "failed" as const,
    execMainStatus: 1,
  };
  const receiptFailure = evaluateR1({
    journalAvailable: true,
    observations: [],
    acceptanceStartAt: now - 10_000,
    failures: [failureReceipt],
  }, now);
  expect(receiptFailure.verdict).toBe("FAIL");
  expect(evaluateR1({
    journalAvailable: false,
    observations: [],
    failures: [failureReceipt],
    acceptanceStartAt: now - 10_000,
    error: "current journal read failed",
  }, now).verdict).toBe("FAIL");
  const mixedReceipts = evaluateR1({
    journalAvailable: true,
    observations: [],
    acceptanceStartAt: now - 10_000,
    failures: [{ ...failureReceipt, receiptVerified: false }, failureReceipt],
  }, now);
  expect(mixedReceipts.verdict).toBe("FAIL");
  expect(mixedReceipts.metrics.malformedFailureReceipts).toBe(1);
});

test("R1 requires three distinct advancing timer triggers and systemd jobs", () => {
  const now = 2_000_000_000_000;
  const samples = [1, 2, 3].map((index) => stableObservation(index, now));
  for (const sample of samples) {
    sample.timerTriggeredAt = samples[0]!.timerTriggeredAt;
    sample.timerTriggerId = samples[0]!.timerTriggerId;
  }
  const check = evaluateR1(r1Input(samples), now);
  expect(check.verdict).toBe("FAIL");
  expect(check.evidence.some((entry) => entry.invariant === "distinct_advancing_timer_triggers_and_jobs")).toBeTrue();
});

test("R1 accepts transient 500 pool members but binds exact display buckets to history", () => {
  const now = 2_000_000_000_000;
  const transient = [1, 2, 3].map((index) => {
    const sample = stableObservation(index, now);
    sample.pool.push("route-transient");
    sample.history["route-transient"] = { code: 500, category: "routable", streak: 3, since: Math.floor(sample.stateTs / 1_000), latency: 80 };
    sample.priorPool!.push("route-transient");
    return sample;
  });
  expect(evaluateR1(r1Input(transient), now).verdict).toBe("PASS");

  transient[2]!.live.push("route-b");
  const mismatch = evaluateR1(r1Input(transient), now);
  expect(mismatch.verdict).toBe("FAIL");
  expect(mismatch.evidence.some((entry) => entry.invariant === "state_bucket_matches_history")).toBeTrue();
});

test("R1 fails changed state, excessive restarts, and timeout/promotion invariant breaches", () => {
  const now = 2_000_000_000_000;
  const samples = [1, 2, 3].map((index) => stableObservation(index, now));
  samples[2]!.changed = true;
  samples[2]!.history = {
    "route-a": { code: 408, category: "timeout", streak: 3, since: Math.floor(samples[2]!.stateTs / 1_000), latency: 20_000 },
    "route-c": { code: 200, category: "routable", streak: 2, since: Math.floor(samples[2]!.stateTs / 1_000), latency: 100 },
  };
  samples[2]!.pool = ["route-a", "route-b", "route-c"];
  samples[2]!.priorPool = ["route-a", "route-b"];
  const check = evaluateR1(r1Input(samples), now);
  expect(check.verdict).toBe("FAIL");
  expect(check.evidence.some((entry) => entry.invariant === "timeout_prune")).toBeTrue();
  expect(check.evidence.some((entry) => entry.invariant === "promotion_hysteresis")).toBeTrue();
  const restart = evaluateR1({ ...r1Input(samples), rollingRestartCount24h: 2 }, now);
  expect(restart.verdict).toBe("FAIL");
  expect(restart.evidence).toContainEqual({ invariant: "restart_target", restartCount24h: 2 });
});

test("R1 cannot pass hysteresis without trustworthy pre-cycle pools or invocation bounds", () => {
  const now = 2_000_000_000_000;
  const samples = [1, 2, 3].map((index) => stableObservation(index, now));
  delete samples[0]!.priorPool;
  expect(evaluateR1(r1Input(samples), now).verdict).toBe("PENDING");
  samples[0]!.priorPool = ["route-a", "route-b"];
  delete samples[1]!.invocationFinishedAt;
  expect(evaluateR1(r1Input(samples), now).verdict).toBe("PENDING");
});

test("R1 treats unrelated malformed history as incomplete but rejects a malformed held pool route", () => {
  const now = 2_000_000_000_000;
  const unrelated = [1, 2, 3].map((index) => ({
    ...stableObservation(index, now),
    malformedHistoryModels: ["route-unrelated"],
  }));
  const incomplete = evaluateR1(r1Input(unrelated), now);
  expect(incomplete.verdict).toBe("PENDING");
  expect(incomplete.evidence.some((entry) => entry.invariant === "validated_history_required")).toBeTrue();

  const held = [1, 2, 3].map((index) => {
    const sample = stableObservation(index, now);
    delete sample.history["route-b"];
    sample.malformedHistoryModels = ["route-b"];
    return sample;
  });
  const rejected = evaluateR1(r1Input(held), now);
  expect(rejected.verdict).toBe("FAIL");
  expect(rejected.evidence.some((entry) => entry.invariant === "malformed_history_no_hold")).toBeTrue();
});

test("R1 directly rejects unstable pool order and unstable state distribution", () => {
  const now = 2_000_000_000_000;
  const reorderedPool = [1, 2, 3].map((index) => stableObservation(index, now));
  reorderedPool[2]!.pool = ["route-b", "route-a"];
  const poolCheck = evaluateR1(r1Input(reorderedPool), now);
  expect(poolCheck.verdict).toBe("FAIL");
  expect(poolCheck.evidence.some((entry) => entry.invariant === "stable_pool")).toBeTrue();

  const redistributed = [1, 2, 3].map((index) => stableObservation(index, now));
  redistributed[2]!.live = ["route-b"];
  redistributed[2]!.limited = ["route-a"];
  redistributed[2]!.history["route-a"] = {
    ...redistributed[2]!.history["route-a"]!,
    code: 429,
  };
  redistributed[2]!.history["route-b"] = {
    ...redistributed[2]!.history["route-b"]!,
    code: 200,
  };
  const distributionCheck = evaluateR1(r1Input(redistributed), now);
  expect(distributionCheck.verdict).toBe("FAIL");
  expect(distributionCheck.evidence.some((entry) => entry.invariant === "stable_distribution")).toBeTrue();
});

test("R2 trusted cohort excludes direct, infra, legacy unknown, server-error, and demo rows", () => {
  const rows = [
    gatewayRow({ id: 1, ts: 2_000, backend: "cli-direct", success: 0, error_class: "auth" }),
    gatewayRow({ id: 2, ts: 2_000, success: 0, error_class: "gateway_unreachable" }),
    gatewayRow({ id: 3, ts: 2_000, success: 0, error_class: "unknown" }),
    gatewayRow({ id: 4, ts: 2_000, success: 0, error_class: "server_error" }),
    gatewayRow({ id: 5, ts: 2_000, success: 0, error_class: "auth", tenant_id: "demo" }),
  ];
  const analysis = analyzeR2(r2Input({ rows }));
  expect(analysis.trustedRows).toBe(0);
  expect(analysis.excluded).toMatchObject({ cliDirect: 1, gatewayUnreachable: 1, legacyUnknown: 1, serverErrorPreFix: 1, nonMimuleTenant: 1 });
});

test("R2 resolves ledger aliases and honors n=19/n=20 hard-dead boundary", () => {
  const nineteen = Array.from({ length: 19 }, (_, index) => gatewayRow({ id: index, ts: 2_000 + index, success: 0, error_class: "auth" }));
  expect(analyzeR2(r2Input({ rows: nineteen })).hardDead).toEqual([]);
  const twenty = [...nineteen, gatewayRow({ id: 20, ts: 3_000, success: 0, error_class: "auth" })];
  expect(analyzeR2(r2Input({ rows: twenty })).hardDead).toEqual(["route-a"]);
});

test("R2 maps every exact model alias and refuses aliases claimed by multiple routes", () => {
  const failures = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, success: 0, error_class: "auth" }));
  const precedence = r2Input({
    rows: failures.map((row) => ({ ...row, resolved_model: "secondary/model" })),
    routes: [{ logicalName: "route-a", resolvedModel: "primary/model", modelId: "secondary/model", eligible: true, eligibilityKnown: true }],
  });
  const mappedSecondary = analyzeR2(precedence);
  expect(mappedSecondary.hardDead).toEqual(["route-a"]);
  expect(mappedSecondary.excluded.unmappedRoute).toBe(0);

  const ambiguous = r2Input({
    rows: failures.map((row) => ({ ...row, resolved_model: "shared/model" })),
    routes: [
      { logicalName: "route-a", resolvedModel: "shared/model", eligible: true, eligibilityKnown: true },
      { logicalName: "route-b", resolvedModel: "shared/model", eligible: true, eligibilityKnown: true },
    ],
  });
  expect(analyzeR2(ambiguous).excluded.ambiguousRoute).toBe(20);
  expect(getCheck(evaluateR2(ambiguous).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
});

test("R2 treats every reprobe-history route as eligible even after it leaves the pool", () => {
  const now = 2_000_000_000_000;
  const reprobe = stableObservation(3, now);
  reprobe.pool = ["route-a"];
  reprobe.history = {
    "route-a": { code: 200, category: "routable", streak: 3, since: now, latency: 100 },
    "route-pruned": { code: 410, category: "dead", streak: 1, since: now, latency: 100 },
  };
  const routes = deriveR2Routes([
    { logicalName: "route-a", resolvedModel: "provider/a" },
    { logicalName: "route-pruned", modelId: "provider/pruned" },
    { logicalName: "local-special", modelId: "provider/local" },
  ], reprobe);
  expect(routes.find((route) => route.logicalName === "route-pruned")).toMatchObject({ eligible: true, eligibilityKnown: true });
  expect(routes.find((route) => route.logicalName === "local-special")).toMatchObject({ eligible: false, eligibilityKnown: true });
});

test("R2 trusts the SPEC45 non-cli-direct null-tenant cohort", () => {
  const rows = Array.from({ length: 20 }, (_, index) => gatewayRow({
    id: index,
    backend: "legacy-litellm-writer",
    tenant_id: null,
    success: 0,
    error_class: "auth",
  }));
  expect(analyzeR2(r2Input({ rows })).hardDead).toEqual(["route-a"]);
});

test("R2 keeps mapped rows pending when authoritative eligibility is unknown", () => {
  const rows = Array.from({ length: 20 }, (_, index) => gatewayRow({
    id: index,
    success: 0,
    error_class: "auth",
  }));
  const input = r2Input({
    rows,
    routes: [{ logicalName: "route-a", resolvedModel: "provider/model-a", eligible: true }],
  });
  const analysis = analyzeR2(input);
  expect(analysis.excluded.unknownEligibility).toBe(20);
  expect(getCheck(evaluateR2(input).checks, "r2.reconciliation").verdict).toBe("PENDING");
});

test("R2 earned shield quarantines credential failures instead of erasing a proven route", () => {
  const oldSuccesses = Array.from({ length: 50 }, (_, index) => gatewayRow({ id: index, ts: 500 + index, success: 1 }));
  const recentAuth = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: 100 + index, ts: 2_000 + index, success: 0, error_class: "auth" }));
  const analysis = analyzeR2(r2Input({ rows: [...oldSuccesses, ...recentAuth] }));
  expect(analysis.hardDead).toEqual([]);
  expect(analysis.wouldQuarantine).toEqual(["route-a"]);
});

test("R2 fails closed when live or captured shadow evidence asserts enforcement", () => {
  const generatedAt = 2_000_000_000_000;
  for (const liveModeEvidence of [
    { status: "verified" as const, policyVersion: 1, mode: "shadow", enforced: true, asOf: generatedAt - 1 },
    { status: "verified" as const, policyVersion: 1, mode: "enforce-prune", enforced: false, asOf: generatedAt - 1 },
    { status: "verified" as const, policyVersion: 1, mode: "unexpected-mode", enforced: false, asOf: generatedAt - 1 },
  ]) {
    const check = getCheck(evaluateR2(r2Input({ available: false, liveModeEvidence }), generatedAt).checks, "r2.reconciliation");
    expect(check.verdict).toBe("FAIL");
    expect(check.evidence[0]).toMatchObject({ invariant: "planning_slice_remains_shadow" });
  }
  const observation = {
    invocationId: "f".repeat(32), scheduled: true, success: true, enforced: true,
    wouldPrune: [], wouldQuarantine: [],
  };
  expect(getCheck(evaluateR2(r2Input({ shadowObservations: [observation] }), generatedAt).checks, "r2.reconciliation").verdict).toBe("FAIL");
  expect(getCheck(evaluateR2(r2Input({ liveModeEvidence: { status: "missing" } }), generatedAt).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  expect(getCheck(evaluateR2(r2Input({
    liveModeEvidence: { status: "verified", policyVersion: 1, mode: "shadow", enforced: false, asOf: generatedAt - 1 },
  }), generatedAt).checks, "r2.reconciliation").verdict).toBe("PENDING");
});

test("R2 rate-limit-only requires 48 hours and mixed throttling stays non-destructive", () => {
  const short = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, ts: 2_000 + index * 1_000, success: 0, error_class: "rate_limit" }));
  expect(analyzeR2(r2Input({ rows: short })).hardDead).toEqual([]);
  const aged = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, ts: 2_000 + index * (R2_RATE_LIMIT_MIN_AGE_MS / 19), success: 0, error_class: "rate_limit" }));
  expect(analyzeR2(r2Input({ rows: aged })).hardDead).toEqual(["route-a"]);
  aged[0] = gatewayRow({ id: 0, ts: 2_000, success: 0, error_class: "auth" });
  expect(analyzeR2(r2Input({ rows: aged })).hardDead).toEqual([]);
});

test("R2 shadow remains pending after three agreeing cycles and fails if either routing layer changes", () => {
  const rows = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, ts: 2_000 + index, success: 0, error_class: "auth" }));
  const observations = [1, 2, 3].map((index) => ({
    invocationId: `cycle-${index}`,
    stateTs: 10_000 * index,
    decisionAt: 10_000 * index,
    policyVersion: 1,
    ledgerAvailable: true,
    enforced: false,
    scheduled: true,
    success: true,
    wouldPrune: ["route-a"],
    wouldQuarantine: [],
    litellmBeforeHash: "same",
    litellmAfterHash: "same",
    gatewayBeforeHash: "same",
    gatewayAfterHash: "same",
  }));
  const stable = getCheck(evaluateR2(r2Input({ rows, shadowObservations: observations })).checks, "r2.reconciliation");
  expect(stable.verdict).toBe("PENDING");
  expect(stable.metrics.stableShadowSet).toBeTrue();
  expect(stable.evidence[0]).toMatchObject({ enforced: false, would_prune: ["route-a"] });

  observations[2]!.gatewayAfterHash = "mutated";
  expect(getCheck(evaluateR2(r2Input({ rows, shadowObservations: observations })).checks, "r2.reconciliation").verdict).toBe("FAIL");

  const ambiguousRows = rows.map((row) => ({ ...row, resolved_model: "shared/model" }));
  const ambiguousRoutes = [
    { logicalName: "route-a", resolvedModel: "shared/model", eligible: true, eligibilityKnown: true },
    { logicalName: "route-b", resolvedModel: "shared/model", eligible: true, eligibilityKnown: true },
  ];
  const mutationOutranksAmbiguity = getCheck(evaluateR2(r2Input({
    rows: ambiguousRows,
    routes: ambiguousRoutes,
    shadowObservations: observations,
  })).checks, "r2.reconciliation");
  expect(mutationOutranksAmbiguity.verdict).toBe("FAIL");
  expect(mutationOutranksAmbiguity.evidence.some((entry) => entry.invariant === "shadow_is_read_only")).toBeTrue();
});

test("R2 shadow requires three distinct scheduled invocation IDs", () => {
  const rows = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, success: 0, error_class: "auth" }));
  const repeated = Array.from({ length: 3 }, () => ({
    invocationId: "same-cycle",
    stateTs: 10_000,
    decisionAt: 10_000,
    policyVersion: 1,
    ledgerAvailable: true,
    enforced: false,
    scheduled: true,
    success: true,
    wouldPrune: ["route-a"],
    wouldQuarantine: [],
    litellmChanged: false,
    gatewayChanged: false,
  }));
  const check = getCheck(evaluateR2(r2Input({ rows, shadowObservations: repeated })).checks, "r2.reconciliation");
  expect(check.verdict).toBe("PENDING");
  expect(check.metrics.shadowCycles).toBe(1);
});

test("R2 has pending truth when no eligible ledger evidence exists", () => {
  const check = getCheck(evaluateR2(r2Input()).checks, "r2.reconciliation");
  expect(check.verdict).toBe("PENDING");
  expect(check.metrics.eligibleTrustedRows).toBe(0);
});

test("durable tombstone survives evidence aging and transient ledger loss until explicit recovery", () => {
  const previous = { logicalName: "route-a", active: true, reason: "hard dead" };
  expect(reconcileTombstone({ logicalName: "route-a", previous, ledgerAvailable: false, destructiveEvidencePresent: false, recoverySatisfied: false })).toEqual(previous);
  expect(reconcileTombstone({ logicalName: "route-a", previous, ledgerAvailable: true, destructiveEvidencePresent: false, recoverySatisfied: false })).toEqual(previous);
  expect(reconcileTombstone({ logicalName: "route-a", previous, ledgerAvailable: true, destructiveEvidencePresent: false, recoverySatisfied: true })).toEqual(previous);
  expect(reconcileTombstone({ logicalName: "route-a", previous, ledgerAvailable: true, destructiveEvidencePresent: false, recoverySatisfied: true, recoveryEvidence: "three clean probes" })).toMatchObject({ active: false, recoveryEvidence: "three clean probes" });
  expect(reconcileTombstone({ logicalName: "route-a", previous, ledgerAvailable: true, destructiveEvidencePresent: true, recoverySatisfied: true, recoveryEvidence: "three probes but ledger still says dead" })).toEqual(previous);
});

test("exact 429 clock is independent of category timing and resets on 200", () => {
  const first = updateExact429Clock({ previous: null, logicalName: "route-a", observedAt: 1_000, code: 429 });
  const continued = updateExact429Clock({ previous: first, logicalName: "route-a", observedAt: 2_000, code: 429 });
  expect(continued.first429At).toBe(1_000);
  const reset = updateExact429Clock({ previous: continued, logicalName: "route-a", observedAt: 3_000, code: 200 });
  expect(reset).toMatchObject({ first429At: null, last429At: null, currentCode: 200, resetAt: 3_000 });
  expect(getCheck(evaluateR2(r2Input()).checks, "r2.exact_429").verdict).toBe("PENDING");
});

test("exact 429 refuses unavailable chains, normalized clock reversal, and mixed-policy pruning", () => {
  const recent = Array.from({ length: 20 }, (_, index) => gatewayRow({
    id: index,
    ts: 2_000 + index * (R2_RATE_LIMIT_MIN_AGE_MS / 19),
    success: 0,
    error_class: index === 0 ? "auth" : "rate_limit",
  }));
  const pruned = getCheck(evaluateR2(r2Input({
    rows: recent,
    managedChains: { editorial: ["other-route", "route-a"] },
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{
      logicalName: "route-a",
      first429At: recent[1]!.ts,
      last429At: recent.at(-1)!.ts,
      currentCode: 429,
      resetAt: null,
      action: "pruned",
    }],
  })).checks, "r2.exact_429");
  expect(pruned.verdict).toBe("FAIL");
  expect(pruned.evidence.some((entry) => entry.invariant === "mixed_429_policy_non_destructive")).toBeTrue();
  expect(pruned.evidence.some((entry) => entry.invariant === "pruned_429_absent_from_all_managed_chains")).toBeTrue();

  const unavailable = getCheck(evaluateR2(r2Input({
    rows: recent,
    managedChainsAvailable: false,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: 2_000, last429At: 2_000, currentCode: 429, resetAt: null, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(unavailable.verdict).toBe("UNVERIFIABLE");

  const reversed = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: 2_000_000_000, last429At: 1_900_000_000_000, currentCode: 429, resetAt: null, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(reversed.verdict).toBe("FAIL");
  expect(reversed.evidence.some((entry) => entry.invariant === "ordered_429_clock")).toBeTrue();
});

test("R2 exact-429 gate rejects dummy clocks and requires coverage for every recent route", () => {
  const recent = [
    gatewayRow({ id: 1, ts: 2_000, success: 0, error_class: "rate_limit" }),
    gatewayRow({ id: 2, ts: 3_000, success: 1, error_class: null }),
  ];
  const dummy = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: null, last429At: null, currentCode: null }],
  })).checks, "r2.exact_429");
  expect(dummy.verdict).toBe("FAIL");

  const validReset = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: null, last429At: null, currentCode: 200, resetAt: 4_000, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(validReset.verdict).toBe("PASS");

  const malformedReset = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: null, last429At: 3_000, currentCode: 200, resetAt: 4_000, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(malformedReset.verdict).toBe("FAIL");

  const staleReset = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: null, last429At: null, currentCode: 200, resetAt: 1_500, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(staleReset.verdict).toBe("FAIL");

  const stillLimitedAtHead = getCheck(evaluateR2(r2Input({
    rows: recent,
    exact429StateVerified: true,
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    exact429Clocks: [{ logicalName: "route-a", first429At: 2_000, last429At: 2_000, currentCode: 429, resetAt: null, action: "limited" }],
  })).checks, "r2.exact_429");
  expect(stillLimitedAtHead.verdict).toBe("FAIL");
});

test("R2 enforced mode stays unverifiable while SPEC 46 is planning-only and preserves active tombstones", () => {
  const rows = Array.from({ length: 20 }, (_, index) => gatewayRow({ id: index, ts: 2_000 + index, success: 0, error_class: "auth" }));
  const shadowObservations = [1, 2, 3].map((index) => ({
    invocationId: `cycle-${index}`,
    stateTs: 10_000 * index,
    decisionAt: 10_000 * index,
    policyVersion: 1,
    ledgerAvailable: true,
    enforced: false,
    scheduled: true,
    success: true,
    wouldPrune: ["route-a"],
    wouldQuarantine: [],
    litellmChanged: false,
    gatewayChanged: false,
    litellmAfterHash: "a".repeat(64),
    gatewayAfterHash: "b".repeat(64),
  }));
  const input = r2Input({
    rows,
    pool: [],
    managedChains: {},
    mode: "enforced",
    enforcementStateVerified: true,
    shadowObservations,
    tombstones: [{ logicalName: "route-a", active: true }],
    durableRecoveryRule: "explicit request plus three exact 200s",
    decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
    policyApproval: {
      approvedBy: "root",
      approvedAt: 2_000_000_000_000,
      activationProvenance: "spec45-manifest",
      recoveryProof: "three-exact-200",
      decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS,
      mixedThrottlePolicy: "mixed failures remain non-destructive",
      implementationTestsPassed: true,
      evidenceRef: "spec46-approval-and-hermetic-tests",
    },
    baselineVerified: true,
    baseline: {
      windowStartAt: R0_CUTOFF_MS,
      windowEndAt: 1_999_999_998_000,
      capturedAt: 1_999_999_999_000,
      applyAt: 2_000_000_001_000,
      baselineCalls: 20,
      baselineRateLimits: 5,
      evidenceRef: "immutable-baseline-receipt",
    },
  });
  expect(getCheck(evaluateR2(input).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  input.managedChainsAvailable = true;
  input.durableRecoveryRule = "three exact 200 observations plus an explicit recovery request";
  expect(getCheck(evaluateR2(input).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  expect(getCheck(evaluateR2({ ...input, enforcementStateVerified: false }).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  const postApplyShadow = shadowObservations.map((entry, index) => ({
    ...entry,
    stateTs: input.baseline!.applyAt + index + 1,
    decisionAt: input.baseline!.applyAt + index + 1,
  }));
  expect(getCheck(evaluateR2({ ...input, shadowObservations: postApplyShadow }).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  expect(getCheck(evaluateR2({ ...input, pool: ["route-a"] }).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  expect(getCheck(evaluateR2({ ...input, managedChains: { editorial: ["route-a"] } }).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
  expect(evaluateR2({ ...input, rows: [] }).hardDead).toEqual(["route-a"]);
  expect(evaluateR2({ ...input, available: false }).hardDead).toEqual(["route-a"]);

  const earnedRows = [
    ...Array.from({ length: 50 }, (_, index) => gatewayRow({ id: 100 + index, ts: 500 + index, success: 1 })),
    ...Array.from({ length: 20 }, (_, index) => gatewayRow({ id: 200 + index, ts: 2_000 + index, success: 0, error_class: "auth" })),
  ];
  const quarantineShadow = shadowObservations.map((entry) => ({ ...entry, wouldPrune: [], wouldQuarantine: ["route-a"] }));
  expect(getCheck(evaluateR2({
    ...input,
    rows: earnedRows,
    tombstones: [],
    managedChains: { editorial: ["route-a"] },
    shadowObservations: quarantineShadow,
  }).checks, "r2.reconciliation").verdict).toBe("UNVERIFIABLE");
});

test("R2 outcome delta cannot claim improvement or regression before a verified enforcement apply", () => {
  const applyAt = R0_CUTOFF_MS + 10_000;
  const baseline = {
    windowStartAt: R0_CUTOFF_MS,
    windowEndAt: applyAt - 2_000,
    capturedAt: applyAt - 1_000,
    applyAt,
    baselineCalls: 20,
    baselineRateLimits: 5,
    evidenceRef: "immutable-baseline-receipt",
  };
  const postRows = Array.from({ length: 20 }, (_, index) => gatewayRow({
    id: index,
    ts: applyAt + index,
    success: index === 0 ? 0 : 1,
    error_class: index === 0 ? "rate_limit" : null,
  }));
  const improving = getCheck(evaluateR2(r2Input({
    rows: postRows,
    baselineVerified: true,
    baseline,
  })).checks, "r2.outcome_delta");
  expect(improving.verdict).toBe("PENDING");

  const attemptedTombstone = getCheck(evaluateR2(r2Input({
    rows: postRows,
    tombstones: [{ logicalName: "route-a", active: true }],
    baselineVerified: true,
    baseline,
  })).checks, "r2.outcome_delta");
  expect(attemptedTombstone.verdict).toBe("PENDING");

  const impossible = getCheck(evaluateR2(r2Input({
    rows: postRows,
    baselineVerified: true,
    baseline: { ...baseline, baselineCalls: 5, baselineRateLimits: 6 },
  })).checks, "r2.outcome_delta");
  expect(impossible.verdict).toBe("UNVERIFIABLE");
});

test("R2 outcome delta does not let an unmapped infrastructure failure poison the pre-apply gate", () => {
  const applyAt = R0_CUTOFF_MS + 10_000;
  const baseline = {
    windowStartAt: R0_CUTOFF_MS,
    windowEndAt: applyAt - 2_000,
    capturedAt: applyAt - 1_000,
    applyAt,
    baselineCalls: 20,
    baselineRateLimits: 5,
    evidenceRef: "immutable-baseline-receipt",
  };
  const comparable = Array.from({ length: 20 }, (_, index) => gatewayRow({
    id: index,
    ts: applyAt + index,
    success: index === 0 ? 0 : 1,
    error_class: index === 0 ? "rate_limit" : null,
  }));
  const infrastructure = gatewayRow({
    id: 99,
    ts: applyAt + 100,
    resolved_model: "unmapped/infrastructure-placeholder",
    success: 0,
    error_class: "gateway_unreachable",
  });
  const outcome = getCheck(evaluateR2(r2Input({
    rows: [...comparable, infrastructure],
    baselineVerified: true,
    baseline,
  })).checks, "r2.outcome_delta");
  expect(outcome.verdict).toBe("PENDING");
  expect(outcome.metrics).toMatchObject({ enforced: false, enforcementStateVerified: false });
});

test("R3 validates every enum/reason and exact row histogram totals", () => {
  const payload = modelsPayload([
    { healthState: "live", healthBucket: "healthy", healthReason: "fast" },
    { healthState: "dead", healthBucket: "unhealthy", healthReason: "not serving" },
    { healthState: "unknown", healthBucket: "unknown", healthReason: "not observed" },
  ]);
  expect(validateModelsApi(payload)).toMatchObject({ valid: true, modelCount: 3, healthy: 1, unhealthy: 1, unknown: 1 });
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload }).verdict).toBe("PASS");
});

test("R3 refuses missing auth, malformed payload, bad summaries, and degenerate separation", () => {
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: null, authConfigured: false }).verdict).toBe("UNVERIFIABLE");
  expect(evaluateR3({ available: true, anonymousStatus: 200, authenticatedStatus: 200, authConfigured: true, payload: {} }).verdict).toBe("FAIL");
  const malformed = modelsPayload([{ healthState: "live", healthBucket: "healthy", healthReason: "fast" }]) as any;
  malformed.data.summary.healthStateSummary.live = 9;
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload: malformed }).verdict).toBe("FAIL");
  const degenerate = modelsPayload([{ healthState: "live", healthBucket: "healthy", healthReason: "fast" }]);
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload: degenerate }).verdict).toBe("PENDING");
  const duplicate = modelsPayload([
    { logicalName: "duplicate", healthState: "live", healthBucket: "healthy", healthReason: "fast" },
    { logicalName: "duplicate", healthState: "dead", healthBucket: "unhealthy", healthReason: "dead" },
  ]);
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload: duplicate }).verdict).toBe("FAIL");
});

test("R3 rejects extra state or bucket histogram keys", () => {
  const extraState = modelsPayload([
    { healthState: "live", healthBucket: "healthy", healthReason: "fast" },
    { healthState: "dead", healthBucket: "unhealthy", healthReason: "not serving" },
  ]) as any;
  extraState.data.summary.healthStateSummary.rogue = 0;
  expect(validateModelsApi(extraState).valid).toBeFalse();
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload: extraState }).verdict).toBe("FAIL");

  const extraBucket = modelsPayload([
    { healthState: "live", healthBucket: "healthy", healthReason: "fast" },
    { healthState: "dead", healthBucket: "unhealthy", healthReason: "not serving" },
  ]) as any;
  extraBucket.data.summary.healthBucketSummary.rogue = 0;
  expect(validateModelsApi(extraBucket).valid).toBeFalse();
  expect(evaluateR3({ available: true, anonymousStatus: 401, authenticatedStatus: 200, authConfigured: true, payload: extraBucket }).verdict).toBe("FAIL");
});

test("overall and process exit precedence is strict", () => {
  const check = (verdict: CheckResult["verdict"]): CheckResult => ({ id: verdict, verdict, note: verdict, metrics: {}, evidence: [] });
  expect(overallFromChecks([check("PASS")])).toBe("verified");
  expect(overallFromChecks([check("PASS"), check("PENDING")])).toBe("partial");
  expect(overallFromChecks([check("PENDING"), check("UNVERIFIABLE")])).toBe("unverifiable");
  expect(overallFromChecks([check("FAIL"), check("UNVERIFIABLE")])).toBe("regressed");
  expect(exitCodeForOverall("verified")).toBe(0);
  expect(exitCodeForOverall("regressed")).toBe(2);
  expect(exitCodeForOverall("partial")).toBe(3);
  expect(exitCodeForOverall("unverifiable")).toBe(3);
});

test("required static validation gates stay pending when absent and pass only for the candidate commit", () => {
  const now = 2_000_000_000_000;
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  expect(evaluateValidation(undefined, commit, now).every((check) => check.verdict === "PENDING")).toBeTrue();
  expect(evaluateValidation(validationObservation(now, commit), commit.slice(0, 12), now).every((check) => check.verdict === "PASS")).toBeTrue();
  const failed = validationObservation(now, commit);
  failed.freshHost.error5xx = 1;
  expect(getCheck(evaluateValidation(failed, commit, now), "fresh_host.api_only").verdict).toBe("FAIL");
  const unverified = validationObservation(now, commit);
  unverified.manifestVerified = false;
  expect(evaluateValidation(unverified, commit, now).every((check) => check.verdict === "UNVERIFIABLE")).toBeTrue();
});

test("validation schema v2 remains non-authoritative even after its immutable artifacts are rehashed", () => {
  const bundle = validationBundle();
  const rejectedV2 = collectValidationManifest(
    { manifestPath: bundle.manifest.path, manifestSha256: bundle.manifest.sha256 },
    bundle.commit,
    bundle.now,
    true,
    bundle.tree,
    bundle.receiptRoot,
    bundle.routerPath,
    bundle.classifierPath,
  );
  expect(rejectedV2).toMatchObject({ manifestVerified: false, commit: bundle.commit });
  expect(rejectedV2?.manifestError).toContain("schema v2 is non-authoritative");

  const missing = validationBundle({ omitRoute: true });
  const rejectedMissingRoute = collectValidationManifest(
    { manifestPath: missing.manifest.path, manifestSha256: missing.manifest.sha256 },
    missing.commit,
    missing.now,
    true,
    missing.tree,
    missing.receiptRoot,
    missing.routerPath,
    missing.classifierPath,
  );
  expect(rejectedMissingRoute).toMatchObject({ manifestVerified: false });
  expect(rejectedMissingRoute?.manifestError).toContain("route set");

  const wrongCandidate = validationBundle({ reportCommit: "c".repeat(40) });
  expect(collectValidationManifest(
    { manifestPath: wrongCandidate.manifest.path, manifestSha256: wrongCandidate.manifest.sha256 },
    wrongCandidate.commit,
    wrongCandidate.now,
    true,
    wrongCandidate.tree,
    wrongCandidate.receiptRoot,
    wrongCandidate.routerPath,
    wrongCandidate.classifierPath,
  )).toMatchObject({ manifestVerified: false });
});

test("live surface requires an HTML application-shell marker, not status 200 alone", () => {
  const commit = "a".repeat(40);
  const base = {
    available: true,
    healthStatus: 200,
    healthOk: true,
    versionStatus: 200,
    deployedCommit: commit,
    candidateCommit: commit,
    modelsShellStatus: 200,
    modelsShellContentType: "text/html; charset=utf-8",
    modelsShellMarker: true,
    serviceActive: true,
    newErrorEntries: 0,
  };
  expect(evaluateLiveSurface(base).verdict).toBe("PASS");
  expect(evaluateLiveSurface({ ...base, modelsShellMarker: false }).verdict).toBe("FAIL");
  expect(evaluateLiveSurface({ ...base, available: false, healthStatus: 500, healthOk: false, serviceActive: null, error: "journal unavailable" }).verdict).toBe("FAIL");
});

test("evidence sanitizer preserves causal receipt token identifiers while removing credential keys", () => {
  const value = sanitizeForEvidence({ receiptTokenId: "causal-id", token: "secret", authorization: "Bearer secret" });
  expect(value).toEqual({ receiptTokenId: "causal-id" });
});

test("acceptance logging is a required two-phase receipt rather than an implicit success", () => {
  const now = Date.UTC(2026, 6, 18, 20, 0, 0);
  const commit = "a".repeat(40);
  expect(evaluateAcceptanceLog(undefined, commit, now).verdict).toBe("PENDING");
  expect(evaluateAcceptanceLog({
    available: true,
    path: "/opt/ai-vault/daily/2026-07-18.md",
    evidencePath: "/var/lib/control-surface/repair-arc-evidence/20260718T195900Z.json",
    commit,
    recordedAt: now - 30_000,
  }, commit, now).verdict).toBe("PASS");
  for (const recordedAt of [Number.NaN, Number.POSITIVE_INFINITY, 8_640_000_000_000_001]) {
    expect(evaluateAcceptanceLog({
      available: true,
      path: "/opt/ai-vault/daily/2026-07-18.md",
      evidencePath: "/var/lib/control-surface/repair-arc-evidence/20260718T195900Z.json",
      commit,
      recordedAt,
    }, commit, now).verdict).toBe("FAIL");
  }
});

test("R6 acceptance correlates bounded run traces and ordered aliases to ledger rows", () => {
  const startedAt = R0_CUTOFF_MS + 10_000;
  const finishedAt = startedAt + 2_000;
  const commit = "b".repeat(40);
  const traceId = "20000000-0000-4000-8000-000000000001";
  const receiptId = "30000000-0000-4000-8000-000000000001";
  const validatorId = "40000000-0000-4000-8000-000000000001";
  const rows = [
    gatewayRow({ id: 1, ts: startedAt + 100, trace_id: traceId, caller: "insights-ai", resolved_model: "provider/model-a", success: 0, error_class: "timeout" }),
    gatewayRow({ id: 2, ts: startedAt + 200, trace_id: traceId, caller: "insights-ai", resolved_model: "provider/model-b", success: 1, error_class: null }),
  ];
  const run = {
    authorized: true,
    authorizationId: "50000000-0000-4000-8000-000000000001",
    id: "editorial-production-20260718-1",
    workflowId: "newsbites-publish-20260718-1",
    stageId: "editorial-draft-20260718-1",
    builderPassId: null,
    startedAt,
    finishedAt,
    success: true,
    validatorPassed: true,
    hardDeadRouteUsed: false,
    traces: [{ traceId, orderedHops: ["route-a", "route-b"] }],
    evidenceRef: `/var/lib/control-surface/repair-arc-evidence/receipts/r6-editorial-${receiptId}.json`,
    validatorEvidenceRef: `/var/lib/control-surface/repair-arc-evidence/receipts/r6-validator-editorial-${validatorId}.json`,
    validatorEvidenceSha256: "c".repeat(64),
    validatorVerified: true,
    subjectVerified: true,
    receiptSha256: "a".repeat(64),
    receiptVerified: true,
    attemptCount: 1,
    candidateCommit: commit,
    deployedCommit: commit,
    deploymentObservedAt: startedAt - 1_000,
    deploymentConfirmedAt: finishedAt + 500,
    expectedCaller: "insights-ai",
    expectedTenant: "mimule",
  };
  const routes = [
    { logicalName: "route-a", resolvedModel: "provider/model-a", eligible: true, eligibilityKnown: true },
    { logicalName: "route-b", resolvedModel: "provider/model-b", eligible: true, eligibilityKnown: true },
  ];
  const passed = evaluateWorkRun("editorial", run, new Set(), rows, routes, finishedAt + 1_000, R0_CUTOFF_MS, commit);
  expect(passed.verdict).toBe("PASS");
  expect(passed.evidence[0]).toMatchObject({ runId: "editorial-production-20260718-1", traces: [{ traceId, orderedHops: ["route-a", "route-b"] }] });
  expect(evaluateWorkRun("editorial", run, new Set(["route-b"]), rows, routes, finishedAt + 1_000, R0_CUTOFF_MS, commit).verdict).toBe("FAIL");
  expect(evaluateWorkRun("editorial", { ...run, traces: [{ traceId, orderedHops: ["route-b", "route-a"] }] }, new Set(), rows, routes, finishedAt + 1_000, R0_CUTOFF_MS, commit).verdict).toBe("FAIL");
  const directOnly = rows.map((row) => ({ ...row, backend: "cli-direct" }));
  expect(evaluateWorkRun("editorial", run, new Set(), directOnly, routes, finishedAt + 1_000, R0_CUTOFF_MS, commit).verdict).toBe("FAIL");

  const outsideWindow = gatewayRow({
    id: 0,
    ts: startedAt - 1,
    trace_id: traceId,
    caller: "insights-ai",
    resolved_model: "provider/model-a",
    success: 0,
    error_class: "timeout",
  });
  const clippedTrace = evaluateWorkRun("editorial", run, new Set(), [outsideWindow, ...rows], routes, finishedAt + 1_000, R0_CUTOFF_MS, commit);
  expect(clippedTrace.verdict).toBe("FAIL");
  expect(clippedTrace.evidence.some((entry) => entry.invariant === "entire_trace_within_workload_window")).toBeTrue();

  for (const synthetic of [
    { ...run, id: "synthetic-editorial-run" },
    { ...run, workflowId: "demo-workflow" },
    { ...run, stageId: "fixture-stage" },
    { ...run, traces: [{ traceId: "test-trace", orderedHops: ["route-a", "route-b"] }] },
  ]) {
    expect(evaluateWorkRun("editorial", synthetic, new Set(), rows, routes, finishedAt + 1_000, R0_CUTOFF_MS, commit).verdict).toBe("PENDING");
  }
});

test("R6 rejects cross-kind reuse of a verified run and trace identity", () => {
  const startedAt = R0_CUTOFF_MS + 20_000;
  const finishedAt = startedAt + 2_000;
  const generatedAt = finishedAt + 1_000;
  const commit = "c".repeat(40);
  const traceId = "70000000-0000-4000-8000-000000000001";
  const receiptId = "80000000-0000-4000-8000-000000000001";
  const rows = [
    gatewayRow({ id: 1, ts: startedAt + 100, trace_id: traceId, caller: "insights-ai", resolved_model: "provider/model-a", success: 0, error_class: "timeout" }),
    gatewayRow({ id: 2, ts: startedAt + 200, trace_id: traceId, caller: "insights-ai", resolved_model: "provider/model-b", success: 1, error_class: null }),
  ];
  const routes = [
    { logicalName: "route-a", resolvedModel: "provider/model-a", eligible: true, eligibilityKnown: true },
    { logicalName: "route-b", resolvedModel: "provider/model-b", eligible: true, eligibilityKnown: true },
  ];
  const shared = {
    authorized: true,
    authorizationId: "90000000-0000-4000-8000-000000000001",
    id: "production-work-20260718-1",
    startedAt,
    finishedAt,
    success: true,
    validatorPassed: true,
    hardDeadRouteUsed: false,
    traces: [{ traceId, orderedHops: ["route-a", "route-b"] }],
    receiptSha256: "d".repeat(64),
    validatorEvidenceSha256: "e".repeat(64),
    validatorVerified: true,
    subjectVerified: true,
    receiptVerified: true,
    attemptCount: 1,
    candidateCommit: commit,
    deployedCommit: commit,
    deploymentObservedAt: startedAt - 1_000,
    deploymentConfirmedAt: finishedAt + 500,
    expectedCaller: "insights-ai",
    expectedTenant: "mimule",
  };
  const report = verifyRepairArc({
    generatedAt,
    gatewayRows: rows,
    r2: r2Input({ rows, routes }),
    liveSurface: { available: false, candidateCommit: commit },
    realWork: {
      editorial: {
        ...shared,
        workflowId: "newsbites-publish-20260718-1",
        stageId: "editorial-draft-20260718-1",
        builderPassId: null,
        evidenceRef: `/var/lib/control-surface/repair-arc-evidence/receipts/r6-editorial-${receiptId}.json`,
        validatorEvidenceRef: "/var/lib/control-surface/repair-arc-evidence/receipts/r6-validator-editorial-a0000000-0000-4000-8000-000000000001.json",
      },
      builder: {
        ...shared,
        workflowId: "builder-publish-20260718-1",
        stageId: null,
        builderPassId: "builder-pass-20260718-1",
        evidenceRef: `/var/lib/control-surface/repair-arc-evidence/receipts/r6-builder-${receiptId}.json`,
        validatorEvidenceRef: "/var/lib/control-surface/repair-arc-evidence/receipts/r6-validator-builder-production-work-20260718-1.json",
      },
    },
  });
  const editorial = getCheck(report.checks, "r6.editorial");
  const builder = getCheck(report.checks, "r6.builder");
  expect(editorial.verdict).toBe("FAIL");
  expect(builder.verdict).toBe("FAIL");
  expect(editorial.evidence).toContainEqual({ invariant: "distinct_cross_kind_run_id", value: "production-work-20260718-1" });
  expect(editorial.evidence).toContainEqual({ invariant: "distinct_cross_kind_trace", value: traceId });
});

test("missing R4/R5 and real-work evidence keeps a structurally healthy report partial", () => {
  const report = verifyRepairArc({ generatedAt: 2_000_000_000_000, gatewayRows: [] });
  expect(report.overall).toBe("partial");
  expect(getCheck(report.checks, "r6.editorial").verdict).toBe("PENDING");
  expect(getCheck(report.checks, "r4.disposition").verdict).toBe("PENDING");
  expect(getCheck(report.checks, "r5.disposition").verdict).toBe("PENDING");
  expect(getCheck(report.checks, "classifier.contract").verdict).toBe("PENDING");
  expect(getCheck(report.checks, "acceptance.log").verdict).toBe("PENDING");
});

test("future operator dispositions are rejected", () => {
  const generatedAt = 2_000_000_000_000;
  const report = verifyRepairArc({
    generatedAt,
    gatewayRows: [],
    r4Disposition: { status: "deferred", at: generatedAt + 1, reason: "later" },
    r5Disposition: { status: "declined", at: generatedAt + 1 },
  });
  expect(getCheck(report.checks, "r4.disposition").verdict).toBe("FAIL");
  expect(getCheck(report.checks, "r5.disposition").verdict).toBe("FAIL");
});

test("reprobe parser validates history instead of casting malformed entries", () => {
  const parsed = parseReprobeState({
    ts: 1_800_000_000,
    changed: false,
    pool: ["route-a", "route-500"], live: ["route-a"], limited: [], dead: [], hang: [], timeout: [],
    history: {
      "route-a": { code: 200, category: "routable", streak: 3, since: 1_800_000_000, ms: 100 },
      "route-500": { code: 500, category: "routable", streak: 3, since: 1_800_000_000, ms: 90 },
      broken: { code: "408", streak: 2 },
    },
  });
  expect(parsed.history["route-a"]).toMatchObject({ code: 200, streak: 3, latency: 100 });
  expect(parsed.history.broken).toBeUndefined();
  expect(parsed.malformedHistoryModels).toEqual(["broken"]);
});

test("live R2 mode reader preserves unexpected safe modes and rejects control characters", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-r2-live-mode-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "reprobe.json");
  const asOf = Date.UTC(2026, 6, 18, 18, 0, 0);
  writeFileSync(path, JSON.stringify({
    ledger_decisions: { policy_version: 1, mode: "enforce-prune", enforced: true, as_of: new Date(asOf).toISOString() },
  }));
  expect(collectR2LiveMode(path, asOf + 1)).toEqual({
    status: "verified", policyVersion: 1, mode: "enforce-prune", enforced: true, asOf,
  });
  writeFileSync(path, JSON.stringify({
    ledger_decisions: { policy_version: 1, mode: "shadow\nunsafe", enforced: false, as_of: new Date(asOf).toISOString() },
  }));
  expect(collectR2LiveMode(path, asOf + 1).status).toBe("unavailable");
});

test("CLI accepts no token argument and rejects invalid arguments", () => {
  expect(parseCliArgs(["--base-url", "http://127.0.0.1:3000/"]).baseUrl).toBe("http://127.0.0.1:3000");
  expect(() => parseCliArgs(["--token", "secret"])).toThrow("unknown argument");
  expect(() => parseCliArgs(["--base-url", "file:///tmp/x"])).toThrow("http or https");
  expect(() => parseCliArgs(["--base-url", "https://user:secret@example.test/"])).toThrow("userinfo");
  expect(() => parseCliArgs(["--base-url", "https://localhost/"])).toThrow("canonical");
  expect(() => parseCliArgs(["--base-url", "https://example.test/"])).toThrow("canonical");
  expect(() => parseCliArgs(["--base-url", "http://example.test/"])).toThrow("canonical");
  expect(() => parseCliArgs(["--evidence-dir", "/etc/litellm"])).toThrow("must be exactly");
});

test("operator input cannot assert collected R2 state or enforcement verification flags", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-operator-input-"));
  temporaryDirectories.push(directory);
  const forbidden = join(directory, "forbidden.json");
  writeFileSync(forbidden, JSON.stringify({ r2: { mode: "enforced", enforcementStateVerified: true, rows: [] } }));
  expect(() => readOperatorInput(forbidden)).toThrow("forbidden fields");

  const allowed = join(directory, "allowed.json");
  writeFileSync(allowed, JSON.stringify({ r2: { decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS } }));
  expect(readOperatorInput(allowed)).toEqual({ r2: { decayWindowMs: R2_RATE_LIMIT_MIN_AGE_MS } });
});

test("timestamped evidence is exclusive, partial never promotes latest, and secrets are absent", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-test-"));
  temporaryDirectories.push(directory);
  const generatedAt = Date.UTC(2026, 6, 18, 15, 0, 0);
  const report = {
    generatedAt,
    overall: "partial" as const,
    checks: [{
      id: "secret",
      verdict: "PENDING" as const,
      note: "request failed with Bearer topsecret token=topsecret",
      metrics: {},
      evidence: [{ token: "topsecret", safe: "kept" }],
    }],
  };
  const envelope: EvidenceEnvelope = {
    schemaVersion: 2,
    generatedAt,
    generatedAtUtc: new Date(generatedAt).toISOString(),
    sourceCommits: { controlSurface: "abc", mimoun: "def" },
    sourceClean: { controlSurface: true, mimounReprobe: true },
    cutoffs: { r0Unified: R0_CUTOFF_MS },
    queryWindows: { r0: { from: R0_CUTOFF_MS, to: generatedAt } },
    observations: { r1Current: null, r2Current: null, r1Failures: [] },
    report,
  };
  const written = writeEvidenceSnapshot(directory, envelope, ["topsecret"]);
  expect(existsSync(written.evidencePath)).toBeTrue();
  expect(written.latestAcceptedPath).toBeNull();
  expect(existsSync(join(directory, "latest-accepted.json"))).toBeFalse();
  const serialized = readFileSync(written.evidencePath, "utf8");
  expect(serialized).not.toContain("topsecret");
  expect(serialized).not.toContain('"token"');
  expect(serialized).toContain("[REDACTED]");
  expect(() => writeEvidenceSnapshot(directory, envelope, ["topsecret"])).toThrow();
});

test("prior evidence loader retains current-schema artifacts but excludes journal-derived R1/R2 claims", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-history-"));
  temporaryDirectories.push(directory);
  const generatedAt = Date.UTC(2026, 6, 18, 18, 0, 0);
  const commits = {
    controlSurface: "a".repeat(40),
    mimoun: "b".repeat(40),
  };
  const r1 = stableObservation(3, generatedAt - 1_000);
  r1.invocationId = "c".repeat(32);
  const r2 = {
    invocationId: r1.invocationId,
    stateTs: r1.stateTs,
    decisionAt: r1.stateTs,
    policyVersion: 1,
    ledgerAvailable: true,
    enforced: false,
    scheduled: true,
    success: true,
    wouldPrune: ["route-a"],
    wouldQuarantine: [],
    litellmChanged: false,
    gatewayChanged: false,
    litellmAfterHash: "d".repeat(64),
    gatewayAfterHash: "e".repeat(64),
  };
  const envelope: EvidenceEnvelope = {
    schemaVersion: 2,
    generatedAt,
    generatedAtUtc: new Date(generatedAt).toISOString(),
    sourceCommits: commits,
    sourceClean: { controlSurface: true, mimounReprobe: true },
    cutoffs: { r0Unified: R0_CUTOFF_MS },
    queryWindows: {
      r0: { from: R0_CUTOFF_MS, to: generatedAt },
      r2Recent: { from: generatedAt - 7 * 24 * 60 * 60 * 1_000, to: generatedAt },
      r1Restarts: { from: generatedAt - 24 * 60 * 60 * 1_000, to: generatedAt },
    },
    observations: { r1Current: r1, r2Current: r2, r1Failures: [] },
    report: {
      generatedAt,
      overall: "partial",
      checks: [
        "r0.trace_coverage", "r0.request_outcomes", "evidence.history", "r1.stability",
        "r2.reconciliation", "r2.exact_429", "r2.outcome_delta", "r3.api_contract",
        "classifier.contract", "validation.bounded", "r3.ui_contract", "fresh_host.api_only",
        "live.surface", "r6.editorial", "r6.builder", "r4.disposition", "r5.disposition", "acceptance.log",
      ].map((id, index) => ({ id, verdict: index === 0 ? "PENDING" as const : "PASS" as const, note: "stored", metrics: {}, evidence: [] })),
    },
  };
  writeEvidenceSnapshot(directory, envelope);
  const loaded = loadPriorEvidence(directory, generatedAt + 1_000, commits);
  expect(loaded).toMatchObject({ available: true, artifacts: 1 });
  expect(loaded.r1).toHaveLength(0);
  expect(loaded.r2).toHaveLength(0);
  expect(loadPriorEvidence(directory, generatedAt + 1_000, { controlSurface: "f".repeat(40), mimoun: "b".repeat(40) })).toMatchObject({ available: true, artifacts: 0 });
  expect(loadPriorEvidence(directory, generatedAt - 1, commits).available).toBeFalse();

  const malformedDirectory = mkdtempSync(join(tmpdir(), "repair-arc-history-bad-"));
  temporaryDirectories.push(malformedDirectory);
  writeEvidenceSnapshot(malformedDirectory, { ...envelope, cutoffs: { r0Unified: R0_CUTOFF_MS + 1 } });
  expect(loadPriorEvidence(malformedDirectory, generatedAt + 1_000, commits).available).toBeFalse();
});

test("only verified timestamped evidence updates latest-accepted", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-accepted-"));
  temporaryDirectories.push(directory);
  const generatedAt = Date.UTC(2026, 6, 18, 16, 0, 0);
  const envelope = promotableEnvelope(generatedAt);
  const written = writeEvidenceSnapshot(directory, envelope);
  expect(written.latestAcceptedPath).toBe(join(directory, "latest-accepted.json"));
  expect(existsSync(join(directory, "latest-accepted.json"))).toBeTrue();
  expect(statSync(written.evidencePath).mode & 0o222).toBe(0);
  const older = generatedAt - 60_000;
  expect(() => writeEvidenceSnapshot(directory, promotableEnvelope(older))).toThrow("not older");
  expect(existsSync(join(directory, "20260718T155900Z.json"))).toBeFalse();
});

test("verified evidence publication retracts the timestamp if latest promotion fails", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-atomic-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "latest-accepted.json"));
  const generatedAt = Date.UTC(2026, 6, 18, 17, 0, 0);
  const envelope = promotableEnvelope(generatedAt);
  expect(() => writeEvidenceSnapshot(directory, envelope)).toThrow();
  expect(existsSync(join(directory, "20260718T170000Z.json"))).toBeFalse();
  expect(readdirSync(directory).some((name) => name.endsWith(".tmp") && name !== "latest-accepted.json")).toBeFalse();
});

test("verified evidence with short commits or incomplete query windows is rejected before publication", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-invalid-promotion-"));
  temporaryDirectories.push(directory);
  const generatedAt = Date.UTC(2026, 6, 18, 17, 30, 0);
  const invalid = promotableEnvelope(generatedAt);
  invalid.sourceCommits = { controlSurface: "abc", mimoun: "def" };
  invalid.queryWindows = { r0: { from: R0_CUTOFF_MS, to: generatedAt } };
  expect(() => writeEvidenceSnapshot(directory, invalid)).toThrow("exact promotion provenance");
  expect(readdirSync(directory)).toEqual([]);
});

test("writer recovery handles an aged prior-boot lock and a recognized backup hard link", () => {
  const directory = mkdtempSync(join(tmpdir(), "repair-arc-recovery-"));
  temporaryDirectories.push(directory);
  const staleAt = Date.now() - 20 * 60 * 1_000;
  const lockPath = join(directory, ".writer.lock");
  writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    bootId: "00000000-0000-0000-0000-000000000000",
    processStartTicks: "1",
    createdAt: staleAt,
  })}\n`, { mode: 0o600 });
  utimesSync(lockPath, new Date(staleAt), new Date(staleAt));

  const firstAt = Date.UTC(2026, 6, 18, 18, 0, 0);
  writeEvidenceSnapshot(directory, promotableEnvelope(firstAt));
  expect(existsSync(lockPath)).toBeFalse();
  const latest = join(directory, "latest-accepted.json");
  const backup = join(directory, ".latest-backup.999.10000000-0000-4000-8000-000000000001.tmp");
  linkSync(latest, backup);
  expect(statSync(latest).nlink).toBe(2);

  const secondAt = firstAt + 60_000;
  writeEvidenceSnapshot(directory, promotableEnvelope(secondAt));
  expect(existsSync(backup)).toBeFalse();
  expect(statSync(latest).nlink).toBe(1);
  expect(JSON.parse(readFileSync(latest, "utf8")).generatedAt).toBe(secondAt);
});

test("generic evidence sanitizer removes secret-like keys and non-finite metrics", () => {
  const clean = sanitizeForEvidence({ authorization: "Basic dXNlcjpiYWQ=", metric: Number.NaN, nested: { password: "bad", note: "api_key=bad" } }, ["bad"]);
  const serialized = JSON.stringify(clean);
  expect(serialized).not.toContain("bad");
  expect(serialized).not.toContain("authorization");
  expect(serialized).not.toContain("password");
  expect(serialized).toContain('"metric":null');
});
