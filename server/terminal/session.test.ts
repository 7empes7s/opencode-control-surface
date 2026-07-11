import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { expectedLegacySessionValue } from "../auth/session.ts";
import {
  isTerminalOriginAllowed,
  parseTerminalClientMessage,
  terminalSessionName,
  terminalStatusHandler,
} from "./session.ts";

let previousToken: string | undefined;
let previousSession: string | undefined;

beforeEach(() => {
  previousToken = process.env.OPERATOR_TOKEN;
  previousSession = process.env.DASHBOARD_TERMINAL_SESSION;
  process.env.OPERATOR_TOKEN = "test-token";
  process.env.DASHBOARD_TERMINAL_SESSION = "terminal-test";
});

afterEach(() => {
  if (previousToken === undefined) delete process.env.OPERATOR_TOKEN;
  else process.env.OPERATOR_TOKEN = previousToken;
  if (previousSession === undefined) delete process.env.DASHBOARD_TERMINAL_SESSION;
  else process.env.DASHBOARD_TERMINAL_SESSION = previousSession;
});

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://control.example.test/api/terminal/status", {
    headers: {
      host: "control.example.test",
      origin: "https://control.example.test",
      ...headers,
    },
  });
}

describe("root terminal boundary", () => {
  test("accepts only a same-host browser origin", () => {
    expect(isTerminalOriginAllowed(request())).toBe(true);
    expect(isTerminalOriginAllowed(request({ origin: "https://evil.example.test" }))).toBe(false);
    expect(isTerminalOriginAllowed(request({ origin: "not-a-url" }))).toBe(false);
  });

  test("status requires the operator bootstrap cookie", async () => {
    expect(terminalStatusHandler(request()).status).toBe(401);

    const cookie = `operator_session=${expectedLegacySessionValue("test-token")}`;
    const response = terminalStatusHandler(request({ cookie }));
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      user: "root",
      cwd: "/root",
      persistent: true,
      session: "terminal-test",
    });
  });

  test("sanitizes configured tmux session names", () => {
    process.env.DASHBOARD_TERMINAL_SESSION = "../../bad;name";
    expect(terminalSessionName()).toBe("tib-root");
  });
});

describe("terminal client protocol", () => {
  test("parses input and clamps resize dimensions", () => {
    expect(parseTerminalClientMessage(JSON.stringify({ type: "input", data: "codex\r" }))).toEqual({
      ok: true,
      message: { type: "input", data: "codex\r" },
    });
    expect(parseTerminalClientMessage(JSON.stringify({ type: "resize", cols: 2, rows: 9999 }))).toEqual({
      ok: true,
      message: { type: "resize", cols: 20, rows: 200 },
    });
  });

  test("accepts binary PTY input and rejects malformed messages", () => {
    expect(parseTerminalClientMessage(new Uint8Array([3]))).toEqual({
      ok: true,
      message: { type: "input", data: new Uint8Array([3]) },
    });
    expect(parseTerminalClientMessage("not json")).toEqual({ ok: false, error: "invalid terminal message" });
    expect(parseTerminalClientMessage(JSON.stringify({ type: "restart" }))).toEqual({
      ok: false,
      error: "unsupported terminal message",
    });
  });
});
