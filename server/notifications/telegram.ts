export type TelegramAlertResult =
  | { sent: true; chatId: string; length: number }
  | { sent: false; reason: "no-token" | "no-chat-id" | "fetch-failed" | "non-ok" };

const TELEGRAM_API_TIMEOUT_MS = 10_000;
const TELEGRAM_API_BASE = "https://api.telegram.org";

export async function sendTelegramAlert(text: string): Promise<boolean> {
  const result = await sendTelegramAlertDetailed(text);
  return result.sent;
}

export async function sendTelegramAlertDetailed(text: string): Promise<TelegramAlertResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token) return { sent: false, reason: "no-token" };
  if (!chatId) return { sent: false, reason: "no-chat-id" };
  if (typeof text !== "string" || text.length === 0) return { sent: false, reason: "no-chat-id" };

  const url = `${TELEGRAM_API_BASE}/bot${token}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TELEGRAM_API_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn(`[telegram] sendMessage non-ok status=${res.status}`);
      return { sent: false, reason: "non-ok" };
    }
    return { sent: true, chatId, length: text.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[telegram] sendMessage fetch failed: ${message.slice(0, 200)}`);
    return { sent: false, reason: "fetch-failed" };
  } finally {
    clearTimeout(timer);
  }
}
