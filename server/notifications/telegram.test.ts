import { afterEach, describe, expect, test } from "bun:test";
import { sendTelegramAlert, sendTelegramAlertDetailed } from "./telegram.ts";

let prevToken: string | undefined;
let prevChat: string | undefined;
let prevFetch: typeof fetch | null | undefined;

afterEach(() => {
  if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = prevToken;
  if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
  else process.env.TELEGRAM_CHAT_ID = prevChat;
  if (prevFetch === undefined) {
    (globalThis as { __telegramTestFetch?: typeof fetch }).__telegramTestFetch = undefined;
  } else {
    globalThis.fetch = prevFetch;
  }
});

function capturePrevEnv(): void {
  prevToken = process.env.TELEGRAM_BOT_TOKEN;
  prevChat = process.env.TELEGRAM_CHAT_ID;
  prevFetch = globalThis.fetch;
}

describe("sendTelegramAlert — env-less no-op", () => {
  test("returns false and never calls fetch when TELEGRAM_BOT_TOKEN is unset", async () => {
    capturePrevEnv();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await sendTelegramAlert("hello world");
    expect(ok).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  test("returns detailed result with reason=no-token when TELEGRAM_BOT_TOKEN is unset", async () => {
    capturePrevEnv();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    const detailed = await sendTelegramAlertDetailed("hello world");
    expect(detailed.sent).toBe(false);
    expect(detailed).toEqual({ sent: false, reason: "no-token" });
  });

  test("returns detailed result with reason=no-chat-id when only token is set", async () => {
    capturePrevEnv();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    delete process.env.TELEGRAM_CHAT_ID;

    const detailed = await sendTelegramAlertDetailed("hello world");
    expect(detailed.sent).toBe(false);
    expect(detailed).toEqual({ sent: false, reason: "no-chat-id" });
  });

  test("returns false (never throws) when fetch rejects", async () => {
    capturePrevEnv();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "1234";

    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const ok = await sendTelegramAlert("hi");
    expect(ok).toBe(false);
  });

  test("returns false when fetch returns a non-OK status", async () => {
    capturePrevEnv();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "1234";

    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const ok = await sendTelegramAlert("hi");
    expect(ok).toBe(false);
  });

  test("returns true and posts to Telegram API on success", async () => {
    capturePrevEnv();
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_CHAT_ID = "1234";

    let capturedUrl: string | null = null;
    let capturedBody: unknown = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
      capturedBody = init?.body;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const ok = await sendTelegramAlert("hello from the test");
    expect(ok).toBe(true);
    expect(capturedUrl).toBe("https://api.telegram.org/bottest-token/sendMessage");
    expect(typeof capturedBody).toBe("string");
    const parsed = JSON.parse(capturedBody as string) as {
      chat_id: string;
      text: string;
      disable_web_page_preview: boolean;
    };
    expect(parsed.chat_id).toBe("1234");
    expect(parsed.text).toBe("hello from the test");
    expect(parsed.disable_web_page_preview).toBe(true);
  });
});
