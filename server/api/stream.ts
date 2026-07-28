import { homeHandler } from "./home.ts";

type StreamHandlerOptions = {
  homeHandler?: typeof homeHandler;
  pushIntervalMs?: number;
  heartbeatIntervalMs?: number;
};

// GET /api/stream — SSE endpoint for live home data
export function streamHandler(options: StreamHandlerOptions = {}): Response {
  const encoder = new TextEncoder();
  const buildHomeResponse = options.homeHandler ?? homeHandler;
  const pushIntervalMs = options.pushIntervalMs ?? 15_000;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
  let pushInterval: ReturnType<typeof setInterval> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const enqueue = (text: string) => {
        if (closed) return;
        try {
          ctrl.enqueue(encoder.encode(text));
          // Consumer stopped reading (disconnected client): queue backs up — self-terminate.
          if (ctrl.desiredSize !== null && ctrl.desiredSize < -3) {
            closed = true;
            clearInterval(pushInterval);
            clearInterval(heartbeat);
          }
        } catch {
          closed = true;
          clearInterval(pushInterval);
          clearInterval(heartbeat);
        }
      };
      const push = async () => {
        try {
          const resp = await buildHomeResponse();
          const text = await resp.text();
          enqueue(`data: ${text}\n\n`);
        } catch {
          enqueue(": error\n\n");
        }
      };

      await push();
      // The client can disconnect while the initial home build is in flight.
      // cancel() has already run in that case, so starting timers here would
      // create a permanent background pump with no client to clear it.
      if (closed) return;
      pushInterval = setInterval(push, pushIntervalMs);
      heartbeat = setInterval(
        () => enqueue(": heartbeat\n\n"),
        heartbeatIntervalMs,
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
