import { useState, useCallback } from "react";
import { authFetch } from "../lib/authFetch";

interface ActionState {
  loading: boolean;
  error: string | null;
  success: string | null;
}

export interface ActionHandle extends ActionState {
  run: (body?: unknown) => Promise<boolean>;
  reset: () => void;
}

export function useAction(path: string): ActionHandle {
  const [state, setState] = useState<ActionState>({
    loading: false,
    error: null,
    success: null,
  });

  const run = useCallback(
    async (body?: unknown): Promise<boolean> => {
      setState({ loading: true, error: null, success: null });
      try {
        const res = await authFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const json = await res.json() as { ok?: boolean; message?: string; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setState({ loading: false, error: null, success: json.message ?? "ok" });
        return true;
      } catch (e) {
        setState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          success: null,
        });
        return false;
      }
    },
    [path],
  );

  const reset = useCallback(
    () => setState({ loading: false, error: null, success: null }),
    [],
  );

  return { ...state, run, reset };
}
