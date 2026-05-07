import { homeHandler } from "./home.ts";

// GET /api/stream — SSE endpoint for live home data
export function streamHandler(): Response {
  const encoder = new TextEncoder();
  let pushInterval: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const push = async () => {
        try {
          const resp = await homeHandler();
          const text = await resp.text();
          ctrl.enqueue(encoder.encode(`data: ${text}\n\n`));
        } catch {
          ctrl.enqueue(encoder.encode(": error\n\n"));
        }
      };

      await push();
      pushInterval = setInterval(push, 5_000);
      heartbeat = setInterval(
        () => ctrl.enqueue(encoder.encode(": heartbeat\n\n")),
        25_000,
      );
    },
    cancel() {
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
