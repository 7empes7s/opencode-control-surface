import type { DiagnosisResult } from "./types.ts";

export interface DiagnosisPromptInput {
  failureClass: string;
  passAnalytics: Record<string, unknown> | null;
  stdoutTail: string;
  validationResults: Array<{ command: string; status: string; output: string }>;
  planExcerpt: string;
  traceSummary: string;
}

export function buildDiagnosisPrompt(input: DiagnosisPromptInput): string {
  const { failureClass, passAnalytics, stdoutTail, validationResults, planExcerpt, traceSummary } = input;

  const analyticsStr = passAnalytics
    ? JSON.stringify(passAnalytics, null, 2)
    : "(no analytics available)";

  const validationStr = validationResults.length > 0
    ? validationResults.map((v) => `  - command: ${v.command}\n    status: ${v.status}\n    output: ${v.output}`).join("\n")
    : "  (no validation results)";

  return `You are a senior software engineering diagnostician analyzing a failed automated coding run.

## Failure Summary
failure_class: ${failureClass}

## Pass Analytics
${analyticsStr}

## Agent Output (last 2000 characters)
${stdoutTail || "(no output captured)"}

## Validation Results
${validationStr}

## Plan Items (unchecked)
${planExcerpt || "(no plan excerpt available)"}

## Trace Summary
${traceSummary || "(no trace available)"}

## Your Task
Analyze the above information and determine WHY this run failed. Output a structured diagnosis as JSON matching this schema:
{
  "passId": "string — copy from context",
  "runId": "string — copy from context", 
  "workflowId": "string — copy from context",
  "failureClass": "string — copy from failure_class above",
  "rootCauseHypothesis": "string — your best theory of the root cause (1-3 sentences)",
  "evidence": ["string", "..."] — 2-5 specific evidence items from the data above that support your theory,
  "suggestedActions": ["string", "..."] — 2-5 concrete next steps to prevent this failure,
  "confidence": "high" | "medium" | "low" — your confidence in this diagnosis,
  "diagnosedAt": number — Unix timestamp in milliseconds (use Date.now())
}

Rules:
- rootCauseHypothesis must be specific — not generic ("agent failed") but what specifically went wrong
- suggestedActions must be actionable — specific commands to run, files to change, conditions to fix
- confidence: "high" if you're confident in the diagnosis, "medium" if plausible but uncertain, "low" if guessing
- Output ONLY the JSON object, no markdown, no explanation`;
}

export function parseDiagnosisResult(raw: string, fallbackContext: {
  passId: string;
  runId: string;
  workflowId: string;
  failureClass: string;
}): DiagnosisResult | null {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (typeof parsed.rootCauseHypothesis !== "string" || !Array.isArray(parsed.suggestedActions) || parsed.suggestedActions.length === 0) {
      return null;
    }
    return {
      passId: parsed.passId ?? fallbackContext.passId,
      runId: parsed.runId ?? fallbackContext.runId,
      workflowId: parsed.workflowId ?? fallbackContext.workflowId,
      failureClass: parsed.failureClass ?? fallbackContext.failureClass,
      rootCauseHypothesis: parsed.rootCauseHypothesis,
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : [],
      suggestedActions: parsed.suggestedActions,
      confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
      diagnosedAt: parsed.diagnosedAt ?? Date.now(),
    };
  } catch {
    return null;
  }
}