import { exec } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getVastInstanceState, type VastInstanceState } from "./vast.ts";

const execAsync = promisify(exec);

// Host-level stats sampled from the rented Vast machine over SSH. When no machine is
// rented the sampler must degrade honestly: an explicit "off" state, never fake
// metrics and never a failure alert for an operator choice.
export type VastHostSample = {
  status: "ok" | "off" | "unreachable" | "unknown";
  reason: string | null;
  cpuPct: number | null;
  ramPct: number | null;
  diskPct: number | null;
  gpuUtilPct: number | null;
  sampledAt: number;
};

// Resolved at call time (not module load) so tests can point it at a temp path.
function samplePath(): string {
  return process.env.VAST_HOST_SAMPLE_PATH || "/var/lib/control-surface/vast-host.json";
}
const SSH_KEY = process.env.VAST_SSH_KEY_PATH || "/root/.ssh/vast_gpu";
const SSH_TIMEOUT_MS = Number(process.env.VAST_HOST_SSH_TIMEOUT_MS) || 5000;

// One remote command that emits four lines: cpu busy %, ram used %, disk used %, gpu util %.
const REMOTE_PROBE = [
  "top -bn1 | awk -F'[ ,]+' '/%Cpu/ {print 100 - $8; exit}'",
  "free | awk '/Mem:/ {printf \"%.0f\\n\", $3/$2*100}'",
  "df / | awk 'NR==2 {gsub(\"%\",\"\",$5); print $5}'",
  "nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits | head -1",
].join("; ");

function parsePct(line: string | undefined): number | null {
  const value = Number((line ?? "").trim());
  return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

function persistSample(sample: VastHostSample): VastHostSample {
  try {
    mkdirSync(dirname(samplePath()), { recursive: true });
    const path = samplePath();
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(sample, null, 2));
    renameSync(tmpPath, path);
  } catch (error) {
    console.error("[vast-host] failed to persist sample", error);
  }
  return sample;
}

export function readVastHostSample(): VastHostSample | null {
  try {
    const raw = JSON.parse(readFileSync(samplePath(), "utf8")) as Partial<VastHostSample>;
    if (typeof raw.sampledAt !== "number" || typeof raw.status !== "string") return null;
    return {
      status: raw.status as VastHostSample["status"],
      reason: typeof raw.reason === "string" ? raw.reason : null,
      cpuPct: typeof raw.cpuPct === "number" ? raw.cpuPct : null,
      ramPct: typeof raw.ramPct === "number" ? raw.ramPct : null,
      diskPct: typeof raw.diskPct === "number" ? raw.diskPct : null,
      gpuUtilPct: typeof raw.gpuUtilPct === "number" ? raw.gpuUtilPct : null,
      sampledAt: raw.sampledAt,
    };
  } catch {
    return null;
  }
}

export async function sampleVastHost(stateOverride?: VastInstanceState): Promise<VastHostSample> {
  const state = stateOverride ?? await getVastInstanceState();
  const base = { cpuPct: null, ramPct: null, diskPct: null, gpuUtilPct: null, sampledAt: Date.now() };

  if (!state.known) {
    return persistSample({
      ...base,
      status: "unknown",
      reason: "Vast instance state could not be read (vastai CLI unavailable).",
    });
  }
  if (!state.instance) {
    return persistSample({
      ...base,
      status: "off",
      reason: "No Vast instance rented — GPU off by operator. Nothing to sample.",
    });
  }
  if (state.instance.status !== "running") {
    return persistSample({
      ...base,
      status: "off",
      reason: `Vast instance is ${state.instance.status} — GPU off by operator. Nothing to sample.`,
    });
  }
  if (!state.instance.ip || !state.instance.sshPort) {
    return persistSample({
      ...base,
      status: "unreachable",
      reason: "Vast instance is running but its SSH address is unknown.",
    });
  }

  try {
    const { stdout } = await execAsync(
      `ssh -i ${SSH_KEY} -p ${state.instance.sshPort} -o ConnectTimeout=4 -o BatchMode=yes ` +
      `-o StrictHostKeyChecking=accept-new root@${state.instance.ip} "${REMOTE_PROBE}"`,
      { timeout: SSH_TIMEOUT_MS },
    );
    const [cpu, ram, disk, gpu] = stdout.split("\n");
    return persistSample({
      status: "ok",
      reason: null,
      cpuPct: parsePct(cpu),
      ramPct: parsePct(ram),
      diskPct: parsePct(disk),
      gpuUtilPct: parsePct(gpu),
      sampledAt: Date.now(),
    });
  } catch (error) {
    return persistSample({
      ...base,
      status: "unreachable",
      reason: `SSH probe to the running Vast instance failed: ${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}`,
    });
  }
}
