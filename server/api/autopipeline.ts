import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getPipelineState } from "../adapters/pipeline.ts";
import { ok, type ApiEnvelope, type AutopipelineDetail } from "./types.ts";

const DOSSIERS_ROOT = "/opt/mimoun/openclaw-config/workspace/newsbites_editorial/dossiers";
const STAGES = ["scout", "research", "write", "verify", "publish-prep", "publish"];

function computeStageDurations(): AutopipelineDetail["stageDurations"] {
  const stageSamples: Record<string, number[]> = {};
  try {
    const dateDirs = readdirSync(DOSSIERS_ROOT);
    for (const dateDir of dateDirs) {
      try {
        const slugDirs = readdirSync(join(DOSSIERS_ROOT, dateDir));
        for (const slug of slugDirs) {
          const base = join(DOSSIERS_ROOT, dateDir, slug);
          try {
            const dossierStat = statSync(join(base, "DOSSIER.md"));
            const publishStat = statSync(join(base, "publish.md"));
            const totalMs = publishStat.mtimeMs - dossierStat.mtimeMs;
            if (totalMs > 0 && totalMs < 24 * 60 * 60 * 1000) {
              const perStage = totalMs / 3; // rough split across 3 main stages
              const stages = ["research", "write", "publish-prep"];
              for (const s of stages) {
                stageSamples[s] = stageSamples[s] ?? [];
                stageSamples[s].push(perStage);
              }
            }
          } catch {}
        }
      } catch {}
    }
  } catch {}

  return STAGES.map((stage) => {
    const samples = (stageSamples[stage] ?? []).sort((a, b) => a - b);
    if (samples.length === 0) return { stage, p50Ms: 0, p95Ms: 0, sampleCount: 0 };
    const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? 0;
    return { stage, p50Ms: Math.round(p50), p95Ms: Math.round(p95), sampleCount: samples.length };
  });
}

export async function autopipelineHandler(): Promise<Response> {
  const pipeline = await getPipelineState();
  const now = Date.now();

  const stageBreakdown: Record<string, number> = {};
  let approvalsWaiting = 0;
  let oldestApprovalMs: number | null = null;

  const queue = pipeline.queue.map((item) => {
    stageBreakdown[item.stage] = (stageBreakdown[item.stage] ?? 0) + 1;
    if (item.waitingApproval) {
      approvalsWaiting++;
      const age = item.createdAt ? now - item.createdAt : 0;
      if (oldestApprovalMs === null || age > oldestApprovalMs) oldestApprovalMs = age;
    }
    let dossierDate: string | undefined;
    let dossierSlug: string | undefined;
    if (item.slug) {
      dossierSlug = item.slug;
      const tsMatch = item.id.match(/^story-(\d{13})-/);
      if (tsMatch) {
        const unixSec = Math.floor(Number(tsMatch[1]) / 1000);
        const d = new Date(unixSec * 1000);
        dossierDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      }
    }
    return {
      id: item.id,
      slug: item.slug,
      stage: item.stage,
      priority: item.priority,
      waitingApproval: item.waitingApproval,
      running: item.running ?? false,
      createdAt: item.createdAt,
      elapsedMs: item.createdAt ? now - item.createdAt : undefined,
      dossierDate,
      dossierSlug,
    };
  });

  const data: AutopipelineDetail = {
    queue,
    current: pipeline.current,
    paused: pipeline.paused,
    pauseReason: pipeline.pauseReason,
    stats: {
      queueDepth: queue.length,
      approvalsWaiting,
      oldestApprovalAgeMs: oldestApprovalMs,
      stageBreakdown,
    },
    stageDurations: computeStageDurations(),
  };

  const envelope: ApiEnvelope<AutopipelineDetail> = ok(data, { pipeline: "ok" });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
