import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { readJob, readJobs, type JobRow } from "../db/writer.ts";
import { ok, type ApiEnvelope } from "./types.ts";

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
