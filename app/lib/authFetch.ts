let loginInFlight: Promise<boolean> | null = null;

async function promptForOperatorSession(): Promise<boolean> {
  if (loginInFlight) return loginInFlight;

  loginInFlight = (async () => {
    const token = window.prompt("Operator token required");
    if (!token) return false;

    const res = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    return res.ok;
  })();

  try {
    return await loginInFlight;
  } finally {
    loginInFlight = null;
  }
}

export async function authFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const request = {
    ...init,
    credentials: "same-origin" as RequestCredentials,
  };

  const first = await fetch(input, request);
  if (first.status !== 401 || typeof window === "undefined") return first;

  const authenticated = await promptForOperatorSession();
  if (!authenticated) return first;

  return fetch(input, request);
}
