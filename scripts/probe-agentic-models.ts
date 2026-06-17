#!/usr/bin/env bun
// Probe which models ACTUALLY drive agentic tool-calling (not just answer chat).
// ~95% of catalog models exit 0 but write nothing, or hang — so capability must be
// VERIFIED by a real file-write probe, never inferred from the model name.
//
// Output: /var/lib/control-surface/agentic-models.json — verified models grouped by tier,
// ordered free-first then by provider reliability. Consumed by the builder to populate
// agentOrder + fallbackTargets so a run cascades through real, working models.
//
// Run: bun run scripts/probe-agentic-models.ts [--limit N] [--timeout 45]

import { spawnSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BUILDER_XDG = "/var/lib/control-surface/opencode-builder";
const OUT = "/var/lib/control-surface/agentic-models.json";
const PROBE_TIMEOUT_S = Number(process.argv.find((a, i) => process.argv[i - 1] === "--timeout") ?? 45);
const LIMIT = Number(process.argv.find((a, i) => process.argv[i - 1] === "--limit") ?? 0) || Infinity;

// Models worth probing for agentic CODE building (auto-discovered from the live catalog).
const CANDIDATE = /gpt-oss|qwen.*(coder|next|plus|max|235b|32b)|minimax|nemotron|deepseek-v4|glm-5|kimi-k2|codestral|mistral-large|llama-(3\.3|4)|command-?r/i;
// Tiers by capability for building a full app.
function tierFor(id: string): "heavy" | "medium" {
  return /120b|235b|480b|max|coder|next-80b|pro|large|kimi-k2|glm-5|deepseek-v4-pro|minimax-m[23]/i.test(id) ? "heavy" : "medium";
}
// Lower = tried first. Free first; paid last; rate-limited (groq) mid.
function providerRank(id: string): number {
  if (/:free|-free\b|nemotron-3-ultra-free/i.test(id)) return 0;
  if (/^opencode\//i.test(id)) return 1;
  if (/^opencode-go\//i.test(id)) return 2;
  if (/^groq\//i.test(id)) return 3;
  if (/paid|cerebras-paid/i.test(id)) return 5;
  return 4;
}

function listCandidates(): string[] {
  let out = "";
  try { out = execSync("timeout 15 opencode models", { encoding: "utf8" }); } catch (e: any) { out = e.stdout ?? ""; }
  const models = out.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^(Available|Model|Total|---|\d)/i.test(l) && l.includes("/"))
    .filter((l) => CANDIDATE.test(l));
  return [...new Set(models)];
}

function probe(model: string): { verified: boolean; latencyMs: number | null; note: string } {
  const dir = mkdtempSync(join(tmpdir(), "agprobe-"));
  const marker = `AGOK_${Math.random().toString(36).slice(2, 8)}`;
  const started = Date.now();
  try {
    const r = spawnSync("/bin/bash", ["-c",
      `XDG_CONFIG_HOME=${BUILDER_XDG} timeout ${PROBE_TIMEOUT_S} opencode run --dir ${dir} --dangerously-skip-permissions --model ${model} ` +
      `"Create a file named probe.txt containing exactly ${marker} using your write tool, then stop." 2>&1`,
    ], { encoding: "utf8", timeout: (PROBE_TIMEOUT_S + 10) * 1000, maxBuffer: 8 * 1024 * 1024 });
    const latencyMs = Date.now() - started;
    const f = join(dir, "probe.txt");
    const wrote = existsSync(f) && readFileSync(f, "utf8").includes(marker);
    const timedOut = r.status === 124 || r.signal === "SIGTERM";
    const note = wrote ? "wrote file" : timedOut ? "timeout/hang" : (r.status === 0 ? "exit0 no-write (liar)" : `exit ${r.status}`);
    return { verified: wrote, latencyMs: wrote ? latencyMs : null, note };
  } catch (e: any) {
    return { verified: false, latencyMs: null, note: e?.message?.slice(0, 60) ?? "error" };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

const candidates = listCandidates().slice(0, LIMIT === Infinity ? undefined : LIMIT);
console.log(`probing ${candidates.length} candidate models (timeout ${PROBE_TIMEOUT_S}s each)...`);
const results: Array<{ id: string; provider: string; tier: string; verified: boolean; latencyMs: number | null; note: string }> = [];
for (const id of candidates) {
  const { verified, latencyMs, note } = probe(id);
  const provider = id.split("/")[0];
  results.push({ id, provider, tier: tierFor(id), verified, latencyMs, note });
  console.log(`  ${verified ? "✓" : "✗"} ${id.padEnd(52)} ${note}${latencyMs ? ` (${latencyMs}ms)` : ""}`);
}

const verified = results.filter((r) => r.verified);
// Capability-first (heavy before medium), then free-first, then fastest — so the strongest
// proven model leads and the group cascades to lighter/other-provider models.
const order = (a: typeof results[0], b: typeof results[0]) =>
  (a.tier === "heavy" ? 0 : 1) - (b.tier === "heavy" ? 0 : 1) ||
  providerRank(a.id) - providerRank(b.id) ||
  (a.latencyMs ?? 9e9) - (b.latencyMs ?? 9e9);
const all = verified.slice().sort(order).map((r) => r.id);
const heavyOnly = verified.filter((r) => r.tier === "heavy").sort(order).map((r) => r.id);
// agentic-heavy is the builder's default group: prefer heavy models, but if there are fewer
// than 2 proven heavy models, include all verified so the cascade still has real depth.
const heavy = heavyOnly.length >= 2 ? heavyOnly : all;

const roster = {
  generatedAt: new Date().toISOString(),
  probeTimeoutS: PROBE_TIMEOUT_S,
  counts: { candidates: candidates.length, verified: verified.length },
  groups: {
    "agentic-heavy": heavy.length ? heavy : all, // fall back to all verified if no heavy
    "agentic-all": all,
  },
  models: results,
};
writeFileSync(OUT, JSON.stringify(roster, null, 2));
console.log(`\n${verified.length}/${candidates.length} verified agentic-capable. wrote ${OUT}`);
console.log(`agentic-heavy group: ${JSON.stringify(roster.groups["agentic-heavy"])}`);
