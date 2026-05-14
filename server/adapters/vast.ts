import { exec } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";

const execAsync = promisify(exec);
const STRIP_ANSI = /\x1b\[[0-9;]*m/g;
const GPU_HEALTH_PATH = "/var/lib/mimule/gpu-health.json";
const CACHE_TTL_MS = 60_000;

export interface VastInstance {
  id: string;
  status: string;
  gpu: string;
  vcpus: number;
  ram: number;
  disk: number;
  gpuRam: number;
  hourlyRate: number;
  ip: string;
  sshPort: number;
  machineId: string;
  uptime: number;
  gpuUtil: number;
}

export interface VastAccount {
  balance: number;
  credit: number;
  email: string;
  userId: string;
}

let instanceCache: { value: VastInstance | null; ts: number } | null = null;
let instanceInFlight: Promise<VastInstance | null> | null = null;
let accountCache: { value: VastAccount | null; ts: number } | null = null;
let accountInFlight: Promise<VastAccount | null> | null = null;

function fresh<T>(cache: { value: T; ts: number } | null): T | null {
  if (!cache) return null;
  return Date.now() - cache.ts < CACHE_TTL_MS ? cache.value : null;
}

// vastai show instances returns 3 multi-line rows per instance:
//  Row A: # ID  Machine  Status   Num  Model  Util.%  vCPUs  RAM  Storage
//  Row B: # SSH_Addr  SSH_Port  $/hr  Image  Net_up
//  Row C: # Net_down  R  Label  age(h)  uptime(m)
export async function getVastInstance(): Promise<VastInstance | null> {
  const cached = fresh(instanceCache);
  if (cached !== null || (instanceCache && Date.now() - instanceCache.ts < CACHE_TTL_MS)) {
    return instanceCache.value;
  }
  if (instanceInFlight) return instanceInFlight;

  instanceInFlight = readVastInstance();
  try {
    const value = await instanceInFlight;
    instanceCache = { value, ts: Date.now() };
    return value;
  } finally {
    instanceInFlight = null;
  }
}

async function readVastInstance(): Promise<VastInstance | null> {
  try {
    const { stdout } = await execAsync("vastai show instances", { timeout: 2000 });
    const lines = stdout.split("\n").map((l) => l.replace(STRIP_ANSI, "").trim()).filter(Boolean);

    let rowA: string[] | null = null;
    let rowB: string[] | null = null;

    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;

      // Row A: contains "running" or "stopped" at index 3
      if (parts[3] === "running" || parts[3] === "stopped") {
        rowA = parts;
      }
      // Row B: contains a $/hr value at index 3 (a decimal number like 0.1378)
      // and SSH addr at index 1 (contains "." or "ssh")
      if (rowA && parts[0] === rowA[0] && /^\d+\.\d+$/.test(parts[3])) {
        rowB = parts;
      }
    }

    if (!rowA) return null;

    return {
      id: rowA[1] ?? "",
      status: rowA[3] ?? "unknown",
      gpu: rowA[5] ?? "",
      vcpus: parseFloat(rowA[7] ?? "0") || 0,
      ram: parseFloat(rowA[8] ?? "0") || 0,
      disk: parseFloat(rowA[9] ?? "0") || 0,
      gpuRam: 24,
      hourlyRate: rowB ? parseFloat(rowB[3] ?? "0") || 0 : 0,
      ip: rowB ? rowB[1] ?? "" : "",
      sshPort: rowB ? parseInt(rowB[2] ?? "0") || 0 : 0,
      machineId: rowA[2] ?? "",
      uptime: 0,
      gpuUtil: 0,
    };
  } catch {
    return null;
  }
}

// vastai show user returns 400 with newer CLI — use the REST API directly
export async function getVastAccount(): Promise<VastAccount | null> {
  const cached = fresh(accountCache);
  if (cached !== null || (accountCache && Date.now() - accountCache.ts < CACHE_TTL_MS)) {
    return accountCache.value;
  }
  if (accountInFlight) return accountInFlight;

  accountInFlight = readVastAccount();
  try {
    const value = await accountInFlight;
    accountCache = { value, ts: Date.now() };
    return value;
  } finally {
    accountInFlight = null;
  }
}

async function readVastAccount(): Promise<VastAccount | null> {
  try {
    const apiKey = readFileSync("/root/.config/vastai/vast_api_key", "utf8").trim();
    const res = await fetch(
      `https://console.vast.ai/api/v0/users/current/?api_key=${apiKey}`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) return null;
    const json = await res.json() as {
      balance?: number; credit?: number; username?: string; id?: number;
    };
    const balance = json.balance ?? 0;
    const credit = json.credit ?? 0;
    return { balance, credit, email: json.username ?? "", userId: String(json.id ?? "") };
  } catch {
    return null;
  }
}

// GPU util comes from the watchdog-written gpu-health.json — faster than SSH
export function getGpuUtilFromHealth(): number | null {
  try {
    const raw = JSON.parse(readFileSync(GPU_HEALTH_PATH, "utf8")) as { gpu_max_util?: number };
    return raw.gpu_max_util ?? null;
  } catch {
    return null;
  }
}
