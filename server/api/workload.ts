import { readJobs } from "../db/writer.ts";
import { readBuilderRuns } from "../builder/store.ts";
import { getPipelineState } from "../adapters/pipeline.ts";
import { isDashboardDbEnabled } from "../db/dashboard.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export type WorkloadEntry = {
  id: string;
  name: string;
  type: "newsbites" | "autopipeline" | "builder" | "agent" | "other";
  status: "success" | "failed" | "running" | "queued" | "pending";
  startTime: number;
  endTime: number | null;
  durationMs: number | null;
  modelUsed?: string;
  score?: number;
};

export type WorkloadResponse = {
  entries: WorkloadEntry[];
  summary: {
    newsbites: { success: number; failed: number; running: number };
    autopipeline: { success: number; failed: number; running: number };
    builder: { success: number; failed: number; running: number };
    agent: { success: number; failed: number; running: number };
    other: { success: number; failed: number; running: number };
  };
};

function getStatusFromJobStatus(status: string): WorkloadEntry["status"] {
  switch (status) {
    case "success": return "success";
    case "failed": return "failed";
    case "running": return "running";
    case "queued": return "queued";
    default: return "pending";
  }
}

export async function workloadHandler(req: Request): Promise<Response> {
  if (!isDashboardDbEnabled()) {
    return new Response(JSON.stringify({ error: "DASHBOARD_DB disabled" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Get jobs data
    const jobs = readJobs({ limit: 100 });
    
    // Get builder runs data
    const builderRuns = readBuilderRuns();
    
    // Get autopipeline data
    const pipelineState = await getPipelineState();

    const entries: WorkloadEntry[] = [];

    // Process jobs
    for (const job of jobs) {
      entries.push({
        id: job.id,
        name: job.reason || job.command || job.kind,
        type: job.kind.includes("newsbites") ? "newsbites" : 
              job.kind.includes("autopipeline") ? "autopipeline" : 
              job.kind.includes("agent") ? "agent" : "other",
        status: getStatusFromJobStatus(job.status),
        startTime: job.startedAt || Date.now(),
        endTime: job.finishedAt || null,
        durationMs: job.startedAt && job.finishedAt ? job.finishedAt - job.startedAt : null,
        modelUsed: undefined, // Jobs don't typically have model info
      });
    }

    // Process builder runs
    for (const run of builderRuns) {
      entries.push({
        id: run.id,
        name: `Builder run ${run.id.substring(0, 8)}`,
        type: "builder",
        status: run.status === "success" ? "success" : 
                run.status === "failed" ? "failed" : "running",
        startTime: run.startedAt || Date.now(),
        endTime: run.finishedAt || null,
        durationMs: run.startedAt && run.finishedAt ? run.finishedAt - run.startedAt : null,
        modelUsed: undefined, // Could be extracted from passes if needed
      });
    }

    // Process autopipeline queue items
    for (const item of pipelineState.queue) {
      entries.push({
        id: item.id,
        name: item.slug ? `Pipeline: ${item.slug}` : `Pipeline item ${item.id.substring(0, 8)}`,
        type: "autopipeline",
        status: item.waitingApproval ? "pending" : 
                item.running ? "running" : "queued",
        startTime: item.createdAt || Date.now(),
        endTime: null,
        durationMs: null,
        modelUsed: undefined,
      });
    }

    // If there's a current running item in pipeline
    if (pipelineState.current) {
      entries.push({
        id: pipelineState.current.id,
        name: pipelineState.current.slug ? `Pipeline: ${pipelineState.current.slug}` : `Pipeline item ${pipelineState.current.id.substring(0, 8)}`,
        type: "autopipeline",
        status: "running",
        startTime: Date.now(),
        endTime: null,
        durationMs: null,
        modelUsed: undefined,
      });
    }

    // Sort by start time, newest first
    entries.sort((a, b) => (b.startTime - a.startTime));

    // Generate summary
    const summary = {
      newsbites: { success: 0, failed: 0, running: 0 },
      autopipeline: { success: 0, failed: 0, running: 0 },
      builder: { success: 0, failed: 0, running: 0 },
      agent: { success: 0, failed: 0, running: 0 },
      other: { success: 0, failed: 0, running: 0 },
    };

    for (const entry of entries) {
      const type = entry.type;
      if (entry.status === "success") summary[type].success++;
      else if (entry.status === "failed") summary[type].failed++;
      else summary[type].running++;
    }

    const data: WorkloadResponse = { entries, summary };
    const envelope: ApiEnvelope<WorkloadResponse> = ok(data);
    
    return new Response(JSON.stringify(envelope), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("workloadHandler failed:", error);
    return new Response(JSON.stringify({ error: "Failed to fetch workload data" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}