type BrainstormEventListener = {
  sessionId: string;
  controller: ReadableStreamDefaultController;
};

const brainstormListeners = new Map<string, BrainstormEventListener[]>();

export function broadcastBrainstormEvent(tenantId: string, sessionId: string, type: string, data: unknown): void {
  const key = `${tenantId}:${sessionId}`;
  const listeners = brainstormListeners.get(key) ?? [];
  const payload = JSON.stringify({ type, ...(data as Record<string, unknown>) });

  for (const listener of listeners) {
    try {
      listener.controller.enqueue(`data: ${payload}\n\n`);
    } catch {
      // Client disconnected — remove
    }
  }
}

export function createBrainstormStream(tenantId: string, sessionId: string): ReadableStream {
  const encoder = new TextEncoder();
  const key = `${tenantId}:${sessionId}`;

  return new ReadableStream({
    start(controller) {
      const existing = brainstormListeners.get(key) ?? [];
      existing.push({ sessionId, controller });
      brainstormListeners.set(key, existing);

      controller.enqueue(`data: ${JSON.stringify({ type: 'connected', sessionId })}\n\n`);
    },
    cancel() {
      const existing = brainstormListeners.get(key) ?? [];
      const remaining = existing.filter(l => l.sessionId !== sessionId);
      if (remaining.length > 0) {
        brainstormListeners.set(key, remaining);
      } else {
        brainstormListeners.delete(key);
      }
    },
  });
}

export function brainstormStreamHandler(tenantId: string, sessionId: string): Response {
  return new Response(createBrainstormStream(tenantId, sessionId), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}