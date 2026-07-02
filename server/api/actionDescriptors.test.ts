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

test("catalog omits synthetic incident lifecycle descriptors", () => {
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

  expect(incidentActions).toEqual([]);
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
        isFree: false,
        isPaid: true,
        isOpenCode: false,
        isCli: true,
        providerType: "local",
        contextWindow: 128000,
        params: 26,
        resolvedModel: "llama-3.3-70b-versatile",
      },
    ],
  });

  const block = actions.find((action) => action.id === "mutate-policy:model:editorial-heavy:block");

  expect(block?.kind).toBe("mutate-policy");
  expect(block?.confirm).toBe(true);
  expect(block?.reasonRequired).toBe(true);
  expect(block?.rollbackHint).toContain("inverse");
});
