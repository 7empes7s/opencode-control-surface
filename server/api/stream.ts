import { homeHandler } from "./home.ts";

// GET /api/stream — SSE endpoint for live home data
export function streamHandler(): Response {
  const encoder = new TextEncoder();
  let pushInterval: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enqueue = (text: string) => {
        if (closed) return;
        try {
          ctrl.enqueue(encoder.encode(text));
        } catch {
          closed = true;
          clearInterval(pushInterval);
          clearInterval(heartbeat);
        }
      };
      const push = async () => {
        try {
          const resp = await homeHandler();
          const text = await resp.text();
          enqueue(`data: ${text}\n\n`);
        } catch {
          enqueue(": error\n\n");
        }
      };

      await push();
      pushInterval = setInterval(push, 5_000);
      heartbeat = setInterval(
        () => enqueue(": heartbeat\n\n"),
        25_000,
      );
    },
    cancel() {
      closed = true;
      clearInterval(pushInterval);
      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
