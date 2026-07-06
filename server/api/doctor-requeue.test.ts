// Hermetic tests for SPEC 13 / ULTRAPLAN P3 A2 — doctor requeue actions.
//
// These NEVER hit the real autopipeline on :3200. globalThis.fetch is
// replaced with a recording stub for the whole file; every test asserts on
// the recorded outbound calls (url + body) instead of any live network
// traffic. This is required by the build rails: POSTing doctor-dispatch to
// the live pipeline during build/test would requeue real stories.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDashboardDb, getDashboardDb, initDashboardDb } from "../db/dashboard.ts";
import { createJob, readJob } from "../db/writer.ts";
import {
  DOCTOR_REQUEUE_CLASS_MAX,
  doctorRequeuHandler,
  doctorRequeueClassHandler,
  runDoctorRequeueClassDispatch,
  runDoctorRequeueDispatch,
} from "./actions.ts";

type FetchCall = { url: string; body: unknown };

let tempDir: string;
let previousDashboardDb: string | undefined;
let previousDashboardDbPath: string | undefined;
let previousDoctorLogPath: string | undefined;
let previousOperatorToken: string | undefined;
let originalFetch: typeof fetch;
let fetchCalls: FetchCall[];
let fetchImpl: (slug: string) => Response | Promise<Response>;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installFetchMock(): void {
  fetchCalls = [];
  fetchImpl = () => Response.json({ ok: true });
  const mock = Object.assign(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      fetchCalls.push({ url: String(url), body });
      const slug = body && typeof body === "object" ? (body as { slug?: string }).slug ?? "" : "";
      return fetchImpl(slug);
    },
    { preconnect: () => {} },
  ) as typeof fetch;
  globalThis.fetch = mock;
}

beforeEach(() => {
  closeDashboardDb();
  tempDir = mkdtempSync(join(tmpdir(), "doctor-requeue-"));
  previousDashboardDb = process.env.DASHBOARD_DB;
  previousDashboardDbPath = process.env.DASHBOARD_DB_PATH;
  previousDoctorLogPath = process.env.DASHBOARD_DOCTOR_LOG_PATH;
  previousOperatorToken = process.env.OPERATOR_TOKEN;
  process.env.DASHBOARD_DB = "1";
  process.env.DASHBOARD_DB_PATH = join(tempDir, "dashboard.sqlite");
  process.env.DASHBOARD_DOCTOR_LOG_PATH = join(tempDir, "doctor-log.jsonl");
  process.env.OPERATOR_TOKEN = "test-token";
  initDashboardDb({ path: process.env.DASHBOARD_DB_PATH });
  originalFetch = globalThis.fetch;
  installFetchMock();
});

afterEach(() => {
  closeDashboardDb();
  globalThis.fetch = originalFetch;
  restoreEnv("DASHBOARD_DB", previousDashboardDb);
  restoreEnv("DASHBOARD_DB_PATH", previousDashboardDbPath);
  restoreEnv("DASHBOARD_DOCTOR_LOG_PATH", previousDoctorLogPath);
  restoreEnv("OPERATOR_TOKEN", previousOperatorToken);
  rmSync(tempDir, { recursive: true, force: true });
});

function auditRows(actionKind: string): Array<{
  action_kind: string; target_id: string; result_status: string; error: string | null; job_id: string | null; result_json: string | null;
}> {
  return getDashboardDb()!.query(
    "SELECT action_kind, target_id, result_status, error, job_id, result_json FROM action_audit WHERE action_kind = ? ORDER BY id ASC",
  ).all(actionKind) as never;
}

function mutationRequest(path: string, payload: unknown): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-operator-token": "test-token" },
    body: JSON.stringify(payload),
  });
}

function writeDoctorLog(lines: unknown[]): void {
  writeFileSync(process.env.DASHBOARD_DOCTOR_LOG_PATH!, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

describe("per-entry doctor requeue (Deliverable 1)", () => {
  test("sends {cmd:doctor-dispatch,slug} to /command — NOT the old {command:requeue} — and writes job+audit on success", async () => {
    fetchImpl = () => Response.json({ ok: true, slug: "story-a", stage: "write", action: "retry", reason: "transient timeout", distinctModelsTried: 2 });

    createJob({ id: "job-1", kind: "doctor-requeue", targetType: "story", targetId: "story-a", command: "doctor-dispatch slug=story-a", request: { slug: "story-a" } });
    await runDoctorRequeueDispatch("job-1", "story-a");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("http://127.0.0.1:3200/command");
    expect(fetchCalls[0].body).toEqual({ cmd: "doctor-dispatch", slug: "story-a" });
    // The dead code's payload shape — must never be sent again.
    expect(fetchCalls[0].body).not.toEqual({ command: "requeue", slug: "story-a" });

    const job = readJob("job-1");
    expect(job?.status).toBe("success");
    expect(job?.error).toBeNull();

    const rows = auditRows("doctor.requeue.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].target_id).toBe("story-a");
    expect(rows[0].result_status).toBe("success");
    expect(rows[0].job_id).toBe("job-1");
  });

  test('pipeline ok:false "not currently stuck" refusal finishes the job failed with the message surfaced verbatim (not a throw)', async () => {
    fetchImpl = () => Response.json({ ok: false, error: '"story-b" not found in stuck stories' });

    createJob({ id: "job-2", kind: "doctor-requeue", targetType: "story", targetId: "story-b", command: "doctor-dispatch slug=story-b", request: { slug: "story-b" } });
    await expect(runDoctorRequeueDispatch("job-2", "story-b")).resolves.toBeUndefined();

    const job = readJob("job-2");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe('"story-b" not found in stuck stories');

    const rows = auditRows("doctor.requeue.finished");
    expect(rows).toHaveLength(1);
    expect(rows[0].result_status).toBe("failed");
    expect(rows[0].error).toBe('"story-b" not found in stuck stories');
  });

  test("network failure (fetch throws) finishes the job failed, not a crash", async () => {
    fetchImpl = () => { throw new Error("ECONNREFUSED 127.0.0.1:3200"); };

    createJob({ id: "job-3", kind: "doctor-requeue", targetType: "story", targetId: "story-c", command: "doctor-dispatch slug=story-c", request: { slug: "story-c" } });
    await expect(runDoctorRequeueDispatch("job-3", "story-c")).resolves.toBeUndefined();

    const job = readJob("job-3");
    expect(job?.status).toBe("failed");
    expect(job?.error).toContain("ECONNREFUSED");
  });

  test("POST /api/doctor/requeue: immediate response is job-then-poll, and the same fixed payload reaches the pipeline once settled", async () => {
    fetchImpl = () => Response.json({ ok: true, slug: "story-d", action: "retry_escalate", reason: "ok" });

    const res = await doctorRequeuHandler(mutationRequest("/api/doctor/requeue", { slug: "story-d", reason: "operator retry" }));
    expect(res.status).toBe(200);
    const resBody = await res.json() as { ok: boolean; jobId: string; message: string };
    expect(resBody.ok).toBe(true);
    expect(typeof resBody.jobId).toBe("string");
    expect(resBody.message).toContain("story-d");

    // Let the fire-and-forget worker settle.
    await new Promise((r) => setTimeout(r, 25));

    expect(fetchCalls.some((c) => c.url === "http://127.0.0.1:3200/command" && (c.body as { cmd?: string })?.cmd === "doctor-dispatch")).toBe(true);
    const job = readJob(resBody.jobId);
    expect(job?.status).toBe("success");
    expect(job?.kind).toBe("doctor-requeue");
    // Start-of-job audit (running) + finish audit both recorded.
    expect(auditRows("doctor.requeue")).toHaveLength(1);
    expect(auditRows("doctor.requeue.finished")).toHaveLength(1);
  });

  test("rejects without a mutating-capable request (no operator token) — never silently dispatches", async () => {
    const req = new Request("http://127.0.0.1:3000/api/doctor/requeue", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "story-e" }),
    });
    const res = await doctorRequeuHandler(req);
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("fix-all-of-class (Deliverable 2)", () => {
  test(`caps at DOCTOR_REQUEUE_CLASS_MAX (${DOCTOR_REQUEUE_CLASS_MAX})`, () => {
    expect(DOCTOR_REQUEUE_CLASS_MAX).toBe(10);
  });

  test("derives distinct slugs for the class (using the computed errorType, including the class-field fallback), dedups, and caps at 10", async () => {
    fetchImpl = () => Response.json({ ok: true, action: "retry" });

    // 13 distinct "quality_garbage" stories (one expressed only via the legacy
    // `class` field, proving we use getDoctorEntryErrorType — the same
    // computed value the doctor page displays/filters by — not the raw
    // jsonl `errorType` field getFullLog's own filter option checks), plus
    // duplicate rows for slug-1 (retries) and one unrelated error class that
    // must NOT be included.
    const lines: unknown[] = [];
    for (let i = 1; i <= 13; i++) {
      lines.push({ ts: new Date(2026, 6, 6, 0, 0, i).toISOString(), slug: `slug-${i}`, stage: "write", action: "escalate", errorType: i === 13 ? undefined : "quality_garbage", class: i === 13 ? "quality_garbage" : undefined });
    }
    lines.push({ ts: new Date(2026, 6, 6, 0, 1, 0).toISOString(), slug: "slug-1", stage: "write", action: "escalate", errorType: "quality_garbage" }); // retry/dup
    lines.push({ ts: new Date(2026, 6, 6, 0, 1, 1).toISOString(), slug: "slug-other", stage: "write", action: "escalate", errorType: "transport_timeout" });
    writeDoctorLog(lines);

    const res = await doctorRequeueClassHandler(mutationRequest("/api/doctor/requeue-class", { errorType: "quality_garbage" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; jobId: string; summary: { errorType: string; total: number; acted: number; candidateSlugs: string[] } };
    expect(body.ok).toBe(true);
    expect(body.summary.errorType).toBe("quality_garbage");
    expect(body.summary.total).toBe(13); // distinct slug-1..slug-13, dedup collapses the retry row
    expect(body.summary.acted).toBe(10); // capped
    expect(body.summary.candidateSlugs).toHaveLength(10);
    expect(new Set(body.summary.candidateSlugs).size).toBe(10); // no duplicates
    expect(body.summary.candidateSlugs).not.toContain("slug-other");

    await new Promise((r) => setTimeout(r, 25));
    const job = readJob(body.jobId);
    expect(job?.status).toBe("success");
    expect(auditRows("doctor.requeue-class.slug")).toHaveLength(10);
    const finished = auditRows("doctor.requeue-class.finished");
    expect(finished).toHaveLength(1);
    const summary = JSON.parse(finished[0].result_json!) as { total: number; acted: number; dispatched: number };
    expect(summary.total).toBe(13);
    expect(summary.acted).toBe(10);
    expect(summary.dispatched).toBe(10);
  });

  test("per-slug failure isolation: one refusal and one crash never abort the batch; one audit row per slug + parent summary", async () => {
    fetchImpl = (slug: string) => {
      if (slug === "ok-1" || slug === "ok-2") return Response.json({ ok: true, action: "retry" });
      if (slug === "refused-1") return Response.json({ ok: false, error: `"${slug}" not found in stuck stories` });
      if (slug === "crash-1") throw new Error("timeout contacting pipeline");
      return Response.json({ ok: false, error: "unexpected" });
    };

    createJob({ id: "job-batch-1", kind: "doctor-requeue-class", targetType: "doctor", targetId: "capacity_rate_limit", request: { errorType: "capacity_rate_limit" } });
    await runDoctorRequeueClassDispatch("job-batch-1", "capacity_rate_limit", ["ok-1", "refused-1", "crash-1", "ok-2"], 4);

    const job = readJob("job-batch-1");
    expect(job?.status).toBe("success"); // batch completion, isolated per-slug outcomes
    const summary = JSON.parse(job!.outputTail) as {
      total: number; acted: number; dispatched: number; refused: number; failed: number;
      perSlug: { slug: string; ok: boolean; message: string }[];
    };
    expect(summary.total).toBe(4);
    expect(summary.acted).toBe(4);
    expect(summary.dispatched).toBe(2);
    expect(summary.refused).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.perSlug).toHaveLength(4);
    expect(summary.perSlug.find((p) => p.slug === "refused-1")?.ok).toBe(false);
    expect(summary.perSlug.find((p) => p.slug === "crash-1")?.message).toContain("timeout contacting pipeline");
    expect(summary.perSlug.find((p) => p.slug === "ok-1")?.ok).toBe(true);
    expect(summary.perSlug.find((p) => p.slug === "ok-2")?.ok).toBe(true);

    const perSlugAudits = auditRows("doctor.requeue-class.slug");
    expect(perSlugAudits).toHaveLength(4);
    expect(perSlugAudits.every((r) => r.job_id === "job-batch-1")).toBe(true);
    expect(perSlugAudits.filter((r) => r.result_status === "success")).toHaveLength(2);
    expect(perSlugAudits.filter((r) => r.result_status === "failed")).toHaveLength(2);

    expect(auditRows("doctor.requeue-class.finished")).toHaveLength(1);
  });

  test("empty candidate set returns an honest empty summary and makes zero pipeline calls", async () => {
    writeDoctorLog([{ ts: new Date().toISOString(), slug: "unrelated", stage: "write", action: "escalate", errorType: "transport_provider_error" }]);

    const res = await doctorRequeueClassHandler(mutationRequest("/api/doctor/requeue-class", { errorType: "quality_validation" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; jobId: string; message: string; summary: { total: number; acted: number; candidateSlugs: string[] } };
    expect(body.ok).toBe(true);
    expect(body.summary.total).toBe(0);
    expect(body.summary.acted).toBe(0);
    expect(body.summary.candidateSlugs).toEqual([]);
    expect(body.message.toLowerCase()).toContain("no candidates");

    await new Promise((r) => setTimeout(r, 25));
    expect(fetchCalls).toHaveLength(0); // no candidates -> never touches the pipeline

    const job = readJob(body.jobId);
    expect(job?.status).toBe("success");
    const summary = JSON.parse(job!.outputTail) as { errorType: string; total: number; acted: number; dispatched: number; refused: number; failed: number; perSlug: unknown[] };
    expect(summary).toEqual({ errorType: "quality_validation", total: 0, acted: 0, dispatched: 0, refused: 0, failed: 0, perSlug: [] });
    expect(auditRows("doctor.requeue-class.slug")).toHaveLength(0);
    expect(auditRows("doctor.requeue-class.finished")).toHaveLength(1);
  });

  test("rejects without a mutating-capable request — never silently dispatches a class fix", async () => {
    writeDoctorLog([{ ts: new Date().toISOString(), slug: "story-x", stage: "write", action: "escalate", errorType: "quality_garbage" }]);
    const req = new Request("http://127.0.0.1:3000/api/doctor/requeue-class", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ errorType: "quality_garbage" }),
    });
    const res = await doctorRequeueClassHandler(req);
    expect(res.status).toBe(401);
    expect(fetchCalls).toHaveLength(0);
  });

  test("requires errorType", async () => {
    const res = await doctorRequeueClassHandler(mutationRequest("/api/doctor/requeue-class", {}));
    expect(res.status).toBe(400);
  });
});
