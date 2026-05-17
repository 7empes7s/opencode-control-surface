export type PolicyEffect = "allow" | "deny" | "require_approval" | "log-only";

export type PolicyDecision = {
  effect: PolicyEffect;
  ruleName?: string;
  reason: string;
};

export type PolicyEventContext = {
  event: string;
  trigger?: string;
  workflowId?: string;
  runId?: string;
  actor?: string;
  [key: string]: unknown;
};

export type PolicyRule = {
  name: string;
  event: string | string[];
  effect: PolicyEffect;
  reason?: string;
  conditions?: Record<string, unknown>;
};

export type PolicyDocument = {
  name: string;
  version: string;
  rules: PolicyRule[];
};

export function evaluatePolicy(doc: PolicyDocument, ctx: PolicyEventContext): PolicyDecision {
  const defaultDecision: PolicyDecision = { effect: "allow", reason: "no matching rule — default allow" };

  if (!doc?.rules?.length) return defaultDecision;

  for (const rule of doc.rules) {
    const eventPatterns: string[] = Array.isArray(rule.event) ? rule.event : [rule.event];
    const matches = eventPatterns.some(
      (p) => p === "*" || p === ctx.event || new RegExp(`^${p.replace(/\*/g, ".*")}$`).test(ctx.event),
    );
    if (!matches) continue;
    if (rule.conditions) {
      let conditionsMet = true;
      for (const [k, v] of Object.entries(rule.conditions)) {
        if (ctx[k] !== v) {
          conditionsMet = false;
          break;
        }
      }
      if (!conditionsMet) continue;
    }
    return {
      effect: rule.effect,
      ruleName: rule.name,
      reason: rule.reason ?? `matched rule: ${rule.name}`,
    };
  }

  return defaultDecision;
}

export async function loadPolicyDocument(path: string): Promise<PolicyDocument | null> {
  try {
    const raw = await Bun.file(path).text();
    const isYaml = path.endsWith(".yaml") || path.endsWith(".yml");
    let doc: PolicyDocument;

    if (isYaml) {
      doc = parseYaml(raw);
    } else {
      doc = JSON.parse(raw);
    }

    if (!doc.name || !doc.version || !Array.isArray(doc.rules)) {
      console.error(`[governance] invalid policy document at ${path}: missing name, version, or rules`);
      return null;
    }

    return doc;
  } catch (err) {
    console.error(`[governance] failed to load policy from ${path}:`, err);
    return null;
  }
}

function parseYaml(raw: string): PolicyDocument {
  const lines = raw.split("\n");
  const doc: Record<string, unknown> = { rules: [] };
  let currentKey = "";
  let ruleBuffer: Record<string, unknown>[] = [];
  let insideRules = false;
  let currentRule: Record<string, unknown> = {};
  let indent = 0;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const bare = line.replace(/^#.*/, "");
    if (!bare.trim()) continue;
    const match = bare.match(/^(\S[^:]*):\s*(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim();
      if (key === "rules") {
        insideRules = true;
        currentRule = {};
        continue;
      }
      if (!insideRules) {
        doc[key] = val || true;
      } else {
        if (Object.keys(currentRule).length > 0 && key !== "rules") {
          ruleBuffer.push(currentRule);
          currentRule = {};
        }
        currentRule[key] = val || true;
      }
    } else if (insideRules && line.includes("-")) {
      const m = bare.match(/^\s+-\s+(\S[^:]*):\s*(.*)$/);
      if (m) {
        if (Object.keys(currentRule).length > 0) {
          ruleBuffer.push(currentRule);
          currentRule = {};
        }
        currentRule[m[1].trim()] = m[2].trim() || true;
      }
    } else if (insideRules) {
      const m = bare.match(/^\s+(\S[^:]*):\s*(.*)$/);
      if (m) {
        currentRule[m[1].trim()] = m[2].trim() || true;
      }
    }
  }
  if (Object.keys(currentRule).length > 0) ruleBuffer.push(currentRule);
  doc.rules = ruleBuffer;
  return doc as PolicyDocument;
}