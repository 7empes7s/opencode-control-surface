// Shared, stateless approval helpers for Control Surface consumers.
//
// This module intentionally owns no permit storage, environment access, or
// network client. A remote authority (the isolated Hyperagent broker today)
// remains responsible for the durable permit's expiry, single-use state,
// argument binding, kill switch, and budget reservation.

export type ApprovalDecision =
  | { allowed: true }
  | { allowed: false; code: "KILL_SWITCHED" | "BUDGET_DENIED" | "CONFIRM_REQUIRED" | "UNATTENDED_DENIED"; error: string };

export type ApprovalBudgetGuard = () =>
  | { allowed: true }
  | { allowed: false; error: string };

export function evaluateExplicitConfirmation(input: {
  confirmed: unknown;
  killSwitchEnabled?: boolean;
  budgetGuard?: ApprovalBudgetGuard;
}): ApprovalDecision {
  // A kill switch must win over every other gate. This makes an emergency stop
  // deterministic even when a caller also supplied a confirmation/budget.
  if (input.killSwitchEnabled) {
    return { allowed: false, code: "KILL_SWITCHED", error: "approval disabled by kill switch" };
  }

  const budget = input.budgetGuard?.();
  if (budget && budget.allowed === false) {
    return { allowed: false, code: "BUDGET_DENIED", error: budget.error };
  }

  if (input.confirmed !== true) {
    return { allowed: false, code: "CONFIRM_REQUIRED", error: "confirmation required" };
  }

  return { allowed: true };
}

// Auto-apply has already resolved its policy, rollback, circuit-breaker, rate,
// and confidence gates before reaching this final tier decision. Keeping this
// as a separate approval mode avoids manufacturing an interactive permit for a
// deliberately unattended, allowlisted action.
export function evaluateUnattendedApproval(input: { enabled: boolean }): ApprovalDecision {
  return input.enabled
    ? { allowed: true }
    : { allowed: false, code: "UNATTENDED_DENIED", error: "unattended approval is not allowed" };
}

function canonicalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("approval arguments must contain only finite numbers");
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError("approval arguments must not contain cycles");
    seen.add(value);
    const result = value.map((entry) => canonicalize(entry, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const prototype = Object.getPrototypeOf(record);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("approval arguments must be plain JSON objects");
    }
    if (seen.has(record)) throw new TypeError("approval arguments must not contain cycles");
    seen.add(record);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        throw new TypeError("approval arguments must be JSON data");
      }
      result[key] = canonicalize(entry, seen);
    }
    seen.delete(record);
    return result;
  }
  throw new TypeError("approval arguments must be JSON data");
}

export function canonicalApprovalArguments(value: unknown): string {
  return JSON.stringify(canonicalize(value, new Set<object>()));
}

export type PermitIssue<TPermit, TResult> =
  | { issued: true; permit: TPermit }
  | { issued: false; result: TResult };

// Issue exactly one permit and consume it at most once. The supplied authority
// owns token validity and durable single-use state; this helper protects the
// Control Surface relay from consuming a permit after its arguments changed.
export async function issueAndConsumePermit<TArgs, TPermit, TResult>(input: {
  args: TArgs;
  issue: (args: TArgs) => Promise<PermitIssue<TPermit, TResult>>;
  consume: (args: TArgs, permit: TPermit) => Promise<TResult>;
  argumentsChanged: () => TResult;
}): Promise<TResult> {
  const issuedForArguments = canonicalApprovalArguments(input.args);
  const issued = await input.issue(input.args);
  if (issued.issued === false) return issued.result;

  if (canonicalApprovalArguments(input.args) !== issuedForArguments) {
    return input.argumentsChanged();
  }

  return input.consume(input.args, issued.permit);
}
