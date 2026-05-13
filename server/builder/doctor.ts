import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import type { BuilderWorkflow, BuilderWorkflowMode } from "./store.ts";
import { readBuilderArtifacts } from "./store.ts";
import { createBuilderArtifact } from "./runner.ts";

const BUILDER_RUNS_DIR = "/var/lib/control-surface/builder-runs";

export interface DoctorReviewProfile {
  codeReview: {
    enabled: boolean;
    targets: string[];
    exclude: string[];
    model: string;
  };
  accessibility: {
    enabled: boolean;
    urls: string[];
  };
  performance: {
    enabled: boolean;
    urls: string[];
    metrics: ("lcp" | "cls" | "fid" | "ttfb")[];
  };
  security: {
    enabled: boolean;
    checks: ("headers" | "cookies" | "xss" | "ssl")[];
    urls: string[];
  };
  runtime: {
    enabled: boolean;
    endpoints: string[];
  };
}

export interface DoctorReport {
  id: string;
  workflowId: string;
  runId: string;
  passId: string | null;
  createdAt: number;
  projectRoot: string;
  planFile: string;
  codeReview: {
    changedFiles: number;
    issues: { severity: "info" | "warning" | "error"; file: string; line?: number; message: string }[];
    score: number;
  } | null;
  accessibility: { url: string; score: number; issues: string[] }[] | null;
  performance: { url: string; metrics: Record<string, number>; score: number }[] | null;
  security: { check: string; passed: boolean; details: string }[] | null;
  runtime: { endpoint: string; statusCode: number; ok: boolean }[] | null;
  overallScore: number;
  verdict: "ready" | "needs-work" | "degraded";
  evidence: { label: string; kind: string; ref: string }[];
}

function ensureRunsDir(): void {
  if (!existsSync(BUILDER_RUNS_DIR)) {
    mkdirSync(BUILDER_RUNS_DIR, { recursive: true });
  }
}

function runDir(runId: string): string {
  return join(BUILDER_RUNS_DIR, runId);
}

export function buildDoctorReviewProfile(workflow: BuilderWorkflow): DoctorReviewProfile {
  const config = workflow.config;
  return {
    codeReview: {
      enabled: true,
      targets: ["**/*.ts", "**/*.tsx", "**/*.css"],
      exclude: ["node_modules", "dist", ".next"],
      model: config.modelPolicy.reviewer ?? "",
    },
    accessibility: {
      enabled: true,
      urls: config.validationProfile.publicUrl
        ? [config.validationProfile.publicUrl]
        : config.validationProfile.internalUrl
          ? [config.validationProfile.internalUrl]
          : [],
    },
    performance: {
      enabled: true,
      urls: config.validationProfile.publicUrl
        ? [config.validationProfile.publicUrl]
        : config.validationProfile.internalUrl
          ? [config.validationProfile.internalUrl]
          : [],
      metrics: ["lcp", "cls", "ttfb"],
    },
    security: {
      enabled: true,
      checks: ["headers", "ssl"],
      urls: config.validationProfile.publicUrl
        ? [config.validationProfile.publicUrl]
        : config.validationProfile.internalUrl
          ? [config.validationProfile.internalUrl]
          : [],
    },
    runtime: {
      enabled: true,
      endpoints: config.validationProfile.internal
        .filter((cmd) => cmd.startsWith("curl") || cmd.startsWith("http"))
        .slice(0, 5),
    },
  };
}

async function runCodeReview(
  projectRoot: string,
  profile: DoctorReviewProfile,
  runId: string,
): Promise<{ changedFiles: number; issues: { severity: "info" | "warning" | "error"; file: string; line?: number; message: string }[]; score: number }> {
  const runDirPath = runDir(runId);
  const patchPath = join(runDirPath, "pre-pass.patch");

  if (!existsSync(patchPath)) {
    return { changedFiles: 0, issues: [], score: 100 };
  }

  const patchContent = readFileSync(patchPath, "utf8");
  const changedFiles = (patchContent.match(/^diff --git/gm) ?? []).length;

  if (changedFiles === 0) {
    return { changedFiles: 0, issues: [], score: 100 };
  }

  const prompt = `You are a code reviewer. Analyze the following git diff and provide a structured JSON list of issues found. Focus on:
- Potential bugs and logic errors
- Security concerns (hardcoded secrets, SQL injection, XSS)
- Code quality issues (unused imports, TODO comments, complex code)
- TypeScript/Type safety issues

Respond ONLY with a JSON array in this exact format (no other text):
[
  {"severity": "error|warning|info", "file": "path/to/file.ts", "line": 123, "message": "description of issue"}
]

Diff:
${patchContent.slice(0, 8000)}`;

  const issues: { severity: "info" | "warning" | "error"; file: string; line?: number; message: string }[] = [];

  try {
    const result = spawnSync("curl", [
      "-s", "http://127.0.0.1:4000/v1/chat/completions",
      "-H", "Content-Type: application/json",
      "-d", JSON.stringify({
        model: profile.codeReview.model || "gemma4:26b",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2000,
        temperature: 0.2,
      }),
    ], { encoding: "utf8", timeout: 60000 });

    if (result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout);
        const content = parsed.choices?.[0]?.message?.content ?? "";
        const jsonMatch = content.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          const parsedIssues = JSON.parse(jsonMatch[0]);
          if (Array.isArray(parsedIssues)) {
            issues.push(...parsedIssues);
          }
        }
      } catch {
        // Failed to parse, ignore
      }
    }
  } catch {
    // Code review failed, continue without issues
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const score = Math.max(0, 100 - errorCount * 10 - warningCount * 3);

  return { changedFiles, issues, score };
}

async function runAccessibilityCheck(
  urls: string[],
): Promise<{ url: string; score: number; issues: string[] }[]> {
  const results: { url: string; score: number; issues: string[] }[] = [];

  for (const url of urls) {
    const issues: string[] = [];
    let score = 100;

    try {
      const script = `
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
const issues = [];
try {
  await page.goto('${url}', { timeout: 15000, waitUntil: 'networkidle' });
  const contrast = await page.evaluate(() => {
    const elements = document.querySelectorAll('*');
    let lowContrast = 0;
    for (const el of elements) {
      const style = window.getComputedStyle(el);
      if (style.color && style.backgroundColor) {
        // Simplified check
        if (style.color === style.backgroundColor) lowContrast++;
      }
    }
    return lowContrast;
  });
  if (contrast > 10) issues.push('Low color contrast detected');
  const smallTouch = await page.evaluate(() => {
    const elements = document.querySelectorAll('button, a, input');
    let count = 0;
    for (const el of elements) {
      const rect = el.getBoundingClientRect();
      if (rect.width < 44 || rect.height < 44) count++;
    }
    return count;
  });
  if (smallTouch > 0) issues.push(\`\${smallTouch} small touch targets (<44px)\`);
  const noAlt = await page.evaluate(() => {
    return document.querySelectorAll('img:not([alt])').length;
  });
  if (noAlt > 0) issues.push(\`\${noAlt} images missing alt attributes\`);
} catch (e) {
  issues.push(\`Page error: \${e.message}\`);
}
await browser.close();
console.log(JSON.stringify({ issues, score: Math.max(0, 100 - issues.length * 10) }));
      `.trim();

      const tempScript = `/tmp/accessibility-${randomUUID()}.mjs`;
      writeFileSync(tempScript, script);

      const result = spawnSync("node", [tempScript], { encoding: "utf8", timeout: 30000 });
      if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          issues.push(...parsed.issues);
          score = parsed.score;
        } catch {
          // ignore parse errors
        }
      }
    } catch {
      issues.push("Accessibility check failed");
      score = 50;
    }

    results.push({ url, score, issues });
  }

  return results;
}

async function runPerformanceCheck(
  urls: string[],
): Promise<{ url: string; metrics: Record<string, number>; score: number }[]> {
  const results: { url: string; metrics: Record<string, number>; score: number }[] = [];

  for (const url of urls) {
    const metrics: Record<string, number> = {};
    let score = 100;

    try {
      const script = `
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage();
try {
  const start = Date.now();
  await page.goto('${url}', { timeout: 15000, waitUntil: 'networkidle' });
  metrics.ttfb = Date.now() - start;
  const lcp = await page.evaluate(() => {
    return new Promise((resolve) => {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1] as any;
        resolve(last.renderTime || last.loadTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
      setTimeout(() => resolve(0), 5000);
    });
  });
  metrics.lcp = lcp || 0;
  const cls = await page.evaluate(() => {
    return (performance as any).getEntriesByType('layout-shift')?.reduce((sum: number, e: any) => sum + (e.value || 0), 0) || 0;
  });
  metrics.cls = cls;
} catch (e) {
  metrics.error = 1;
}
await browser.close();
console.log(JSON.stringify({ metrics, score: metrics.error ? 50 : Math.max(0, 100 - (metrics.lcp > 2500 ? 20 : 0) - (metrics.cls > 0.1 ? 20 : 0)) }));
      `.trim();

      const tempScript = `/tmp/performance-${randomUUID()}.mjs`;
      writeFileSync(tempScript, script);

      const result = spawnSync("node", [tempScript], { encoding: "utf8", timeout: 30000 });
      if (result.stdout) {
        try {
          const parsed = JSON.parse(result.stdout.trim());
          Object.assign(metrics, parsed.metrics);
          score = parsed.score;
        } catch {
          // ignore
        }
      }
    } catch {
      metrics.error = 1;
      score = 50;
    }

    results.push({ url, metrics, score });
  }

  return results;
}

async function runSecurityCheck(
  urls: string[],
  checks: ("headers" | "cookies" | "xss" | "ssl")[],
): Promise<{ check: string; passed: boolean; details: string }[]> {
  const results: { check: string; passed: boolean; details: string }[] = [];

  for (const url of urls) {
    if (checks.includes("headers")) {
      try {
        const result = spawnSync("curl", ["-s", "-I", "-D-", "-o", "/dev/null", "-w", "%{http_code}", url], {
          encoding: "utf8",
          timeout: 10000,
        });
        const headers = result.stderr ?? "";
        const missing: string[] = [];
        if (!headers.includes("Content-Security-Policy:")) missing.push("CSP");
        if (!headers.includes("X-Frame-Options:")) missing.push("X-Frame-Options");
        if (!headers.includes("Strict-Transport-Security:")) missing.push("HSTS");
        if (!headers.includes("X-Content-Type-Options:")) missing.push("X-Content-Type-Options");
        results.push({
          check: "security-headers",
          passed: missing.length === 0,
          details: missing.length > 0 ? `Missing: ${missing.join(", ")}` : "All security headers present",
        });
      } catch (e) {
        results.push({ check: "security-headers", passed: false, details: "Check failed" });
      }
    }

    if (checks.includes("ssl")) {
      try {
        const httpsUrl = url.replace(/^http:/, "https:");
        const result = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{ssl_verify_result}", httpsUrl], {
          encoding: "utf8",
          timeout: 10000,
        });
        const verifyResult = parseInt(result.stdout?.trim() ?? "999", 10);
        results.push({ check: "ssl", passed: verifyResult === 0, details: verifyResult === 0 ? "SSL valid" : `SSL error: ${verifyResult}` });
      } catch {
        results.push({ check: "ssl", passed: false, details: "SSL check failed" });
      }
    }
  }

  return results;
}

async function runRuntimeCheck(
  endpoints: string[],
): Promise<{ endpoint: string; statusCode: number; ok: boolean }[]> {
  const results: { endpoint: string; statusCode: number; ok: boolean }[] = [];

  for (const endpoint of endpoints) {
    let url = endpoint;
    if (!endpoint.startsWith("http")) {
      url = `http://127.0.0.1:3000${endpoint}`;
    }

    try {
      const result = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", "-m", "10", url], {
        encoding: "utf8",
        timeout: 15000,
      });
      const statusCode = parseInt(result.stdout?.trim() ?? "000", 10);
      results.push({ endpoint, statusCode, ok: statusCode >= 200 && statusCode < 400 });
    } catch {
      results.push({ endpoint, statusCode: 0, ok: false });
    }
  }

  return results;
}

export async function runDoctorReview(
  workflow: BuilderWorkflow,
  runId: string,
  passId: string | null,
): Promise<DoctorReport> {
  const profile = buildDoctorReviewProfile(workflow);
  const projectRoot = workflow.projectRoot;

  ensureRunsDir();
  const runDirPath = runDir(runId);
  if (!existsSync(runDirPath)) {
    mkdirSync(runDirPath, { recursive: true });
  }

  const reportId = `dr_${randomUUID()}`;
  const now = Date.now();

  let codeReview: DoctorReport["codeReview"] = null;
  let accessibility: DoctorReport["accessibility"] = null;
  let performance: DoctorReport["performance"] = null;
  let security: DoctorReport["security"] = null;
  let runtime: DoctorReport["runtime"] = null;

  if (profile.codeReview.enabled) {
    codeReview = await runCodeReview(projectRoot, profile, runId);
  }

  if (profile.accessibility.enabled && profile.accessibility.urls.length > 0) {
    accessibility = await runAccessibilityCheck(profile.accessibility.urls);
  }

  if (profile.performance.enabled && profile.performance.urls.length > 0) {
    performance = await runPerformanceCheck(profile.performance.urls);
  }

  if (profile.security.enabled && profile.security.urls.length > 0) {
    security = await runSecurityCheck(profile.security.urls, profile.security.checks);
  }

  if (profile.runtime.enabled && profile.runtime.endpoints.length > 0) {
    runtime = await runRuntimeCheck(profile.runtime.endpoints);
  }

  let totalScore = 0;
  let count = 0;

  if (codeReview) {
    totalScore += codeReview.score;
    count++;
  }
  if (accessibility) {
    const avg = accessibility.reduce((s, a) => s + a.score, 0) / accessibility.length;
    totalScore += avg;
    count++;
  }
  if (performance) {
    const avg = performance.reduce((s, p) => s + p.score, 0) / performance.length;
    totalScore += avg;
    count++;
  }
  if (security) {
    const passed = security.filter((s) => s.passed).length;
    const secScore = (passed / security.length) * 100;
    totalScore += secScore;
    count++;
  }
  if (runtime) {
    const passed = runtime.filter((r) => r.ok).length;
    const runScore = (passed / runtime.length) * 100;
    totalScore += runScore;
    count++;
  }

  const overallScore = count > 0 ? Math.round(totalScore / count) : 0;
  const verdict: "ready" | "needs-work" | "degraded" =
    overallScore >= 80 ? "ready" : overallScore >= 50 ? "needs-work" : "degraded";

  const evidence: { label: string; kind: string; ref: string }[] = [];
  if (codeReview && codeReview.changedFiles > 0) {
    evidence.push({ label: `${codeReview.changedFiles} files reviewed`, kind: "code-review", ref: `${codeReview.issues.length} issues` });
  }
  if (accessibility && accessibility.length > 0) {
    evidence.push({ label: "Accessibility checked", kind: "audit", ref: accessibility[0].url });
  }
  if (performance && performance.length > 0) {
    evidence.push({ label: "Performance measured", kind: "perf", ref: performance[0].url });
  }
  if (security && security.length > 0) {
    evidence.push({ label: "Security scanned", kind: "security", ref: security.map((s) => s.check).join(",") });
  }
  if (runtime && runtime.length > 0) {
    evidence.push({ label: "Runtime endpoints checked", kind: "runtime", ref: `${runtime.filter((r) => r.ok).length}/${runtime.length} ok` });
  }

  return {
    id: reportId,
    workflowId: workflow.id,
    runId,
    passId,
    createdAt: now,
    projectRoot,
    planFile: workflow.planFile,
    codeReview,
    accessibility,
    performance,
    security,
    runtime,
    overallScore,
    verdict,
    evidence,
  };
}

function requireDb() {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard SQLite unavailable");
  return db;
}

export function createDoctorReportRow(r: Omit<DoctorReport, "id">): string {
  const db = requireDb();
  const id = `bdr_${randomUUID()}`;

  db.query(`
    INSERT INTO builder_doctor_reports
      (id, workflow_id, run_id, pass_id, created_at, project_root, plan_file,
       code_review_json, accessibility_json, performance_json, security_json, runtime_json,
       overall_score, verdict, evidence_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    r.workflowId,
    r.runId,
    r.passId,
    r.createdAt,
    r.projectRoot,
    r.planFile,
    r.codeReview ? JSON.stringify(r.codeReview) : null,
    r.accessibility ? JSON.stringify(r.accessibility) : null,
    r.performance ? JSON.stringify(r.performance) : null,
    r.security ? JSON.stringify(r.security) : null,
    r.runtime ? JSON.stringify(r.runtime) : null,
    r.overallScore,
    r.verdict,
    JSON.stringify(r.evidence),
  );

  return id;
}

export function writeDoctorReport(report: DoctorReport): void {
  ensureRunsDir();
  const runDirPath = runDir(report.runId);
  if (!existsSync(runDirPath)) {
    mkdirSync(runDirPath, { recursive: true });
  }

  const reportPath = join(runDirPath, "doctor-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { encoding: "utf8" });

  createBuilderArtifact({
    workflowId: report.workflowId,
    runId: report.runId,
    passId: report.passId,
    kind: "doctor-report",
    path: reportPath,
    metadata: {
      overallScore: report.overallScore,
      verdict: report.verdict,
      createdAt: report.createdAt,
    },
  });

  createDoctorReportRow(report);
}