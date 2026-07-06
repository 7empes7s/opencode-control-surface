import { useState, useCallback } from "react";
import { authFetch } from "../lib/authFetch";

interface ActionState {
  loading: boolean;
  error: string | null;
  success: string | null;
  // Durable-job-backed actions (SPEC 14 / ULTRAPLAN P3 A3a) return
  // {ok, jobId, message} instead of finishing synchronously. Optional and
  // additive — actions that don't return a jobId just leave this null.
  jobId: string | null;
}

export interface ActionHandle extends ActionState {
  run: (body?: unknown) => Promise<boolean>;
  reset: () => void;
}

const IDLE_STATE: ActionState = { loading: false, error: null, success: null, jobId: null };

export function useAction(path: string): ActionHandle {
  const [state, setState] = useState<ActionState>(IDLE_STATE);

  const run = useCallback(
    async (body?: unknown): Promise<boolean> => {
      setState({ loading: true, error: null, success: null, jobId: null });
      try {
        const res = await authFetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        const json = await res.json() as { ok?: boolean; jobId?: string; message?: string; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        setState({
          loading: false,
          error: null,
          success: json.message ?? "ok",
          jobId: typeof json.jobId === "string" ? json.jobId : null,
        });
        return true;
      } catch (e) {
        setState({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          success: null,
          jobId: null,
        });
        return false;
      }
    },
    [path],
  );

  const reset = useCallback(() => setState(IDLE_STATE), []);

  return { ...state, run, reset };
}
