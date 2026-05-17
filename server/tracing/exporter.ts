import { mkdirSync, appendFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import type { Span } from "./tracer.ts";

const TRACE_DIR = "/var/lib/control-surface/traces";

function traceFilePath(date: string): string {
  return `${TRACE_DIR}/${date}/traces.jsonl`;
}

function ensureTraceDir(date: string): void {
  mkdirSync(`${TRACE_DIR}/${date}`, { recursive: true });
}

export function exportSpan(span: Span): void {
  const date = new Date(span.startMs).toISOString().slice(0, 10);
  ensureTraceDir(date);
  appendFileSync(traceFilePath(date), JSON.stringify(span) + "\n", { encoding: "utf8" });
}

export function readTraces(date: string): Span[] {
  const path = traceFilePath(date);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Span);
  } catch {
    return [];
  }
}

export function listTraceDates(): string[] {
  if (!existsSync(TRACE_DIR)) return [];
  try {
    return readdirSync(TRACE_DIR)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}
