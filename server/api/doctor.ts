import {
  getDoctorEntryErrorType,
  getDoctorEntryFailedModel,
  getDoctorEntryReason,
  getFullLog,
  getDoctorStats,
  type FullLogOpts,
} from "../adapters/doctor.ts";
import { ok, type ApiEnvelope, type DoctorDetail } from "./types.ts";

export function doctorHandler(url: URL): Response {
  const params = url.searchParams;
  const opts: FullLogOpts = {};
  if (params.get("stage")) opts.stage = params.get("stage")!;
  if (params.get("errorType")) opts.errorType = params.get("errorType")!;
  if (params.get("failedModel")) opts.failedModel = params.get("failedModel")!;
  if (params.get("since")) opts.since = parseInt(params.get("since")!);

  const entries = getFullLog(opts);
  const stats = getDoctorStats();

  const data: DoctorDetail = {
    entries: entries.map((e) => ({
      ts: e.ts,
      slug: e.slug ?? "",
      stage: e.stage ?? "",
      action: e.action ?? "",
      reason: getDoctorEntryReason(e),
      errorType: getDoctorEntryErrorType(e),
      failedModel: getDoctorEntryFailedModel(e),
      nextStage: e.nextStage,
      cooldownMs: e.cooldownMs,
    })),
    stats: {
      total: stats.total,
      successRate: stats.total > 0 ? stats.success / stats.total : 0,
      errorClasses: stats.errorClasses,
      topFailingModels: stats.topFailingModels,
      topFailingStages: stats.topFailingStages,
      verdictMix: stats.verdictMix,
    },
    lastDecision: stats.lastDecision,
  };

  const envelope: ApiEnvelope<DoctorDetail> = ok(data, { doctor: "ok" });
  return new Response(JSON.stringify(envelope), { headers: { "Content-Type": "application/json" } });
}
