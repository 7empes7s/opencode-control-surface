import { useCallback, useEffect, useState } from "react";
import { authFetch } from "../lib/authFetch";

interface ApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAuthenticatedApi<T>(path: string, intervalMs = 30_000): ApiResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

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

    const timer = setInterval(refresh, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [path, intervalMs, tick, refresh]);

  return { data, loading, error, refresh };
}
