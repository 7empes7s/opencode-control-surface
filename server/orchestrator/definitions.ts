import type { WorkflowCtx, WorkflowDef, StepResult } from "./types.ts";
import { registerWorkflowDefinition } from "./engine.ts";

export const buildUntilDone: WorkflowDef = function* (ctx: WorkflowCtx) {
  // Doctor check before starting passes
  yield ctx.runValidation();

  // Loop spawn-pass until a pass signals overall completion or workflow is blocked/failed
  let sequence = 0;
  let allDone = false;

  while (!allDone) {
    const result: StepResult = yield ctx.spawnPass({ sequence });
    sequence++;

    if (result.status !== "complete") {
      // blocked, failed, or cancelled — stop immediately
      return;
    }

    const out = result.output as { done?: boolean } | undefined;
    if (out?.done) {
      allDone = true;
    }
  }

  // Final validation after all passes complete cleanly
  yield ctx.runValidation();

  // Record completion in vault
  yield ctx.logToVault({ data: { completedAt: Date.now(), sequences: sequence } });
};

export const doctorReviewWorkflow: WorkflowDef = function* (ctx: WorkflowCtx) {
  yield ctx.runValidation();
  yield ctx.logToVault({ data: { reviewCompletedAt: Date.now() } });
};

registerWorkflowDefinition("buildUntilDone", buildUntilDone);
registerWorkflowDefinition("doctorReview", doctorReviewWorkflow);
