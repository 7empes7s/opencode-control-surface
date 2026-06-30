import type { InsightDomain } from "./types.ts";

export type InsightRunbookInput = {
  domain?: InsightDomain | string | null;
  actionDescriptorId?: string | null;
  sourceKey?: string | null;
};

export type InsightRunbook = {
  key: string;
  what: string;
  apply: string;
  revert: string;
};

const FALLBACK_RUNBOOK: InsightRunbook = {
  key: "generic",
  what: "This finding came from a detector or aggregator, but no detector-specific runbook is registered yet. Treat the title, AI analysis, and evidence references as the source of truth.",
  apply: "If an Apply button is available, it runs the exact action descriptor shown by the finding through the audited executor. If no Apply button is available, use the manual page link and the attached evidence.",
  revert: "Use the audit row and any rollback hint recorded by the executor. If no rollback hint exists, revert manually from the owning page and leave an audit note.",
};

function runbook(key: string, what: string, apply: string, revert: string): InsightRunbook {
  return { key, what, apply, revert };
}

function actionFamily(actionDescriptorId: string | null | undefined): string | null {
  if (!actionDescriptorId) return null;
  if (actionDescriptorId.startsWith("reasoner-remediate:")) return "reasoner-remediate:*";
  if (actionDescriptorId.startsWith("mutate-policy:autoapply:")) return "mutate-policy:autoapply:*";
  if (actionDescriptorId.startsWith("mutate-policy:model:") && actionDescriptorId.endsWith(":cooldown-clear")) return "mutate-policy:model:*:cooldown-clear";
  if (actionDescriptorId.startsWith("mutate-policy:model:")) return "mutate-policy:model:*";
  if (actionDescriptorId.startsWith("mutate-policy:budget:")) return "mutate-policy:budget:*";
  if (actionDescriptorId === "start-job:gateway:route-healthiest") return actionDescriptorId;
  if (actionDescriptorId === "start-job:gateway:clear-route-override") return actionDescriptorId;
  if (actionDescriptorId === "start-job:model-health:all") return actionDescriptorId;
  if (actionDescriptorId === "start-job:doctor:scan") return actionDescriptorId;
  if (actionDescriptorId === "start-job:infra:doctor-log-rotate") return actionDescriptorId;
  if (actionDescriptorId.startsWith("start-job:service:")) return "start-job:service:*";
  if (actionDescriptorId.startsWith("start-job:timer:")) return "start-job:timer:*";
  if (actionDescriptorId.startsWith("acknowledge:incident:")) return "acknowledge:incident:*";
  if (actionDescriptorId.startsWith("open-source:article:")) return "open-source:article:*";
  return null;
}

function sourceFamily(sourceKey: string | null | undefined): string | null {
  if (!sourceKey) return null;
  if (sourceKey.startsWith("ops:service-down:")) return "ops:service-down:*";
  if (sourceKey.startsWith("ops:failed-timer:")) return "ops:failed-timer:*";
  if (sourceKey.startsWith("ops:cooldown-stuck:")) return "ops:cooldown-stuck:*";
  if (sourceKey.startsWith("ops:sla-breach:")) return "ops:sla-breach:*";
  if (sourceKey.startsWith("edge:site-unreachable:")) return "edge:site-unreachable:*";
  if (sourceKey.startsWith("edge:cert-expiring:")) return "edge:cert-expiring:*";
  if (sourceKey.startsWith("edge:dns-fail:")) return "edge:dns-fail:*";
  if (sourceKey.startsWith("security:config-selfcheck:")) return "security:config-selfcheck:*";
  if (sourceKey.startsWith("budget:")) return "budget:*";
  if (sourceKey.startsWith("cost:")) return "cost:*";
  if (sourceKey.startsWith("registry:")) return "registry:*";
  if (sourceKey.startsWith("data:content_health:")) return "data:content_health:*";
  if (sourceKey.startsWith("security:")) return "security:*";
  if (sourceKey.startsWith("ops:")) return "ops:*";
  if (sourceKey.startsWith("edge:")) return "edge:*";
  return null;
}

const RUNBOOKS: Record<string, InsightRunbook> = {
  "reasoner-remediate:*": runbook(
    "reasoner-remediate:*",
    "A build or incident detector matched a stored reasoner playbook to a failed workflow/pass, using the representative diagnosis as evidence.",
    "Apply calls the reasoner playbook endpoint with the playbook, workflow, pass, and optional incident identifiers, then records the outcome in action audit.",
    "There is no universal automatic rollback for a playbook. Use the generated audit row, builder run history, and changed workflow artifacts to undo the specific playbook effect.",
  ),
  "mutate-policy:autoapply:*": runbook(
    "mutate-policy:autoapply:*",
    "The auto-apply policy registry controls whether a known remediation runs automatically, waits for review, or is disabled.",
    "Apply changes one policy key to the requested tier through the audited executor; it does not execute the remediation itself.",
    "Set the same policy key back to its previous tier from the Autonomy Policy tab or use the prior config-change audit row as the rollback reference.",
  ),
  "mutate-policy:model:*:cooldown-clear": runbook(
    "mutate-policy:model:*:cooldown-clear",
    "A model cooldown has expired but is still present, which can keep an otherwise usable model out of routing.",
    "Apply removes that model from the cooldown file so routing can consider it again on the next health check.",
    "There is no generated inverse cooldown. If the model is still bad, block it or let the model health checker recreate a cooldown from fresh failures.",
  ),
  "mutate-policy:model:*": runbook(
    "mutate-policy:model:*",
    "A model quality or routing policy needs adjustment, usually to block or unblock a model based on detector evidence.",
    "Apply writes the requested model quality status through the audited executor.",
    "For block/unblock actions the executor records the inverse action as a rollback hint; otherwise use the Models page and audit row to restore the prior state.",
  ),
  "mutate-policy:budget:*": runbook(
    "mutate-policy:budget:*",
    "A budget detector found spending close to or over a configured cap, or a missing cap for governed AI usage.",
    "Apply writes a global or project budget cap through governance budget storage so future gateway calls are governed by that cap.",
    "Restore the previous cap from the budget history/audit row or edit the budget again from Cost/Governance.",
  ),
  "start-job:gateway:route-healthiest": runbook(
    "start-job:gateway:route-healthiest",
    "Gateway routing can be improved because the current route is unhealthy, unavailable, or more expensive than a healthy alternative.",
    "Apply selects the healthiest known gateway model and creates a time-limited route override.",
    "Use `start-job:gateway:clear-route-override` or wait for the override TTL to expire; the executor records that rollback hint for applied findings.",
  ),
  "start-job:gateway:clear-route-override": runbook(
    "start-job:gateway:clear-route-override",
    "A previous gateway route override should be cleared so normal routing policy can resume.",
    "Apply removes the current gateway route override.",
    "Recreate a route override with `start-job:gateway:route-healthiest` or choose a route from the Gateway page if clearing was premature.",
  ),
  "start-job:model-health:all": runbook(
    "start-job:model-health:all",
    "Model discovery or health data is stale, so routing may be using outdated availability evidence.",
    "Apply enqueues the model-health check job without waiting for it to finish.",
    "There is no state to roll back; keep the prior health file if the job writes bad data and inspect the model-health service journal.",
  ),
  "start-job:doctor:scan": runbook(
    "start-job:doctor:scan",
    "Pipeline failure evidence is stale or elevated and needs a fresh doctor pass to classify the current failure mode.",
    "Apply starts the doctor scan endpoint/job and records the scan request.",
    "There is no mutation to undo; if the scan result is noisy, keep the prior diagnosis and rerun after the pipeline stabilizes.",
  ),
  "start-job:infra:doctor-log-rotate": runbook(
    "start-job:infra:doctor-log-rotate",
    "The doctor log file has grown beyond the operational threshold and can slow scans or consume disk.",
    "Apply gzips the current doctor log to a timestamped file and truncates the active log.",
    "Restore from the timestamped gzip archive if the active log needs to be reconstructed.",
  ),
  "start-job:service:*": runbook(
    "start-job:service:*",
    "A service or tunnel unit is inactive/failed and the detector believes restarting it is the standard recovery path.",
    "Apply restarts only allowlisted services or containers through the audited executor.",
    "If restart made things worse, inspect the service journal and either stop it, restart the previous dependency, or restore configuration from the linked audit evidence.",
  ),
  "start-job:timer:*": runbook(
    "start-job:timer:*",
    "A system timer failed or missed its expected run, leaving scheduled maintenance or data refresh stale.",
    "Apply starts the allowlisted timer's service unit once.",
    "There is no persistent state to revert; inspect the timer service journal and let the next scheduled run proceed.",
  ),
  "acknowledge:incident:*": runbook(
    "acknowledge:incident:*",
    "An incident has aged past its SLA threshold and needs a lifecycle acknowledgement, not a separate monitoring task.",
    "Apply records an incident acknowledgement through the action executor when lifecycle support is available.",
    "Acknowledgement is an audit/lifecycle state. Reopen or update the incident from the Incidents page if the acknowledgement was wrong.",
  ),
  "open-source:article:*": runbook(
    "open-source:article:*",
    "A content-health detector found an issue in a specific article source file.",
    "Apply opens or routes to the article source for manual correction; it does not rewrite content automatically.",
    "Use git/editor history to undo content edits.",
  ),
  "security:config-selfcheck:*": runbook(
    "security:config-selfcheck:*",
    "The auth/config self-check found missing setup or stale readiness evidence such as token presence, secrets metadata, sentinel freshness, ingestor freshness, or tunnel state.",
    "There is no one-click Apply because the detector is read-only; use the linked setup, governance, infra, or admin page to repair the failed check.",
    "No mutation is performed by the detector. Revert the underlying environment or config change if a repair was incorrect.",
  ),
  "edge:site-unreachable:*": runbook(
    "edge:site-unreachable:*",
    "The public HTTP probe failed for a discovered public target, so users or health checks may not be reaching the service.",
    "Apply is only available when a safe service/tunnel restart descriptor exists; otherwise use Infra to repair DNS, tunnel, TLS, or the backend service.",
    "Undo any service restart or routing change from the audit row; DNS/TLS/backend edits must be reverted in their owning system.",
  ),
  "edge:cert-expiring:*": runbook(
    "edge:cert-expiring:*",
    "The TLS certificate for a public endpoint is inside the expiry warning window.",
    "No automatic Apply is registered; renew the certificate or repair the tunnel/certificate automation from Infra.",
    "If renewal points to the wrong certificate, restore the previous certificate configuration in the certificate/tunnel provider.",
  ),
  "edge:dns-fail:*": runbook(
    "edge:dns-fail:*",
    "DNS lookup failed for a public target discovered by the edge scanner.",
    "No automatic Apply is registered; fix the DNS record or tunnel hostname from the owning provider.",
    "Revert DNS changes in the provider's change history if the repair was wrong.",
  ),
  "budget:*": runbook(
    "budget:*",
    "The budget scanner compared current spend with configured governance caps and found warning or exceeded usage.",
    "If an Apply button exists, it updates a budget cap; otherwise review Cost/Gateway and let the existing cap enforcement continue.",
    "Restore the previous cap from audit/config history or edit the budget again.",
  ),
  "cost:*": runbook(
    "cost:*",
    "A cost detector found spend anomaly, low runway, or a cheaper healthy route.",
    "Apply routes traffic to a healthier/cheaper model only when the finding carries a gateway route descriptor; other cost findings are review-only.",
    "Clear any gateway route override or restore budget settings from the audit row.",
  ),
  "ops:service-down:*": runbook(
    "ops:service-down:*",
    "A system service or container reports inactive/failed and may be affecting the control surface or adjacent stack services.",
    "Apply restarts only the allowlisted service/container named in the action descriptor.",
    "If restart fails or harms traffic, inspect the journal/container logs and restore the previous service configuration from deployment history.",
  ),
  "ops:failed-timer:*": runbook(
    "ops:failed-timer:*",
    "A maintenance timer is failed, so its scheduled work may not have run.",
    "Apply is not always available; when present it starts the allowlisted timer service once.",
    "There is no persisted mutation to revert; inspect the timer unit and wait for the next scheduled cycle.",
  ),
  "ops:cooldown-stuck:*": runbook(
    "ops:cooldown-stuck:*",
    "An expired model cooldown is still present and can unnecessarily remove a model from routing.",
    "Apply clears that model's cooldown entry from the cooldown file.",
    "If the model is still unhealthy, block it from Models or let a fresh health check recreate the cooldown.",
  ),
  "ops:sla-breach:*": runbook(
    "ops:sla-breach:*",
    "An open incident exceeded the configured SLA age threshold.",
    "Apply acknowledges the incident when lifecycle execution is available; otherwise use Incidents to acknowledge, mitigate, or resolve.",
    "Update or reopen the incident lifecycle state from Incidents if the acknowledgement was wrong.",
  ),
  "registry:*": runbook(
    "registry:*",
    "The registry scanner found an agent/inventory ownership or activity gap.",
    "No automatic Apply is registered; update ownership, registry status, or ignore state from the linked Agents/Inventory surface.",
    "Revert registry changes from the owning page and audit row.",
  ),
  "data:content_health:*": runbook(
    "data:content_health:*",
    "Content health found stale, weak, or inconsistent article data.",
    "Apply opens the source article when available; content edits remain manual and auditable through git/editor history.",
    "Revert content edits through source control or restore the previous article file.",
  ),
  "security:*": runbook(
    "security:*",
    "A security scanner found weak secrets, suspicious activity, policy drift, trust score regression, or compliance gaps.",
    "Most security findings are read-only and link to Governance, Security, Compliance, Audit, or Settings; budget-related findings may expose an audited budget mutation.",
    "Revert the specific policy, secret metadata, access, or budget change from the owning page and audit/config history.",
  ),
  "ops:*": runbook(
    "ops:*",
    "An operations scanner found stale evidence, failed maintenance, pressure, outage, or pipeline/model degradation.",
    "Apply runs only the attached allowlisted action; otherwise use the linked operational page and evidence.",
    "Use the action audit rollback hint when one exists; otherwise revert the underlying ops change manually.",
  ),
  "edge:*": runbook(
    "edge:*",
    "The edge scanner found reachability, DNS, TLS, tunnel, or external runway degradation.",
    "Apply exists only for safe, allowlisted recovery actions such as restarting a known tunnel service.",
    "Undo the exact service/config/provider change from its audit row or provider history.",
  ),
};

export function lookupInsightRunbook(input: InsightRunbookInput): InsightRunbook {
  const family = actionFamily(input.actionDescriptorId);
  if (family && RUNBOOKS[family]) return RUNBOOKS[family];
  const source = sourceFamily(input.sourceKey);
  if (source && RUNBOOKS[source]) return RUNBOOKS[source];
  if (input.domain === "security" && RUNBOOKS["security:*"]) return RUNBOOKS["security:*"];
  if (input.domain === "ops" && RUNBOOKS["ops:*"]) return RUNBOOKS["ops:*"];
  if (input.domain === "cost" && RUNBOOKS["cost:*"]) return RUNBOOKS["cost:*"];
  return FALLBACK_RUNBOOK;
}

export const __test_only = {
  actionFamily,
  sourceFamily,
  RUNBOOKS,
  FALLBACK_RUNBOOK,
};
