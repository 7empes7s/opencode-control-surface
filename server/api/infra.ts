import { readFileSync } from "node:fs";
import { getServiceStatuses, getHetznerStats, getTimers } from "../adapters/system.ts";
import { getVastInstanceState, getVastAccount } from "../adapters/vast.ts";
import { readVastHostSample } from "../adapters/vastHost.ts";
import { ALLOWED_TIMERS } from "./actions.ts";
import { deriveGpuStatus } from "./home.ts";
import { ok, type ApiEnvelope, type InfraDetail } from "./types.ts";

const GPU_HEALTH_STALE_MS = Number(process.env.DASHBOARD_GPU_HEALTH_STALE_MS) || 15 * 60 * 1000;

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

async function settled<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export async function infraHandler(): Promise<Response> {
  const [hetzner, services, timers, vastState, vastAcct] = await Promise.all([
    settled(getHetznerStats),
    settled(getServiceStatuses),
    settled(getTimers),
    settled(getVastInstanceState),
    settled(getVastAccount),
  ]);

  const gpuRaw = readJson<{
    status?: string; gpu_max_util?: number; models?: string[]; checked_at?: number;
  }>("/var/lib/mimule/gpu-health.json");

  const vastHostSample = readVastHostSample();

  const h = hetzner ?? { load1: 0, load5: 0, load15: 0, memTotalKb: 0, memUsedKb: 0, memAvailableKb: 0, diskTotalGb: 0, diskUsedGb: 0, diskUsedPct: 0 };
  const memUsedPct = h.memTotalKb > 0 ? Math.round((h.memUsedKb / h.memTotalKb) * 100) : 0;

  const va = vastAcct;
  const vi = vastState?.instance ?? null;

  const gpuAgoMs = gpuRaw?.checked_at ? Date.now() - gpuRaw.checked_at * 1000 : Infinity;
  const gpuDerived = deriveGpuStatus({
    healthStatus: gpuRaw?.status ?? null,
    healthFresh: gpuAgoMs < GPU_HEALTH_STALE_MS,
    instanceKnown: vastState?.known ?? false,
    instanceStatus: vi?.status ?? null,
  });
  const gpuUtilRaw = gpuRaw?.gpu_max_util;
  const totalCredit = ((va?.balance ?? 0) + (va?.credit ?? 0));
  const hourly = vi?.hourlyRate ?? null;

  const data: InfraDetail = {
    hetzner: {
      load1: h.load1, load5: h.load5, load15: h.load15,
      memTotalKb: h.memTotalKb, memUsedKb: h.memUsedKb, memUsedPct,
      diskTotalGb: h.diskTotalGb, diskUsedGb: h.diskUsedGb, diskUsedPct: h.diskUsedPct,
    },
    vastInstance: vi ? {
      id: vi.id, status: vi.status, gpu: vi.gpu,
      vcpus: vi.vcpus, ramGb: vi.ram, diskGb: vi.disk,
      hourlyRate: vi.hourlyRate, ip: vi.ip, sshPort: vi.sshPort,
    } : null,
    vastBalance: va ? {
      balance: va.balance, credit: va.credit,
      runwayHours: hourly && totalCredit > 0 ? Math.round((totalCredit / hourly) * 10) / 10 : null,
    } : null,
    vastHost: vastHostSample,
    gpu: {
      status: gpuDerived.status,
      gpuUtil: gpuDerived.status === "up" && typeof gpuUtilRaw === "number" && gpuUtilRaw >= 0 ? gpuUtilRaw : null,
      loadedModels: gpuDerived.status === "up" ? gpuRaw?.models ?? [] : [],
      checkedAgo: gpuRaw?.checked_at ? Math.round(gpuAgoMs / 1000) : -1,
      note: gpuDerived.note,
    },
    services: services ?? [],
    timers: (timers ?? []).map((t) => ({ ...t, runnable: ALLOWED_TIMERS.includes(t.name) })),
  };

  const envelope: ApiEnvelope<InfraDetail> = ok(data, {
    hetzner: hetzner ? "ok" : "error",
    vast: ((vastState?.known ?? false) || va) ? "ok" : "error",
  });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
