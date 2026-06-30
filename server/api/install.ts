import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { readConfigSelfChecks } from "../insights/scanners/governance.ts";
import { ok, type ApiEnvelope } from "./types.ts";

export type InstallCheckStatus = "pass" | "warn" | "fail";

export type InstallSecretPresence = {
  id: string;
  label: string;
  present: boolean;
  source: "env" | "governance" | "absent";
};

export type InstallStatusCheck = {
  id: string;
  label: string;
  status: InstallCheckStatus;
  source: string;
  howToFix: string;
  evidence: string;
};

export type InstallStatusPayload = {
  generatedAt: number;
  allRequiredGreen: boolean;
  checks: InstallStatusCheck[];
  secrets: InstallSecretPresence[];
};

function jsonOk<T>(data: T): Response {
  const envelope: ApiEnvelope<T> = ok(data);
  return Response.json(envelope);
}

function envPresent(name: string): boolean {
  return typeof process.env[name] === "string" && process.env[name]!.trim().length > 0;
}

function governanceSecretNames(): Set<string> {
  const names = new Set<string>();
  if (!isDashboardDbEnabled()) return names;
  const db = getDashboardDb();
  if (!db) return names;
  try {
    const rows = db.query(`SELECT name FROM governance_secrets ORDER BY name LIMIT 500`).all() as Array<{ name: string }>;
    for (const row of rows) names.add(row.name.toLowerCase());
  } catch {
    // Fresh installs may not have readable secret metadata yet.
  }
  return names;
}

function hasGovernanceSecret(names: Set<string>, candidates: string[]): boolean {
  return candidates.some((candidate) => names.has(candidate.toLowerCase()));
}

function secretPresence(
  id: string,
  label: string,
  envNames: string[],
  governanceNames: string[],
  names: Set<string>,
): InstallSecretPresence {
  if (envNames.some(envPresent)) return { id, label, present: true, source: "env" };
  if (hasGovernanceSecret(names, governanceNames)) return { id, label, present: true, source: "governance" };
  return { id, label, present: false, source: "absent" };
}

function baseCheck(input: {
  id: string;
  label: string;
  ok: boolean;
  source: string;
  howToFix: string;
  evidence: string;
  warn?: boolean;
}): InstallStatusCheck {
  return {
    id: input.id,
    label: input.label,
    status: input.ok ? "pass" : input.warn ? "warn" : "fail",
    source: input.source,
    howToFix: input.howToFix,
    evidence: input.evidence,
  };
}

export function collectInstallStatus(): InstallStatusPayload {
  const selfChecks = readConfigSelfChecks();
  const byId = new Map(selfChecks.map((check) => [check.id, check]));
  const secretNames = governanceSecretNames();
  const secrets = [
    secretPresence("telegram-bot", "Telegram bot token", ["TELEGRAM_BOT_TOKEN"], ["telegram_bot_token", "telegram-bot-token"], secretNames),
    secretPresence("telegram-chat", "Telegram chat id", ["TELEGRAM_CHAT_ID"], ["telegram_chat_id", "telegram-chat-id"], secretNames),
    secretPresence(
      "model-gateway",
      "Model gateway credential",
      ["LITELLM_MASTER_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
      ["litellm_master_key", "openrouter_api_key", "openai_api_key", "anthropic_api_key"],
      secretNames,
    ),
  ];

  const token = byId.get("operator-token");
  const sentinel = byId.get("sentinel-running");
  const ingestor = byId.get("ingestor-running");
  const tunnel = byId.get("tunnels-up");
  const secretsReadable = byId.get("secrets-readable");
  const requiredSecretsPresent = secrets.every((secret) => secret.present);

  const checks: InstallStatusCheck[] = [
    baseCheck({
      id: "operator-token",
      label: "Operator token present",
      ok: token?.ok ?? false,
      source: "auth/config self-check",
      howToFix: token?.remediation ?? "Set OPERATOR_TOKEN in the service environment and restart the control surface.",
      evidence: "presence only",
    }),
    baseCheck({
      id: "required-secrets",
      label: "Required secrets present",
      ok: requiredSecretsPresent,
      source: "environment + governance secret metadata",
      howToFix: "Add missing Telegram and model gateway credentials in the service environment or Governance secrets store.",
      evidence: `${secrets.filter((secret) => secret.present).length}/${secrets.length} present; values are never returned`,
    }),
    baseCheck({
      id: "secrets-readable",
      label: "Secrets metadata readable",
      ok: secretsReadable?.ok ?? false,
      source: "auth/config self-check",
      howToFix: secretsReadable?.remediation ?? "Repair the governance secrets table or database access.",
      evidence: secretsReadable?.evidenceRef ?? "governance_secrets",
      warn: true,
    }),
    baseCheck({
      id: "tunnels-up",
      label: "Public tunnels up",
      ok: tunnel?.ok ?? false,
      source: "edge/self-check signal",
      howToFix: tunnel?.remediation ?? "Repair the tunnel service from Infra.",
      evidence: tunnel?.evidenceRef ?? "tunnel service discovery",
    }),
    baseCheck({
      id: "sentinel-running",
      label: "Sentinel health fresh",
      ok: sentinel?.ok ?? false,
      source: "auth/config self-check",
      howToFix: sentinel?.remediation ?? "Repair the product health sentinel so status evidence refreshes.",
      evidence: sentinel?.evidenceRef ?? "product-health sentinel file",
    }),
    baseCheck({
      id: "scheduler-running",
      label: "Scheduler samples fresh",
      ok: ingestor?.ok ?? false,
      source: "auth/config self-check",
      howToFix: ingestor?.remediation ?? "Repair the in-process scheduler/ingestor so metric samples refresh.",
      evidence: ingestor?.evidenceRef ?? "metric_samples",
    }),
    baseCheck({
      id: "dashboard-db",
      label: "Dashboard database enabled",
      ok: isDashboardDbEnabled() && Boolean(getDashboardDb()),
      source: "database initialization",
      howToFix: "Start the service with DASHBOARD_DB=1 and a writable dashboard database path.",
      evidence: "presence only",
    }),
  ];

  return {
    generatedAt: Date.now(),
    allRequiredGreen: checks.every((check) => check.status === "pass" || check.status === "warn"),
    checks,
    secrets,
  };
}

export function installStatusHandler(): Response {
  return jsonOk(collectInstallStatus());
}
