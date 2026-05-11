import { readFileSync } from "node:fs";
import { getDoctorEntryErrorType, getDoctorEntryFailedModel, getDoctorEntryReason, getFullLog } from "../adapters/doctor.ts";
import { getModelsDetail } from "../adapters/models.ts";
import { getAllArticles } from "../adapters/newsbites.ts";
import { getPipelineState, type QueueItem } from "../adapters/pipeline.ts";
import { getServiceStatuses, getTimers } from "../adapters/system.ts";
import { getVastAccount, getVastInstance } from "../adapters/vast.ts";
import { ALLOWED_CONTAINERS, ALLOWED_SERVICES, ALLOWED_TIMERS } from "./actions.ts";
import { getIncidentEntries } from "./incidents.ts";
import { ok, type ActionDescriptor, type ApiEnvelope, type DoctorDetail, type EvidenceRef, type InfraDetail, type ModelsDetail, type NewsBitesDetail } from "./types.ts";

const GPU_HEALTH_PATH = "/var/lib/mimule/gpu-health.json";

type CatalogInputs = {
  services?: InfraDetail["services"];
  timers?: InfraDetail["timers"];
  queue?: QueueItem[];
  models?: ModelsDetail["models"];
  articles?: NewsBitesDetail["articles"];
  incidents?: Array<{ ts: number; type: string; slug: string; stage: string; errorType: string }>;
  doctorEntries?: DoctorDetail["entries"];
  vastInstance?: InfraDetail["vastInstance"];
  vastBalance?: InfraDetail["vastBalance"];
  gpu?: InfraDetail["gpu"];
};

export type ActionCatalogResponse = {
  actions: ActionDescriptor[];
  degraded: boolean;
  sources: Record<string, "ok" | "error">;
};

type DescriptorSeed = Omit<ActionDescriptor, "id" | "evidenceRefs" | "confirm" | "reasonRequired"> & {
  id?: string;
  evidenceRefs?: EvidenceRef[];
  confirm?: boolean;
  reasonRequired?: boolean;
};

function safeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function actionId(kind: ActionDescriptor["kind"], targetType: string, targetId: string, suffix?: string): string {
  return [kind, targetType, targetId, suffix].filter(Boolean).map((part) => safeId(String(part))).join(":");
}

function descriptor(seed: DescriptorSeed): ActionDescriptor {
  return {
    ...seed,
    id: seed.id ?? actionId(seed.kind, seed.targetType, seed.targetId),
    confirm: seed.confirm ?? false,
    reasonRequired: seed.reasonRequired ?? false,
    evidenceRefs: seed.evidenceRefs ?? [],
  };
}

function commandEvidence(label: string, ref: string): EvidenceRef {
  return { label, kind: "command", ref };
}

function apiEvidence(label: string, ref: string): EvidenceRef {
  return { label, kind: "api", ref };
}

function fileEvidence(label: string, ref: string): EvidenceRef {
  return { label, kind: "file", ref };
}

function isRestartAllowed(name: string): boolean {
  return ALLOWED_SERVICES.includes(name) || ALLOWED_CONTAINERS.includes(name);
}

function serviceProbeCommand(name: string): string {
  return ALLOWED_CONTAINERS.includes(name)
    ? `docker inspect --format='{{.State.Status}}' ${name}`
    : `systemctl is-active ${name}`;
}

function serviceRestartKind(name: string): string {
  return ALLOWED_CONTAINERS.includes(name) ? "container-restart" : "service-restart";
}

function serviceRestartPreview(name: string): string {
  return ALLOWED_CONTAINERS.includes(name)
    ? `Restart Docker container ${name}.`
    : `Restart systemd service ${name}. Brief downtime is expected.`;
}

function addServiceActions(actions: ActionDescriptor[], services: InfraDetail["services"] = []): void {
  for (const service of services) {
    const targetId = service.name;
    const evidence = [
      commandEvidence("Current state", serviceProbeCommand(service.name)),
      apiEvidence("Infra detail", "/api/infra"),
    ];

    actions.push(descriptor({
      label: "Open infra",
      kind: "navigate",
      targetType: "service",
      targetId,
      risk: "low",
      sourceRoute: "/infra",
      evidenceRefs: evidence,
    }));

    actions.push(descriptor({
      label: "Restart",
      kind: "start-job",
      targetType: "service",
      targetId,
      risk: "high",
      confirm: true,
      reasonRequired: true,
      disabled: !isRestartAllowed(service.name),
      disabledReason: isRestartAllowed(service.name) ? undefined : "Service is visible but not in the restart allowlist.",
      evidenceRefs: evidence,
      impactPreview: serviceRestartPreview(service.name),
      rollbackHint: `Inspect ${service.name} logs and restart the previous dependency if health does not recover.`,
      expectedDurationMs: ALLOWED_CONTAINERS.includes(service.name) ? 60_000 : 30_000,
      jobKind: serviceRestartKind(service.name),
      sourceRoute: "/infra",
      requiresOnline: true,
    }));

    actions.push(descriptor({
      label: "Copy status command",
      kind: "copy-command",
      targetType: "service",
      targetId,
      risk: "low",
      evidenceRefs: evidence,
      impactPreview: serviceProbeCommand(service.name),
      sourceRoute: "/infra",
    }));
  }
}

function addTimerActions(actions: ActionDescriptor[], timers: InfraDetail["timers"] = []): void {
  for (const timer of timers) {
    const targetId = timer.name;
    const evidence = [
      commandEvidence("Timer state", `systemctl show ${timer.name}.timer --property=ActiveState,LastTriggerUSec,NextElapseUSecRealtime,Result`),
      apiEvidence("Infra detail", "/api/infra"),
    ];

    actions.push(descriptor({
      label: "Open infra",
      kind: "navigate",
      targetType: "timer",
      targetId,
      risk: "low",
      sourceRoute: "/infra",
      evidenceRefs: evidence,
    }));

    actions.push(descriptor({
      label: "Run now",
      kind: "start-job",
      targetType: "timer",
      targetId,
      risk: "medium",
      confirm: true,
      reasonRequired: true,
      disabled: !ALLOWED_TIMERS.includes(timer.name),
      disabledReason: ALLOWED_TIMERS.includes(timer.name) ? undefined : "Timer is visible but not in the manual-run allowlist.",
      evidenceRefs: evidence,
      impactPreview: `Start ${timer.name}.service once via systemd.`,
      rollbackHint: "Inspect the service journal and wait for the next timer cycle if the manual run fails.",
      expectedDurationMs: 5_000,
      jobKind: "run-timer",
      sourceRoute: "/infra",
      requiresOnline: true,
    }));
  }
}

function addQueueActions(actions: ActionDescriptor[], queue: QueueItem[] = []): void {
  for (const item of queue.slice(0, 100)) {
    const targetId = item.slug || item.id;
    const evidence = [
      apiEvidence("Autopipeline queue", "/api/autopipeline"),
      apiEvidence("Autopipeline command API", "http://127.0.0.1:3200/queue"),
    ];

    actions.push(descriptor({
      label: "Open autopipeline",
      kind: "navigate",
      targetType: "queue-item",
      targetId,
      risk: "low",
      sourceRoute: "/autopipeline",
      evidenceRefs: evidence,
    }));

    actions.push(descriptor({
      label: "Create fix task",
      kind: "create-agent-task",
      targetType: "queue-item",
      targetId,
      risk: "medium",
      disabled: true,
      disabledReason: "Agent task creation is cataloged here; execution lands with the durable actions slice.",
      evidenceRefs: evidence,
      impactPreview: `Create an agent task for ${targetId} at stage ${item.stage}.`,
      sourceRoute: "/autopipeline",
    }));
  }
}

function addModelActions(actions: ActionDescriptor[], models: ModelsDetail["models"] = []): void {
  actions.push(descriptor({
    label: "Run quick check",
    kind: "start-job",
    targetType: "model-health",
    targetId: "all",
    risk: "medium",
    confirm: true,
    reasonRequired: true,
    evidenceRefs: [
      commandEvidence("Model health check", "systemctl start model-health-check.service"),
      apiEvidence("Models detail", "/api/models"),
    ],
    impactPreview: "Start model-health-check.service once.",
    rollbackHint: "Review model-health-check.service journal and retain the previous health file if the run fails.",
    expectedDurationMs: 5_000,
    jobKind: "model-health-check",
    sourceRoute: "/models",
    requiresOnline: true,
  }));

  for (const model of models.slice(0, 150)) {
    const evidence = [
      fileEvidence("Model health", "/var/lib/mimule/model-health.json"),
      fileEvidence("Model quality", "/var/lib/mimule/model-quality.json"),
      apiEvidence("Models detail", "/api/models"),
    ];

    for (const action of ["block", "unblock", "probation-clear"] as const) {
      actions.push(descriptor({
        id: actionId("mutate-policy", "model", model.logicalName, action),
        label: action === "probation-clear" ? "Clear probation" : action === "block" ? "Block model" : "Unblock model",
        kind: "mutate-policy",
        targetType: "model",
        targetId: model.logicalName,
        risk: "high",
        confirm: true,
        reasonRequired: true,
        evidenceRefs: evidence,
        impactPreview: `${action} policy state for ${model.logicalName}.`,
        rollbackHint: `Use the inverse model policy action for ${model.logicalName}.`,
        jobKind: "model-policy",
        sourceRoute: "/models",
      }));
    }
  }
}

function addArticleActions(actions: ActionDescriptor[], articles: NewsBitesDetail["articles"] = []): void {
  for (const article of articles.slice(0, 150)) {
    const articlePath = `/opt/newsbites/content/articles/${article.slug}.md`;
    const evidence = [
      fileEvidence("Article file", articlePath),
      apiEvidence("NewsBites detail", "/api/newsbites"),
    ];

    actions.push(descriptor({
      label: "Open source file",
      kind: "open-source",
      targetType: "article",
      targetId: article.slug,
      risk: "low",
      evidenceRefs: evidence,
      sourceRoute: "/newsbites",
    }));

    actions.push(descriptor({
      label: "Open live article",
      kind: "external-link",
      targetType: "article",
      targetId: article.slug,
      risk: "low",
      disabled: article.status !== "published",
      disabledReason: article.status === "published" ? undefined : "Article is not published.",
      evidenceRefs: evidence,
      impactPreview: `https://news.techinsiderbytes.com/articles/${article.slug}`,
      sourceRoute: "/newsbites",
    }));
  }
}

function addIncidentActions(actions: ActionDescriptor[], incidents: CatalogInputs["incidents"] = []): void {
  for (const incident of incidents.slice(0, 150)) {
    const targetId = `${incident.type}:${incident.slug}:${incident.stage}:${incident.errorType}`;
    const sourceEvidence = incident.type === "doctor-abandoned"
      ? fileEvidence("Doctor log", "/var/lib/mimule/doctor-log.jsonl")
      : fileEvidence("Pipeline alerts", "/var/lib/mimule/pipeline-alerts.json");
    const evidence = [
      sourceEvidence,
      apiEvidence("Incidents detail", "/api/incidents"),
    ];

    for (const kind of ["acknowledge", "resolve", "mute"] as const) {
      actions.push(descriptor({
        label: kind === "acknowledge" ? "Acknowledge" : kind === "resolve" ? "Resolve" : "Mute",
        kind,
        targetType: "incident",
        targetId,
        risk: kind === "resolve" ? "medium" : "low",
        confirm: kind !== "acknowledge",
        reasonRequired: kind !== "acknowledge",
        disabled: true,
        disabledReason: "Incident lifecycle storage lands with the durable actions slice.",
        evidenceRefs: evidence,
        sourceRoute: "/incidents",
      }));
    }
  }
}

function addDoctorActions(actions: ActionDescriptor[], doctorEntries: DoctorDetail["entries"] = []): void {
  actions.push(descriptor({
    label: "Run doctor scan",
    kind: "start-job",
    targetType: "doctor",
    targetId: "scan",
    risk: "medium",
    confirm: true,
    reasonRequired: true,
    evidenceRefs: [
      apiEvidence("Doctor detail", "/api/doctor"),
      apiEvidence("Doctor scan", "/api/doctor/scan"),
    ],
    impactPreview: "Trigger the autopipeline doctor scan endpoint.",
    rollbackHint: "Review doctor output and leave pipeline state unchanged if the scan returns errors.",
    expectedDurationMs: 30_000,
    jobKind: "doctor-scan",
    sourceRoute: "/doctor",
    requiresOnline: true,
  }));

  for (const entry of doctorEntries.slice(0, 150)) {
    const targetId = `${entry.slug || "unknown"}:${entry.stage || "unknown"}:${entry.ts}`;
    const evidence = [
      fileEvidence("Doctor log", "/var/lib/mimule/doctor-log.jsonl"),
      apiEvidence("Doctor detail", "/api/doctor"),
    ];

    actions.push(descriptor({
      label: "Create repair task",
      kind: "create-agent-task",
      targetType: "doctor-entry",
      targetId,
      risk: "medium",
      disabled: true,
      disabledReason: "Agent task creation is cataloged here; execution lands with the durable actions slice.",
      evidenceRefs: evidence,
      impactPreview: `Create a repair task for ${entry.slug || "unknown story"} after ${entry.action || "doctor"} decision.`,
      sourceRoute: "/doctor",
    }));
  }
}

function addVastAndGpuActions(actions: ActionDescriptor[], input: CatalogInputs): void {
  const vastEvidence = [
    apiEvidence("Infra detail", "/api/infra"),
    commandEvidence("Vast tunnel", "systemctl is-active vast-tunnel"),
  ];
  actions.push(descriptor({
    label: "Restart tunnel",
    kind: "start-job",
    targetType: "vast",
    targetId: input.vastInstance?.id || "tunnel",
    risk: "high",
    confirm: true,
    reasonRequired: true,
    evidenceRefs: vastEvidence,
    impactPreview: "Restart vast-tunnel.service.",
    rollbackHint: "Check journalctl -u vast-tunnel.service and restore the previous tunnel config if reconnect fails.",
    expectedDurationMs: 30_000,
    jobKind: "service-restart",
    sourceRoute: "/infra",
    requiresOnline: true,
  }));

  actions.push(descriptor({
    label: "Copy GPU probe",
    kind: "copy-command",
    targetType: "gpu",
    targetId: input.gpu?.status || "unknown",
    risk: "low",
    evidenceRefs: [
      fileEvidence("GPU health", "/var/lib/mimule/gpu-health.json"),
      commandEvidence("Ollama tags", "curl -s http://127.0.0.1:11434/api/tags"),
    ],
    impactPreview: "curl -s http://127.0.0.1:11434/api/tags",
    sourceRoute: "/infra",
  }));
}

export function buildActionCatalog(input: CatalogInputs): ActionDescriptor[] {
  const actions: ActionDescriptor[] = [];
  addServiceActions(actions, input.services);
  addTimerActions(actions, input.timers);
  addQueueActions(actions, input.queue);
  addModelActions(actions, input.models);
  addArticleActions(actions, input.articles);
  addIncidentActions(actions, input.incidents);
  addDoctorActions(actions, input.doctorEntries);
  addVastAndGpuActions(actions, input);
  return actions;
}

async function settled<T>(sources: Record<string, "ok" | "error">, name: string, fn: () => Promise<T> | T): Promise<T | undefined> {
  try {
    const value = await fn();
    sources[name] = "ok";
    return value;
  } catch (error) {
    console.error(`[actions/catalog] ${name} source failed`, error);
    sources[name] = "error";
    return undefined;
  }
}

function doctorEntries(): DoctorDetail["entries"] {
  return getFullLog({}).slice(-150).map((entry) => ({
    ts: entry.ts,
    slug: entry.slug ?? "",
    stage: entry.stage ?? "",
    action: entry.action ?? "",
    reason: getDoctorEntryReason(entry),
    errorType: getDoctorEntryErrorType(entry),
    failedModel: getDoctorEntryFailedModel(entry),
    nextStage: entry.nextStage,
    cooldownMs: entry.cooldownMs,
  }));
}

function filterActions(actions: ActionDescriptor[], url: URL): ActionDescriptor[] {
  const targetType = url.searchParams.get("targetType");
  const targetId = url.searchParams.get("targetId");
  const sourceRoute = url.searchParams.get("sourceRoute");

  return actions.filter((action) => {
    if (targetType && action.targetType !== targetType) return false;
    if (targetId && action.targetId !== targetId) return false;
    if (sourceRoute && action.sourceRoute !== sourceRoute) return false;
    return true;
  });
}

function readIncidents(): NonNullable<CatalogInputs["incidents"]> {
  return getIncidentEntries();
}

function readGpuHealth(): InfraDetail["gpu"] | undefined {
  try {
    const raw = JSON.parse(readFileSync(GPU_HEALTH_PATH, "utf8")) as {
      status?: string;
      gpu_max_util?: number;
      models?: string[];
      checked_at?: number;
    };
    return {
      status: raw.status === "up" ? "up" : raw.status === "down" ? "down" : "unknown",
      gpuUtil: raw.gpu_max_util ?? null,
      loadedModels: raw.models ?? [],
      checkedAgo: raw.checked_at ? Math.round((Date.now() - raw.checked_at * 1000) / 1000) : -1,
    };
  } catch {
    return undefined;
  }
}

export async function actionCatalogHandler(url: URL): Promise<Response> {
  const sources: Record<string, "ok" | "error"> = {};
  const [services, timers, pipeline, models, articles, doctor, incidents, gpu, vastInstance, vastBalance] = await Promise.all([
    settled(sources, "services", getServiceStatuses),
    settled(sources, "timers", getTimers),
    settled(sources, "pipeline", getPipelineState),
    settled(sources, "models", getModelsDetail),
    settled(sources, "articles", getAllArticles),
    settled(sources, "doctor", doctorEntries),
    settled(sources, "incidents", readIncidents),
    settled(sources, "gpu", readGpuHealth),
    settled(sources, "vastInstance", getVastInstance),
    settled(sources, "vastBalance", getVastAccount),
  ]);

  const actions = buildActionCatalog({
    services,
    timers,
    queue: pipeline?.queue,
    models: models?.models,
    articles,
    incidents,
    doctorEntries: doctor,
    vastInstance: vastInstance ? {
      id: vastInstance.id,
      status: vastInstance.status,
      gpu: vastInstance.gpu,
      vcpus: vastInstance.vcpus,
      ramGb: vastInstance.ram,
      diskGb: vastInstance.disk,
      hourlyRate: vastInstance.hourlyRate,
      ip: vastInstance.ip,
      sshPort: vastInstance.sshPort,
    } : null,
    vastBalance: vastBalance ? {
      balance: vastBalance.balance,
      credit: vastBalance.credit,
      runwayHours: vastInstance?.hourlyRate ? Math.round(((vastBalance.balance + vastBalance.credit) / vastInstance.hourlyRate) * 10) / 10 : null,
    } : null,
    gpu,
  });

  const data: ActionCatalogResponse = {
    actions: filterActions(actions, url),
    degraded: Object.values(sources).some((source) => source === "error"),
    sources,
  };
  const envelope: ApiEnvelope<ActionCatalogResponse> = ok(data, sources);
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
