import { describe, expect, test } from "bun:test";
import type {
  CredentialHealthStatus,
  CredentialHealthSummary,
  HealthBucket,
  HealthState,
} from "../../server/api/types";
import {
  HEALTH_GROUPS,
  credentialHealthView,
  credentialStatusGuidance,
  groupVisibleModels,
  healthStateBadge,
  healthSummaryItems,
  modelHealthFilterText,
  modelHealthSortValue,
  modelHealthView,
  type ModelHealthRow,
} from "./modelsHealthView";

const BUCKET_BY_STATE: Record<HealthState, HealthBucket> = {
  live: "healthy",
  limited: "healthy",
  slow: "healthy",
  degraded: "unhealthy",
  dead: "unhealthy",
  hang: "unhealthy",
  unknown: "unknown",
};

function row(logicalName: string, state: HealthState, extra: Partial<ModelHealthRow> = {}): ModelHealthRow {
  return {
    logicalName,
    provider: "cloud",
    providerType: "openrouter",
    qualityStatus: "healthy",
    healthState: state,
    healthBucket: BUCKET_BY_STATE[state],
    healthReason: `${state} evidence`,
    ...extra,
  };
}

describe("models health presentation", () => {
  test("maps all seven states to their shipped badge presentations", () => {
    const expected = {
      live: ["live", "green"],
      limited: ["limited", "amber"],
      slow: ["slow", "blue"],
      degraded: ["degraded", "orange"],
      dead: ["dead", "red"],
      hang: ["hang", "maroon"],
      unknown: ["unknown", "gray"],
    } as const;

    for (const [state, presentation] of Object.entries(expected) as Array<
      [HealthState, (typeof expected)[HealthState]]
    >) {
      const badge = healthStateBadge(state);
      expect([badge.label, badge.color]).toEqual([...presentation]);
    }

    expect(healthStateBadge("degraded").color).not.toBe(healthStateBadge("dead").color);
    expect(healthStateBadge("dead").color).not.toBe(healthStateBadge("hang").color);
    expect(healthStateBadge("degraded").color).not.toBe(healthStateBadge("hang").color);
  });

  test("defines the three operator groups and their exact state membership", () => {
    expect(HEALTH_GROUPS.map(({ bucket, label, states }) => ({ bucket, label, states }))).toEqual([
      { bucket: "healthy", label: "Healthy", states: ["live", "limited", "slow"] },
      { bucket: "unhealthy", label: "Needs attention", states: ["degraded", "dead", "hang"] },
      { bucket: "unknown", label: "Unobserved", states: ["unknown"] },
    ]);

    const grouped = groupVisibleModels([
      row("route-live", "live"),
      row("route-limited", "limited"),
      row("route-slow", "slow"),
      row("route-degraded", "degraded"),
      row("route-dead", "dead"),
      row("route-hang", "hang"),
      row("route-unknown", "unknown"),
    ]);

    expect(grouped.map((group) => ({
      label: group.label,
      rows: group.rows.map((model) => model.logicalName),
    }))).toEqual([
      { label: "Healthy", rows: ["route-live", "route-limited", "route-slow"] },
      { label: "Needs attention", rows: ["route-degraded", "route-dead", "route-hang"] },
      { label: "Unobserved", rows: ["route-unknown"] },
    ]);
  });

  test("falls back honestly when legacy health fields are missing", () => {
    const presentation = modelHealthView({ logicalName: "legacy-route" });

    expect(presentation.state).toBe("unknown");
    expect(presentation.bucket).toBe("unknown");
    expect(presentation.badge).toEqual({ label: "unknown", color: "gray" });
    expect(presentation.reason).toBe("health evidence is unavailable for this row");
    expect(presentation.recoveryCallout).toBeNull();
  });

  test("keeps every searched, sorted, paginated row in one visible group", () => {
    const rows = [
      row("01-live", "live"),
      row("02-limited", "limited"),
      row("03-slow", "slow"),
      row("04-degraded", "degraded"),
      row("05-dead", "dead"),
      row("06-hang", "hang"),
      row("07-unknown", "unknown"),
      row("local-only", "live", { provider: "local" }),
    ];
    const query = "cloud";
    const searched = rows.filter((model) => modelHealthFilterText(model).toLowerCase().includes(query));
    const sorted = [...searched].sort((a, b) =>
      Number(modelHealthSortValue(a, "healthState")) - Number(modelHealthSortValue(b, "healthState")),
    );
    const page = 2;
    const pageSize = 2;
    const visible = sorted.slice((page - 1) * pageSize, page * pageSize);
    const grouped = groupVisibleModels(visible);
    const groupedNames = grouped.flatMap((group) => group.rows.map((model) => model.logicalName));

    expect(searched).toHaveLength(7);
    expect(sorted.map((model) => model.healthState)).toEqual([
      "live", "limited", "slow", "degraded", "dead", "hang", "unknown",
    ]);
    expect(visible.map((model) => model.logicalName)).toEqual(["03-slow", "04-degraded"]);
    expect(groupedNames).toEqual(visible.map((model) => model.logicalName));
    expect(new Set(groupedNames).size).toBe(visible.length);
  });

  test("builds the three summary labels with their counts", () => {
    const items = healthSummaryItems({ healthy: 14, unhealthy: 39, unknown: 140 });

    expect(items.map((item) => `${item.label} ${item.count}`)).toEqual([
      "healthy 14",
      "needs attention 39",
      "unobserved 140",
    ]);
  });

  test("gives expanded degraded rows their reason and recovery callout", () => {
    const presentation = modelHealthView(row("earned-route", "degraded", {
      healthReason: "  earned route has five recent credential failures  ",
    }));

    expect(presentation.reason).toBe("earned route has five recent credential failures");
    expect(presentation.recoveryCallout).toEqual({
      lead: "Proven route needs recovery:",
      detail: "fix its credential or quota; do not drop its earned history.",
    });
  });

  test("gives every credential status safe, status-specific guidance", () => {
    const expected: Record<CredentialHealthStatus, string> = {
      valid: "no action needed",
      missing: "Configure",
      invalid: "Rotate",
      expired: "Rotate",
      revoked: "replacement",
      quota: "Restore",
      rate_limited: "back off",
      unknown: "Investigate",
    };

    for (const [status, phrase] of Object.entries(expected) as Array<[CredentialHealthStatus, string]>) {
      expect(credentialStatusGuidance(status)).toContain(phrase);
    }
  });

  test("credential presentation projects only safe fields and identifies gated models", () => {
    const checkedAt = Date.UTC(2026, 6, 18, 19, 30, 0);
    const raw = {
      envName: "OPENCODE_GO_API_KEY",
      provider: "opencode-go",
      status: "expired",
      httpCode: 401,
      checkedAt,
      sinceStatus: checkedAt - 60_000,
      gatesModels: ["coding-go-minimax-m3", "coding-go-other"],
      present: true,
      fresh: true,
      secretValue: "UI_RAW_SECRET_SENTINEL",
      providerBody: "UI_RAW_BODY_SENTINEL",
    } as CredentialHealthSummary & { secretValue: string; providerBody: string };

    const presentation = credentialHealthView(raw, checkedAt + 30 * 60 * 1000);
    expect(presentation).toEqual({
      envName: "OPENCODE_GO_API_KEY",
      status: "expired",
      statusLabel: "expired",
      statusColor: "red",
      freshnessLabel: "fresh",
      freshnessColor: "green",
      checkedAge: "30m ago",
      gatedModelCount: 2,
      gatedModels: ["coding-go-minimax-m3", "coding-go-other"],
      guidance: "Rotate the expired credential.",
    });
    expect(JSON.stringify(presentation)).not.toContain("UI_RAW_SECRET_SENTINEL");
    expect(JSON.stringify(presentation)).not.toContain("UI_RAW_BODY_SENTINEL");
    expect(JSON.stringify(presentation)).not.toContain("opencode-go");
  });
});
