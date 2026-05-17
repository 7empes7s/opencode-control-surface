import { describe, expect, test } from "bun:test";
import { extractPathCandidates, summarizeMessages } from "./AgentBuilderHandoffButton";

describe("extractPathCandidates", () => {
  test("keeps longer TypeScript and JavaScript extensions intact", () => {
    expect(extractPathCandidates("Changed app/routes/BuilderPage.tsx and app/components/Widget.jsx.")).toEqual([
      "app/routes/BuilderPage.tsx",
      "app/components/Widget.jsx",
    ]);
  });

  test("captures test files without truncating their extension", () => {
    expect(extractPathCandidates("See server/api/builder.test.ts and app/routes/Foo.test.tsx.")).toEqual([
      "server/api/builder.test.ts",
      "app/routes/Foo.test.tsx",
    ]);
  });

  test("ignores protocol-relative URLs from agent output", () => {
    expect(extractPathCandidates("Usage details: //chatgpt.com/codex/settings/usage and server/api/builder.ts")).toEqual([
      "server/api/builder.ts",
    ]);
  });
});

describe("summarizeMessages", () => {
  test("captures handoff context needed by Builder run detail", () => {
    const summary = summarizeMessages([
      {
        role: "user",
        content: "Continue the scheduler plan from /root/DASHBOARD_V4_SCHEDULER_PLAN.md",
      },
      {
        role: "assistant",
        content: "Updated app/routes/BuilderPage.tsx and server/api/builder.ts for source sessions.",
        filePaths: ["app/routes/BuilderPage.tsx"],
      },
      {
        role: "tool",
        toolText: "Validated server/api/builder.test.ts with bun test.",
      },
      {
        role: "user",
        content: "Dogfood the chat handoff into Builder.",
      },
    ]);

    expect(summary.latestUserPrompt).toContain("Dogfood the chat handoff");
    expect(summary.assistantSummary).toContain("source sessions");
    expect(summary.transcriptSummary).toContain("Recent turns:");
    expect(summary.touchedFiles).toEqual([
      "/root/DASHBOARD_V4_SCHEDULER_PLAN.md",
      "app/routes/BuilderPage.tsx",
      "server/api/builder.ts",
      "server/api/builder.test.ts",
    ]);
    expect(summary.touchedFileSummary).toContain("4 files referenced");
    expect(summary.recentTurns?.map((turn) => turn.role)).toEqual(["user", "assistant", "tool", "user"]);
  });
});
