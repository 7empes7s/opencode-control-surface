import { getKnowNested, readKnowSources, readKnowUnits } from "../adapters/know.ts";
import { ok, type ApiEnvelope, type KnowArtifactStatus, type KnowDetail, type SourceStatus } from "./types.ts";

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function artifactStatus(
  artifact: { state: "ok" | "missing" | "malformed"; modifiedAt: string | null; ageSeconds: number | null },
  freshnessMinutes: number,
): KnowArtifactStatus {
  return {
    state: artifact.state,
    modifiedAt: artifact.modifiedAt,
    ageSeconds: artifact.ageSeconds,
    stale: artifact.state === "ok" && artifact.ageSeconds !== null && artifact.ageSeconds > freshnessMinutes * 60,
  };
}

function sourceState(artifact: KnowArtifactStatus): SourceStatus {
  if (artifact.state !== "ok") return "error";
  return artifact.stale ? "stale" : "ok";
}

export async function knowHandler(): Promise<Response> {
  const [sources, units] = await Promise.all([
    readKnowSources(),
    Promise.resolve().then(readKnowUnits).catch(() => ({ services: [], timers: [] })),
  ]);
  const manifest = sources.manifest.value;
  const healthValue = sources.health.value ?? {};
  const opsValue = sources.operations.value ?? {};
  const doctorValue = sources.doctor.value ?? {};
  const runtimeValue = sources.runtime.value ?? {};
  const opsIdentity = getKnowNested(opsValue, "identity");
  const opsHealth = getKnowNested(opsValue, "health");
  const modelHealth = getKnowNested(opsValue, "modelHealth");
  const stories = getKnowNested(opsValue, "stories");
  const database = getKnowNested(opsValue, "database");
  const databaseAggregates = getKnowNested(database, "aggregates");
  const capabilities = getKnowNested(opsValue, "capabilities");
  const email = getKnowNested(opsValue, "email");
  const emailTemplates = getKnowNested(email, "templates");
  const emailDelivery = getKnowNested(email, "storyDelivery");
  const emailDeliveryTotals = getKnowNested(emailDelivery, "totals");
  const emailDeliveryLast = getKnowNested(emailDelivery, "last");
  const emailPresent = Object.keys(email).length > 0;
  const pipeline = getKnowNested(opsValue, "pipeline");
  const doctorCounts = getKnowNested(doctorValue, "counts");
  const configuredStageModels = getKnowNested(modelHealth, "configuredStageModels");
  const logicalModels = getKnowNested(modelHealth, "logicalModels");

  const healthArtifact = artifactStatus(sources.health, manifest?.artifacts?.health?.freshnessMinutes ?? 45);
  const opsArtifact = artifactStatus(sources.operations, manifest?.artifacts?.opsSnapshot?.freshnessMinutes ?? 45);
  const doctorArtifact = artifactStatus(sources.doctor, manifest?.artifacts?.doctor?.freshnessMinutes ?? 360);
  const manifestArtifact = artifactStatus(sources.manifest, 24 * 60);

  const data: KnowDetail = {
    identity: {
      id: "know",
      label: asString(manifest?.label) ?? asString(opsIdentity.label) ?? "Know",
      root: asString(manifest?.root) ?? "/opt/know/web",
      service: asString(manifest?.service) ?? "know-web",
      defaultPlan: asString(manifest?.defaultPlan),
      publicUrl: asString(manifest?.urls?.public),
      localUrl: asString(manifest?.urls?.local),
    },
    health: {
      artifact: healthArtifact,
      ok: asBoolean(healthValue.ok) ?? asBoolean(opsHealth.ok),
      score: asNumber(healthValue.score),
      total: asNumber(healthValue.total) ?? asNumber(opsHealth.checkCount),
      failed: asNumber(healthValue.failed) ?? asNumber(opsHealth.failedCheckCount),
      checkedAt: asString(healthValue.checkedAtISO) ?? asString(opsHealth.timestamp),
    },
    operations: {
      artifact: opsArtifact,
      stories: {
        total: asNumber(stories.total), live: asNumber(stories.live), drafts: asNumber(stories.drafts),
        artComplete: asBoolean(getKnowNested(stories, "liveArt").complete),
      },
      database: {
        reachable: asBoolean(database.reachable),
        schemaVersion: asNumber(database.schemaVersion),
        accounts: asNumber(databaseAggregates.accounts),
        events: asNumber(databaseAggregates.events),
        pushSubscriptions: asNumber(databaseAggregates.pushSubscriptions),
      },
      capabilities: {
        reachable: asBoolean(capabilities.reachable),
        magicLink: asBoolean(capabilities.magicLink),
        push: asBoolean(capabilities.push),
      },
    },
    email: {
      available: emailPresent,
      configured: asBoolean(email.configured),
      transport: asEnum(email.transport, ["microsoft365-oauth", "smtp-legacy", "unconfigured"] as const),
      readiness: asEnum(email.readiness, ["ready", "partial", "unconfigured"] as const),
      templates: {
        total: asNumber(emailTemplates.total),
        scenarios: Array.isArray(emailTemplates.scenarios)
          ? emailTemplates.scenarios.filter((value): value is string => typeof value === "string").slice(0, 40)
          : [],
        htmlCoverage: asNumber(emailTemplates.htmlCoverage),
        textCoverage: asNumber(emailTemplates.textCoverage),
        complete: asBoolean(emailTemplates.complete),
      },
      storyDelivery: {
        preferenceAvailable: asBoolean(emailDelivery.preferenceAvailable),
        optedIn: asNumber(emailDelivery.optedIn),
        liveEligible: asNumber(emailDelivery.liveEligible),
        deliveryLog: asEnum(emailDelivery.deliveryLog, ["present", "absent"] as const),
        totals: {
          delivered: asNumber(emailDeliveryTotals.delivered),
          unavailable: asNumber(emailDeliveryTotals.unavailable),
          failed: asNumber(emailDeliveryTotals.failed),
        },
        last: Object.keys(emailDeliveryLast).length > 0
          ? { status: asEnum(emailDeliveryLast.status, ["delivered", "unavailable", "failed", "unknown"] as const), at: asString(emailDeliveryLast.at) }
          : null,
      },
    },
    models: {
      configuredStageModels: Object.fromEntries(Object.entries(configuredStageModels).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
      logicalModels: Object.entries(logicalModels).map(([name, raw]) => {
        const model = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
        return { name, observed: asBoolean(model.observed), available: asBoolean(model.available), capability: asString(model.capability), latencyMs: asNumber(model.latencyMs), rating100: asNumber(model.rating100), lastTestedAt: asString(model.lastTestedAt) };
      }),
      warning: asNumber(Object.values(logicalModels).filter((raw) => raw && typeof raw === "object" && (raw as Record<string, unknown>).available === true).length) === 0
        ? "No configured Know logical model is currently marked available."
        : null,
    },
    workflow: {
      stages: Array.isArray(manifest?.workflow?.stages) ? manifest.workflow.stages.filter((value): value is string => typeof value === "string") : [],
      dossiers: asNumber(pipeline.dossiers),
      filesByStage: Object.fromEntries(Object.entries(getKnowNested(pipeline, "filesByStage")).filter((entry): entry is [string, number] => typeof entry[1] === "number")),
      agentRuns: asNumber(pipeline.agentRuns),
      latestModifiedAt: asString(pipeline.latestModifiedAt),
    },
    doctor: {
      artifact: doctorArtifact,
      ok: asBoolean(doctorValue.ok),
      status: asString(doctorValue.status),
      counts: { pass: asNumber(doctorCounts.pass), warn: asNumber(doctorCounts.warn), fail: asNumber(doctorCounts.fail) },
      findings: Array.isArray(doctorValue.findings) ? doctorValue.findings.slice(0, 50).map((raw) => {
        const finding = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        return { id: asString(finding.id) ?? "unknown", status: asString(finding.status) ?? "unknown", summary: asString(finding.summary) ?? "No summary", remediation: asString(finding.remediation) };
      }) : [],
    },
    runtime: {
      reachable: sources.runtime.reachable,
      status: sources.runtime.status,
      checkedAt: sources.runtime.checkedAt,
      stories: getKnowNested(runtimeValue, "stories") as KnowDetail["runtime"]["stories"],
      database: getKnowNested(runtimeValue, "database") as KnowDetail["runtime"]["database"],
    },
    units: {
      services: units.services,
      timers: units.timers,
    },
    boundaries: {
      owns: Array.isArray(manifest?.separation?.owns) ? manifest.separation.owns.filter((value): value is string => typeof value === "string") : [],
      neverReads: Array.isArray(manifest?.separation?.neverReads) ? manifest.separation.neverReads.filter((value): value is string => typeof value === "string") : [],
    },
  };

  const sourceStatus: Record<string, SourceStatus> = {
    knowManifest: sourceState(manifestArtifact),
    knowHealth: sourceState(healthArtifact),
    knowOps: sourceState(opsArtifact),
    knowDoctor: sourceState(doctorArtifact),
    knowRuntime: sources.runtime.reachable ? "ok" : "error",
  };
  const envelope: ApiEnvelope<KnowDetail> = ok(data, sourceStatus);
  return Response.json(envelope);
}
