import { useEffect, useState } from "react";

export function useStream<T>(path: string): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const es = new EventSource(path);

    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      try {
        const json = JSON.parse(e.data as string) as { data: T };
        if (json.data !== undefined) setData(json.data);
      } catch {}
    };
    es.onerror = () => setConnected(false);

    return () => es.close();
  }, [path]);

  return { data, connected };
}
