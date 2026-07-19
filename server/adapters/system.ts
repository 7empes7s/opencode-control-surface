import { execSync } from "node:child_process";
import { discoverSystemdUnits, discoverContainers } from "../discovery/reconcile.ts";

export interface ServicePill {
  name: string;
  status: "active" | "inactive" | "failed" | "unknown";
}

// Seed hints — always surfaced even if momentarily down or not discovered.
const CRITICAL_SERVICES_SEEDS = [
  "newsbites",
  "newsbites-autopipeline",
  "litellm",
  "opencode-server",
  "control-surface",
  "vast-tunnel",
  "cloudflared",
  "know-web",
  "know-health",
  "know-ops",
  "know-doctor",
];

const DOCKER_CONTAINERS_SEEDS = ["openclaw_gateway", "paperclip", "paperclip_db", "goblin_game"];

function probe(name: string, args: string[], timeoutMs = 5000): string {
  try {
    return execSync(`${name} ${args.join(" ")}`, { encoding: "utf8", timeout: timeoutMs });
  } catch {
    return "";
  }
}

// Fresh-host honesty: `probe()` swallows every failure (including "binary not
// found"), so a host with no systemd/docker at all looks identical to "every
// seeded unit came back unknown". Distinguishing those matters -- on a host
// with no systemctl/docker present, report an empty list rather than N pills
// bearing hardcoded MIMULE service/container names. `command -v` itself never
// throws (it just exits non-zero), so this check is cheap and side-effect free.
function toolAvailable(name: string): boolean {
  try {
    execSync(`command -v ${name}`, { encoding: "utf8", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

function buildServiceNames(): string[] {
  const names = new Set<string>(CRITICAL_SERVICES_SEEDS);
  // Live discovery — fail-isolated; falls back to seeds only on error.
  try {
    for (const asset of discoverSystemdUnits()) {
      const stripped = asset.signature.replace(/\.service$/, "");
      names.add(stripped);
    }
  } catch {}
  return Array.from(names);
}

function buildContainerNames(): string[] {
  const names = new Set<string>(DOCKER_CONTAINERS_SEEDS);
  // Live discovery — fail-isolated.
  try {
    for (const asset of discoverContainers()) {
      const fp = asset.fingerprint;
      const n = typeof fp.name === "string" && fp.name ? fp.name : null;
      if (n) names.add(n);
    }
  } catch {}
  return Array.from(names);
}

export function getServiceStatuses(): ServicePill[] {
  const results: ServicePill[] = [];
  const serviceNames = buildServiceNames();

  if (serviceNames.length > 0 && toolAvailable("systemctl")) {
    const raw = probe("systemctl", ["is-active", ...serviceNames, "2>/dev/null", "||", "true"]);
    const statuses = raw.trim().split("\n");
    for (let i = 0; i < serviceNames.length; i++) {
      const s = (statuses[i] || "unknown").trim();
      results.push({
        name: serviceNames[i],
        status: s === "active" ? "active" : s === "failed" ? "failed" : s === "inactive" ? "inactive" : "unknown",
      });
    }
  }

  const containerNames = buildContainerNames();
  if (containerNames.length > 0 && toolAvailable("docker")) {
    const raw = probe(
      "docker",
      ["inspect", "--format='{{.Name}} {{.State.Status}}'", ...containerNames, "2>/dev/null", "||", "true"],
    );
    const seen = new Set<string>();
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      const parts = line.trim().split(/\s+/);
      const name = parts[0].replace(/^\//, "").replace(/^'/, "");
      const status = parts[1]?.replace(/'$/, "") || "unknown";
      seen.add(name);
      results.push({
        name,
        status: status === "running" ? "active" : status === "exited" ? "inactive" : "unknown",
      });
    }
    // Surface seed containers even if docker inspect returned nothing for them.
    for (const name of containerNames) {
      if (!seen.has(name)) {
        results.push({ name, status: "unknown" });
      }
    }
  }

  return results;
}

export interface HetznerStats {
  load1: number;
  load5: number;
  load15: number;
  memTotalKb: number;
  memUsedKb: number;
  memAvailableKb: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskUsedPct: number;
}

export function getHetznerStats(): HetznerStats {
  let load1 = 0, load5 = 0, load15 = 0;
  try {
    const raw = execSync("cat /proc/loadavg", { encoding: "utf8", timeout: 2000 });
    const parts = raw.trim().split(/\s+/);
    load1 = parseFloat(parts[0]) || 0;
    load5 = parseFloat(parts[1]) || 0;
    load15 = parseFloat(parts[2]) || 0;
  } catch {}

  let memTotalKb = 0, memUsedKb = 0, memAvailableKb = 0;
  try {
    const raw = execSync("cat /proc/meminfo", { encoding: "utf8", timeout: 2000 });
    for (const line of raw.split("\n")) {
      if (line.startsWith("MemTotal:")) memTotalKb = parseInt(line.split(/\s+/)[1]) || 0;
      if (line.startsWith("MemAvailable:")) memAvailableKb = parseInt(line.split(/\s+/)[1]) || 0;
    }
    memUsedKb = memTotalKb - memAvailableKb;
  } catch {}

  let diskTotalGb = 0, diskUsedGb = 0, diskUsedPct = 0;
  try {
    const raw = execSync("df -BG / | tail -1", { encoding: "utf8", timeout: 2000 });
    const parts = raw.trim().split(/\s+/);
    diskTotalGb = parseInt(parts[1]) || 0;
    diskUsedGb = parseInt(parts[2]) || 0;
    diskUsedPct = parseInt(parts[4]) || 0;
  } catch {}

  return { load1, load5, load15, memTotalKb, memUsedKb, memAvailableKb, diskTotalGb, diskUsedGb, diskUsedPct };
}

export interface TimerInfo {
  name: string;
  active: boolean;
  lastTrigger: string | null;
  nextElapse: string | null;
  lastResult: string | null;
}

// Seed hints for timers.
const KNOWN_TIMERS_SEEDS = [
  "model-health-check",
  "paperclip-action-notify",
  "newsbites-agent-watch",
  "newsbites-brief",
  "morning-brief",
  "mimule-backup",
  "vast-watchdog",
  "know-health",
  "know-ops",
  "know-doctor",
  "know-push-streak",
];

function buildTimerNames(): string[] {
  const names = new Set<string>(KNOWN_TIMERS_SEEDS);
  // Live discovery via systemctl.
  try {
    const raw = execSync("systemctl list-units --type=timer --all --no-legend --no-pager 2>/dev/null || true", {
      encoding: "utf8",
      timeout: 5000,
    });
    for (const line of raw.split("\n")) {
      const match = line.trim().match(/^(\S+\.timer)\s/);
      if (match) names.add(match[1].replace(/\.timer$/, ""));
    }
  } catch {}
  return Array.from(names);
}

export function getTimers(): TimerInfo[] {
  if (!toolAvailable("systemctl")) return [];
  return buildTimerNames().map((name) => {
    const timerUnit = `${name}.timer`;
    try {
      const raw = execSync(
        `systemctl show ${timerUnit} --property=ActiveState,LastTriggerUSec,NextElapseUSecRealtime,Result 2>/dev/null || true`,
        { encoding: "utf8", timeout: 3000 }
      );
      const props: Record<string, string> = {};
      for (const line of raw.trim().split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
      }
      return {
        name,
        active: props.ActiveState === "active",
        lastTrigger: props.LastTriggerUSec && props.LastTriggerUSec !== "n/a" ? props.LastTriggerUSec : null,
        nextElapse: props.NextElapseUSecRealtime && props.NextElapseUSecRealtime !== "n/a" ? props.NextElapseUSecRealtime : null,
        lastResult: props.Result ?? null,
      };
    } catch {
      return { name, active: false, lastTrigger: null, nextElapse: null, lastResult: null };
    }
  });
}
