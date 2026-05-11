import { expect, test } from "bun:test";
import { actionId, buildActionCatalog } from "./actionDescriptors.ts";

test("action ids are stable and safe for lookup", () => {
  expect(actionId("start-job", "service", "NewsBites Autopipeline", "restart now")).toBe(
    "start-job:service:newsbites-autopipeline:restart-now",
  );
});

test("catalog marks allowlisted and non-allowlisted service restarts", () => {
  const actions = buildActionCatalog({
    services: [
      { name: "control-surface", status: "active" },
      { name: "paperclip_db", status: "active" },
    ],
  });

  const allowed = actions.find((action) => action.kind === "start-job" && action.targetId === "control-surface");
  const denied = actions.find((action) => action.kind === "start-job" && action.targetId === "paperclip_db");

  expect(allowed?.risk).toBe("high");
  expect(allowed?.confirm).toBe(true);
  expect(allowed?.reasonRequired).toBe(true);
  expect(allowed?.disabled).toBe(false);
  expect(allowed?.jobKind).toBe("service-restart");

  expect(denied?.disabled).toBe(true);
  expect(denied?.disabledReason).toContain("allowlist");
});

test("catalog includes disabled incident lifecycle descriptors", () => {
  const actions = buildActionCatalog({
    incidents: [
      {
        ts: Date.UTC(2026, 4, 10),
        type: "pipeline-failed",
        slug: "story-a",
        stage: "write",
        errorType: "transport_timeout",
      },
      {
        ts: Date.UTC(2026, 4, 10),
        type: "doctor-abandoned",
        slug: "story-b",
        stage: "verify",
        errorType: "quality_garbage",
      },
    ],
  });

  const incidentActions = actions.filter((action) => action.targetType === "incident");
  const doctorIncident = actions.find((action) => action.targetId === "doctor-abandoned:story-b:verify:quality_garbage");

  expect(incidentActions.map((action) => action.kind).sort()).toEqual(["acknowledge", "acknowledge", "mute", "mute", "resolve", "resolve"]);
  expect(incidentActions.every((action) => action.disabled)).toBe(true);
  expect(incidentActions.every((action) => action.evidenceRefs.length > 0)).toBe(true);
  expect(doctorIncident?.evidenceRefs.some((ref) => ref.ref.includes("doctor-log.jsonl"))).toBe(true);
});

test("catalog includes model policy descriptors with audit-ready metadata", () => {
  const actions = buildActionCatalog({
    models: [
      {
        logicalName: "editorial-heavy",
        provider: "litellm",
        capability: "heavy",
        available: true,
        latency: 1200,
        jsonOk: true,
        checkedAt: Date.now(),
        qualityStatus: "healthy",
        recentFailures: 0,
        consecutiveGarbage: 0,
      },
    ],
  });

  const block = actions.find((action) => action.id === "mutate-policy:model:editorial-heavy:block");

  expect(block?.kind).toBe("mutate-policy");
  expect(block?.confirm).toBe(true);
  expect(block?.reasonRequired).toBe(true);
  expect(block?.rollbackHint).toContain("inverse");
});
