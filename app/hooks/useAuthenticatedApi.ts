import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authFetch";

interface ApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
  request: (targetPath: string, init?: RequestInit) => Promise<Response>;
}

export function useAuthenticatedApi<T>(path: string, intervalMs = 30_000): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const request = useCallback((targetPath: string, init: RequestInit = {}) => authFetch(targetPath, init), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    if (!path) {
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    authFetch(path)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        return res.json() as Promise<{ data: T }>;
      })
      .then((json) => {
        if (cancelled) return;
        setData(json.data);
        setError(null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    const timer = intervalMs > 0 ? setInterval(refresh, intervalMs) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [path, intervalMs, tick, refresh]);

  return { data, loading, error, refresh, request };
}
