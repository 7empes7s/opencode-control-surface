import { describe, expect, test } from "bun:test";
import { RunbookPanel } from "./InsightsPage";
import { lookupInsightRunbook } from "../../server/insights/runbooks";

describe("RunbookPanel", () => {
  test("renders the expected collapsible runbook copy", () => {
    const runbook = lookupInsightRunbook({
      domain: "ops",
      actionDescriptorId: "start-job:gateway:route-healthiest",
      sourceKey: "ops:provider-outage",
    });

    const element = RunbookPanel({ runbook }) as {
      type: string;
      props: { className?: string; children?: unknown };
    };
    const rendered = JSON.stringify(element.props.children);

    expect(element.type).toBe("details");
    expect(element.props.className).toContain("insight-runbook");
    expect(rendered).toContain("Runbook");
    expect(rendered).toContain("What this means");
    expect(rendered).toContain("What Apply does");
    expect(rendered).toContain("How to revert");
  });
});
