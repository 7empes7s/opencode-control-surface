import { execSync } from "node:child_process";
import { readOperatorState, writeOperatorState } from "../db/writer.ts";

export interface OnboardingStatus {
  completed: boolean;
  currentStep: number;
  hostInfo: {
    os: string;
    agents: string[];
    modelCount: number;
  };
}

export function onboardingStatusHandler(): Response {
  const completed = readOperatorState("onboarding_completed") as boolean ?? false;
  const currentStep = (readOperatorState("onboarding_step") as number) ?? 0;

  let os = "unknown";
  try {
    os = execSync("uname -s", { encoding: "utf8", timeout: 3000 }).trim();
  } catch { /* ignore */ }

  const agentNames: string[] = [];
  try {
    const agentsRaw = execSync(
      "systemctl list-units --all --no-legend 'paperclip*' 'openclaw*' 2>/dev/null | awk '{print $1}' | sort -u",
      { encoding: "utf8", timeout: 5000 }
    );
    for (const line of agentsRaw.trim().split("\n")) {
      const name = line.trim().replace(/\.service$/, "");
      if (name) agentNames.push(name);
    }
  } catch { /* ignore */ }

  let modelCount = 0;
  try {
    const raw = execSync("ls /etc/litellm/config.yaml 2>/dev/null && wc -l < /etc/litellm/config.yaml || echo 0", {
      encoding: "utf8",
      timeout: 3000,
    });
    modelCount = parseInt(raw.trim(), 10) > 0 ? 1 : 0;
  } catch { /* ignore */ }

  const status: OnboardingStatus = {
    completed,
    currentStep,
    hostInfo: { os, agents: agentNames, modelCount },
  };

  return Response.json(status);
}

export async function onboardingStepHandler(req: Request): Promise<Response> {
  let body: { step?: number; action?: string };
  try {
    body = await req.json() as { step?: number; action?: string };
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const action = body.action ?? "advance";
  const MAX_STEPS = 4;

  if (action === "complete") {
    writeOperatorState("onboarding_completed", true);
    return Response.json({ ok: true, completed: true, step: -1 });
  }

  if (action === "reset") {
    writeOperatorState("onboarding_completed", false);
    writeOperatorState("onboarding_step", 0);
    return Response.json({ ok: true, completed: false, step: 0 });
  }

  const currentStep = (readOperatorState("onboarding_step") as number) ?? 0;

  if (action === "set") {
    if (typeof body.step !== "number" || body.step < 0 || body.step > MAX_STEPS) {
      return new Response(JSON.stringify({ error: "invalid step" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    writeOperatorState("onboarding_step", body.step);
    return Response.json({ ok: true, completed: false, step: body.step });
  }

  if (action === "advance") {
    const nextStep = Math.min(currentStep + 1, MAX_STEPS);
    writeOperatorState("onboarding_step", nextStep);
    const completed = nextStep >= MAX_STEPS;
    if (completed) {
      writeOperatorState("onboarding_completed", true);
    }
    return Response.json({ ok: true, completed, step: nextStep });
  }

  return new Response(JSON.stringify({ error: "unknown action" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}