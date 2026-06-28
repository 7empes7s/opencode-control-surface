import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { readJob, readJobs, requestJobCancel, retryJob, type JobRow } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";
import { writeActionAudit } from "../db/writer.ts";

export type JobsResponse = {
  jobs: JobRow[];
  degraded: boolean;
  reason?: string;
};

function response(data: JobsResponse): Response {
  const envelope: ApiEnvelope<JobsResponse> = ok(data);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}

function parseLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 100;
  if (!Number.isFinite(parsed)) {
    return 100;
  }
  return Math.max(1, Math.min(500, parsed));
}

export async function jobsHandler(url: URL): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return response({ jobs: [], degraded: true, reason: "DASHBOARD_DB disabled" });
  }

  const jobs = readJobs({
    limit: parseLimit(url.searchParams.get("limit")),
    status: url.searchParams.get("status") ?? undefined,
    kind: url.searchParams.get("kind") ?? undefined,
  });
  return response({ jobs, degraded: false });
}

export function jobHandler(id: string): Response {
  if (!isDashboardDbEnabled()) {
    return response({ jobs: [], degraded: true, reason: "DASHBOARD_DB disabled" });
  }

  const job = readJob(id);
  if (!job) {
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return response({ jobs: [job], degraded: false });
}

export function cancelJobHandler(id: string, req: Request): Response {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const ok2 = requestJobCancel(id);
  writeActionAudit({
    actionKind: "jobs.cancel",
    actionId: `cancel-job:${id}`,
    targetType: "job",
    targetId: id,
    risk: "low",
    request: { jobId: id },
    resultStatus: ok2 ? "success" : "failed",
    error: ok2 ? undefined : "job not found or not running",
  });
  if (!ok2) {
    return new Response(JSON.stringify({ error: "job not found or not in a cancelable state" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, jobId: id, status: "canceled" }), { headers: { "Content-Type": "application/json" } });
}

export function retryJobHandler(id: string, req: Request): Response {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), { status: 503, headers: { "Content-Type": "application/json" } });
  }
  const childId = retryJob(id);
  writeActionAudit({
    actionKind: "jobs.retry",
    actionId: `retry-job:${id}`,
    targetType: "job",
    targetId: id,
    risk: "medium",
    request: { jobId: id },
    resultStatus: childId ? "success" : "failed",
    error: childId ? undefined : "job not found, not failed/canceled, or retry limit reached",
    resultJson: childId ? { childJobId: childId } : undefined,
    rollbackHint: `Cancel the child job ${childId ?? "?"} if the retry produces unwanted side effects.`,
  });
  if (!childId) {
    return new Response(JSON.stringify({ error: "job not found, not failed/canceled, or retry limit reached" }), { status: 404, headers: { "Content-Type": "application/json" } });
  }
  return new Response(JSON.stringify({ ok: true, parentJobId: id, childJobId: childId }), { headers: { "Content-Type": "application/json" } });
}
