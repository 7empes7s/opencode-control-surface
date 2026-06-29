import { readFileSync } from "node:fs";
import { getServiceStatuses, getHetznerStats, getTimers } from "../adapters/system.ts";
import { getVastInstance, getVastAccount } from "../adapters/vast.ts";
import { ALLOWED_TIMERS } from "./actions.ts";
import { ok, type ApiEnvelope, type InfraDetail } from "./types.ts";

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, "utf8")) as T; }
  catch { return null; }
}

async function settled<T>(fn: () => Promise<T> | T): Promise<T | null> {
  try { return await fn(); } catch { return null; }
}

export async function infraHandler(): Promise<Response> {
  const [hetzner, services, timers, vastInst, vastAcct] = await Promise.all([
    settled(getHetznerStats),
    settled(getServiceStatuses),
    settled(getTimers),
    settled(getVastInstance),
    settled(getVastAccount),
  ]);

  const gpuRaw = readJson<{
    status?: string; gpu_max_util?: number; models?: string[]; checked_at?: number;
  }>("/var/lib/mimule/gpu-health.json");

  const vastHostRaw = readJson<{
    cpuPct?: number; ramPct?: number; diskPct?: number; gpuUtilPct?: number; sampledAt?: number;
  }>("/var/lib/mimule/vast-host.json");

  const h = hetzner ?? { load1: 0, load5: 0, load15: 0, memTotalKb: 0, memUsedKb: 0, memAvailableKb: 0, diskTotalGb: 0, diskUsedGb: 0, diskUsedPct: 0 };
  const memUsedPct = h.memTotalKb > 0 ? Math.round((h.memUsedKb / h.memTotalKb) * 100) : 0;

  const va = vastAcct;
  const vi = vastInst;
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
    vastHost: vastHostRaw ? {
      cpuPct: vastHostRaw.cpuPct ?? 0,
      ramPct: vastHostRaw.ramPct ?? 0,
      diskPct: vastHostRaw.diskPct ?? 0,
      gpuUtilPct: vastHostRaw.gpuUtilPct ?? 0,
      sampledAt: vastHostRaw.sampledAt ?? 0,
    } : null,
    gpu: {
      status: gpuRaw?.status === "up" ? "up" : gpuRaw?.status === "down" ? "down" : "unknown",
      gpuUtil: gpuRaw?.gpu_max_util ?? null,
      loadedModels: gpuRaw?.models ?? [],
      checkedAgo: gpuRaw?.checked_at ? Math.round((Date.now() - gpuRaw.checked_at * 1000) / 1000) : -1,
    },
    services: services ?? [],
    timers: (timers ?? []).map((t) => ({ ...t, runnable: ALLOWED_TIMERS.includes(t.name) })),
  };

  const envelope: ApiEnvelope<InfraDetail> = ok(data, {
    hetzner: hetzner ? "ok" : "error",
    vast: (vi || va) ? "ok" : "error",
  });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
