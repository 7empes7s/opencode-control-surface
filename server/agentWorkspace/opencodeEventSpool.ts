import type { AgentIdentity, AgentSession } from "./registry.ts";
import {
  appendAgentEvent,
  canViewAgentSession,
  getAgentSessionByAdapter,
  isInternalAdapterSession,
  isReservedOpenCodeTitle,
  recordInternalVisibility,
  listAgentEvents,
} from "./registry.ts";

const DEFAULT_OPENCODE_URL = process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
const MAX_EVENT_BYTES = 512 * 1024;

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type OpenCodeEvent = { type?: unknown; properties?: unknown };
type Subscriber = {
  identity: AgentIdentity;
  controller: ReadableStreamDefaultController<Uint8Array>;
  keepAlive: ReturnType<typeof setInterval>;
};

const encoder = new TextEncoder();
const subscribers = new Set<Subscriber>();
let spoolAbort: AbortController | null = null;
let spoolLoop: Promise<void> | null = null;
let eventFetch: FetchLike = fetch;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function extractOpenCodeEventSessionId(event: OpenCodeEvent): string | null {
  const props = object(event.properties);
  if (!props) return null;
  const candidates = [
    props.sessionID,
    object(props.session)?.id,
    object(props.info)?.sessionID,
    object(props.part)?.sessionID,
    object(props.permission)?.sessionID,
  ];
  return candidates.find((value): value is string => typeof value === "string" && /^ses_[A-Za-z0-9]+$/.test(value)) ?? null;
}

function eventTitle(event: OpenCodeEvent): string | null {
  const props = object(event.properties);
  const session = object(props?.session);
  const info = object(props?.info);
  const title = session?.title ?? info?.title ?? props?.title;
  return typeof title === "string" ? title : null;
}

export function parseOpenCodeSseFrames(buffer: string): { events: OpenCodeEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const frames = normalized.split("\n\n");
  const remainder = frames.pop() ?? "";
  const events: OpenCodeEvent[] = [];
  for (const frame of frames) {
    const data = frame.split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || Buffer.byteLength(data) > MAX_EVENT_BYTES) continue;
    try {
      const parsed = JSON.parse(data) as OpenCodeEvent;
      if (parsed && typeof parsed === "object") events.push(parsed);
    } catch {
      // Upstream malformed frames are never forwarded.
    }
  }
  return { events, remainder };
}

function encodedEvent(event: OpenCodeEvent, id?: string): Uint8Array {
  return encoder.encode(`${id ? `id: ${id}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
}

function removeSubscriber(subscriber: Subscriber): void {
  clearInterval(subscriber.keepAlive);
  subscribers.delete(subscriber);
}

function broadcast(event: OpenCodeEvent, session: AgentSession, sequence: number): void {
  const data = encodedEvent(event, `${session.id}:${sequence}`);
  for (const subscriber of [...subscribers]) {
    if (!canViewAgentSession(subscriber.identity, session)) continue;
    try {
      subscriber.controller.enqueue(data);
    } catch {
      removeSubscriber(subscriber);
    }
  }
}

export function createOpenCodeEventResponse(identity: AgentIdentity, lastEventId?: string | null): Response {
  let subscriber: Subscriber | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const keepAlive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": keepalive\n\n")); }
        catch { if (subscriber) removeSubscriber(subscriber); }
      }, 15_000);
      subscriber = { identity, controller, keepAlive };
      subscribers.add(subscriber);
      controller.enqueue(encodedEvent({ type: "server.connected", properties: {} }));
      if (lastEventId) {
        const split = lastEventId.lastIndexOf(":");
        const sessionId = split > 0 ? lastEventId.slice(0, split) : "";
        const sequence = split > 0 ? Number(lastEventId.slice(split + 1)) : Number.NaN;
        if (sessionId && Number.isFinite(sequence)) {
          for (const event of listAgentEvents(identity, sessionId, sequence, 1000)) {
            controller.enqueue(encodedEvent(
              { type: event.kind, properties: event.payload },
              `${sessionId}:${event.sequence}`,
            ));
          }
        }
      }
    },
    cancel() {
      if (subscriber) removeSubscriber(subscriber);
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

async function processEvent(event: OpenCodeEvent): Promise<void> {
  const adapterSessionId = extractOpenCodeEventSessionId(event);
  if (!adapterSessionId) return;
  const title = eventTitle(event);
  if (isReservedOpenCodeTitle(title)) {
    recordInternalVisibility({
      harness: "opencode",
      adapterSessionId,
      reason: "reserved internal producer marker",
      source: "opencode-reserved-marker-v1",
      evidence: { marker: "__mimule_probe_v1__:" },
    });
    return;
  }
  if (isInternalAdapterSession("opencode", adapterSessionId)) return;
  const session = getAgentSessionByAdapter("opencode", adapterSessionId);
  if (!session || session.internal) return;
  const kind = typeof event.type === "string" ? event.type : "opencode.event";
  const payload = object(event.properties) ?? {};
  const stored = appendAgentEvent({ session, kind, payload });
  broadcast(event, session, stored.sequence);
}

async function consumeOpenCodeEvents(signal: AbortSignal, upstreamUrl: string): Promise<void> {
  const response = await eventFetch(`${upstreamUrl}/event`, {
    headers: { Accept: "text/event-stream" },
    signal,
  });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_EVENT_BYTES * 2) buffer = buffer.slice(-MAX_EVENT_BYTES);
      const parsed = parseOpenCodeSseFrames(buffer);
      buffer = parsed.remainder;
      for (const event of parsed.events) await processEvent(event);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

async function reconcileReservedSessions(signal: AbortSignal, upstreamUrl: string): Promise<void> {
  const response = await eventFetch(`${upstreamUrl}/session?limit=5000`, { signal });
  if (!response.ok) throw new Error(`OpenCode session reconcile HTTP ${response.status}`);
  const sessions = await response.json() as unknown;
  if (!Array.isArray(sessions) || sessions.length >= 5000) {
    throw new Error("OpenCode session reconcile response is invalid or truncated");
  }
  for (const value of sessions) {
    const session = object(value);
    const id = session?.id;
    if (typeof id !== "string" || !/^ses_[A-Za-z0-9]+$/.test(id) || !isReservedOpenCodeTitle(session?.title)) continue;
    recordInternalVisibility({
      harness: "opencode",
      adapterSessionId: id,
      reason: "reserved internal producer marker",
      source: "opencode-reserved-marker-v1",
      evidence: { marker: "__mimule_probe_v1__:" },
    });
  }
}

async function reconnectLoop(signal: AbortSignal, upstreamUrl: string): Promise<void> {
  while (!signal.aborted) {
    try {
      await reconcileReservedSessions(signal, upstreamUrl);
      await consumeOpenCodeEvents(signal, upstreamUrl);
    } catch (error) {
      if (!signal.aborted) {
        console.warn("[agent-workspace] OpenCode event spool reconnecting", error instanceof Error ? error.message : String(error));
      }
    }
    if (signal.aborted) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }
}

export function startOpenCodeEventSpool(upstreamUrl = DEFAULT_OPENCODE_URL): { stop: () => void } {
  if (spoolAbort) return { stop: stopOpenCodeEventSpool };
  spoolAbort = new AbortController();
  spoolLoop = reconnectLoop(spoolAbort.signal, upstreamUrl).finally(() => {
    spoolLoop = null;
    spoolAbort = null;
  });
  return { stop: stopOpenCodeEventSpool };
}

export function stopOpenCodeEventSpool(): void {
  spoolAbort?.abort();
  for (const subscriber of [...subscribers]) {
    removeSubscriber(subscriber);
    try { subscriber.controller.close(); } catch { /* already closed */ }
  }
}

export function setOpenCodeEventFetchForTests(value: FetchLike | null): void {
  eventFetch = value ?? fetch;
}
