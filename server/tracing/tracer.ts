import { randomUUID } from "node:crypto";
import { exportSpan } from "./exporter.ts";

export type SpanKind = "run" | "pass" | "tool" | "gateway" | "validation";
export type SpanStatus = "ok" | "error" | "cancelled";

export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  kind: SpanKind;
  startMs: number;
  endMs: number | null;
  attrs: Record<string, string | number | boolean>;
  status: SpanStatus;
  error?: string;
};

const activeSpans = new Map<string, Span>();

export function startSpan(
  kind: SpanKind,
  attrs: Record<string, string | number | boolean> = {},
  parentSpanId?: string | null,
  traceId?: string,
): Span {
  const spanId = randomUUID();
  const resolvedTraceId = traceId ?? (parentSpanId ? (activeSpans.get(parentSpanId)?.traceId ?? randomUUID()) : randomUUID());
  const span: Span = {
    traceId: resolvedTraceId,
    spanId,
    parentSpanId: parentSpanId ?? null,
    kind,
    startMs: Date.now(),
    endMs: null,
    attrs,
    status: "ok",
  };
  activeSpans.set(spanId, span);
  return span;
}

export function endSpan(spanId: string, status: SpanStatus = "ok", error?: string): Span | null {
  const span = activeSpans.get(spanId);
  if (!span) return null;
  span.endMs = Date.now();
  span.status = status;
  if (error) span.error = error;
  activeSpans.delete(spanId);
  try {
    exportSpan(span);
  } catch {
    // export failures must never crash the caller
  }
  return span;
}

export function getActiveSpans(): Span[] {
  return Array.from(activeSpans.values());
}

export function getSpan(spanId: string): Span | null {
  return activeSpans.get(spanId) ?? null;
}
