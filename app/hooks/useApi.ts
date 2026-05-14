import { useState, useEffect, useCallback } from "react";

interface ApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useApi<T>(path: string, intervalMs = 30_000): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    let cancelled = false;
    let currentData: T | null = null;

    function setDataIfChanged(newData: T) {
      const isSame = currentData !== null &&
        JSON.stringify(currentData) === JSON.stringify(newData);
      if (!isSame) {
        currentData = newData;
        setData(newData);
      }
      setError(null);
      setLoading(false);
    }

    async function fetchData() {
      try {
        const r = await fetch(path);
        const json = await r.json() as { data: T };
        if (!cancelled) setDataIfChanged(json.data);
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      }
    }

    setLoading(true);
    fetchData();

    const timer = setInterval(fetchData, intervalMs);
    return () => { cancelled = true; clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, intervalMs, tick]);

  return { data, loading, error, refresh };
}

export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
