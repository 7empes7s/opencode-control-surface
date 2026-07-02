import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";

export interface AtomicJsonReadOptions<T> {
  attempts?: number;
  retryDelayMs?: number;
  fallback?: T;
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function shouldRetry(attempt: number, attempts: number, retryDelayMs: number): boolean {
  if (attempt >= attempts) return false;
  sleepSync(retryDelayMs);
  return true;
}

export function readJsonFileAtomic<T>(path: string, options: AtomicJsonReadOptions<T> = {}): T {
  const attempts = Math.max(1, options.attempts ?? 3);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 20);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const before = fstatSync(fd);
      const raw = readFileSync(fd, "utf8");
      const after = fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        lastError = new Error(`atomic JSON read saw a concurrent write to ${path}`);
        if (shouldRetry(attempt, attempts, retryDelayMs)) continue;
      }
      return JSON.parse(raw) as T;
    } catch (error) {
      lastError = error;
      if (shouldRetry(attempt, attempts, retryDelayMs)) continue;
    } finally {
      if (fd !== null) {
        try { closeSync(fd); } catch {}
      }
    }
  }

  if ("fallback" in options) return options.fallback as T;
  throw lastError instanceof Error ? lastError : new Error(`failed to read JSON file ${path}`);
}
