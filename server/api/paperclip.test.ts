import { describe, expect, test } from "bun:test";
import {
  normalizePaperclipAgents,
  normalizePaperclipTasks,
  parsePaperclipAgentRows,
  parsePaperclipTaskRows,
} from "./paperclip.ts";

describe("Paperclip API normalization", () => {
  test("normalizes agent API payloads with adapter config", () => {
    const agents = normalizePaperclipAgents({
      data: {
        agents: [{
          id: "agent-1",
          name: "Verification Desk",
          adapter_type: "gemini_local",
          adapter_config: { command: "node verify.mjs", model: "editorial-heavy" },
          status: "idle",
          consecutive_failures: "2",
        }],
      },
    });

    expect(agents).toEqual([{
      id: "agent-1",
      name: "Verification Desk",
      role: null,
      adapterType: "gemini_local",
      command: "node verify.mjs",
      model: "editorial-heavy",
      status: "idle",
      lastRunAt: null,
      lastError: null,
      consecutiveFailures: 2,
    }]);
  });

  test("normalizes task API payloads", () => {
    const tasks = normalizePaperclipTasks({
      tasks: [{
        run_id: "run-1",
        agent_id: "agent-1",
        agent_name: "Verification Desk",
        status: "failed",
        priority: "high",
        started_at: "2026-05-18T01:00:00Z",
        finished_at: "2026-05-18T01:05:00Z",
        error: "timeout",
      }],
    });

    expect(tasks[0]).toEqual({
      id: "run-1",
      agentId: "agent-1",
      agentName: "Verification Desk",
      status: "failed",
      priority: "high",
      createdAt: null,
      startedAt: "2026-05-18T01:00:00Z",
      finishedAt: "2026-05-18T01:05:00Z",
      error: "timeout",
    });
  });

  test("parses tab-separated database rows", () => {
    expect(parsePaperclipAgentRows("a1\tNews Desk\topenclaw_gateway\tnode desk.mjs\teditorial-fast\tbusy")).toEqual([{
      id: "a1",
      name: "News Desk",
      role: null,
      adapterType: "openclaw_gateway",
      command: "node desk.mjs",
      model: "editorial-fast",
      status: "busy",
      lastRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
    }]);

    expect(parsePaperclipTaskRows("r1\ta1\tNews Desk\tcompleted\t2026-05-18 01:00:00+00\t2026-05-18 01:03:00+00")).toEqual([{
      id: "r1",
      agentId: "a1",
      agentName: "News Desk",
      status: "completed",
      priority: null,
      createdAt: "2026-05-18 01:00:00+00",
      startedAt: "2026-05-18 01:00:00+00",
      finishedAt: "2026-05-18 01:03:00+00",
      error: null,
    }]);
  });
});
