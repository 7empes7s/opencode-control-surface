import { getActiveTenantId, getActiveProjectId } from "../hooks/useTenantContext";

let loginInFlight: Promise<boolean> | null = null;

/** Dispatch a custom event so UI can show an inline auth prompt instead of window.prompt */
function requestAuthViaEvent(): Promise<boolean> {
  if (loginInFlight) return loginInFlight;

  loginInFlight = new Promise((resolve) => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      window.removeEventListener("auth-response", handler);
      resolve(detail?.success ?? false);
      loginInFlight = null;
    };
    window.addEventListener("auth-response", handler, { once: true });
    window.dispatchEvent(new CustomEvent("auth-required", { detail: { reason: "Operator token required" } }));
  });

  return loginInFlight;
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const tenantHeaders: Record<string, string> = {
    "x-tenant-id": getActiveTenantId(),
    "x-project-id": getActiveProjectId(),
  };
  const request = {
    ...init,
    credentials: "same-origin" as RequestCredentials,
    headers: { ...tenantHeaders, ...(init.headers as Record<string, string> | undefined ?? {}) },
  };

  const first = await fetch(input, request);
  if (first.status !== 401 || typeof window === "undefined") return first;

  const authenticated = await requestAuthViaEvent();
  if (!authenticated) return first;

  return fetch(input, request);
}
