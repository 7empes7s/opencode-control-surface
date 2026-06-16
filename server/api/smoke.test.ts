import { describe, expect, test, beforeEach } from "bun:test";
import { handleApi } from "./router.ts";

function request(path: string, method = "GET"): Request {
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    headers: {
      "x-operator-token": "test-token",
    },
  });
}

describe("API Smoke Tests", () => {
  beforeEach(() => {
    process.env.OPERATOR_TOKEN = "test-token";
  });

  const endpoints = [
    ["/api/gateway", "GET"],
    ["/api/governance/audit", "GET"],
    ["/api/builder/doctor/reports", "GET"],
    ["/api/cost", "GET"],
    ["/api/litellm/status", "GET"],
    ["/api/scout/runs", "GET"],
    ["/api/paperclip/agents", "GET"],
    ["/api/content-health", "GET"],
    ["/api/fs/browse", "GET"],
    ["/api/dossier/2026-05-18/test", "GET"],
    ["/api/models/routing-log", "GET"],
    ["/api/models/routing-stats", "GET"],
    ["/api/finance-intel/stats", "GET"],
    ["/api/system-config", "GET"],
  ];

  for (const [path, method] of endpoints) {
    test(`${method} ${path} should not return 404 'not found'`, async () => {
      const url = new URL(`http://127.0.0.1:3000${path}`);
      const response = await handleApi(request(path, method), url);
      
      // If the handler is called but returns 404 (e.g. dossier not found), 
      // it's different from the router's catch-all "not found".
      const body = await response.json().catch(() => ({}));
      expect(body.error).not.toBe("not found");
      // We also check if it's 404 but specifically not the router's 404.
      if (response.status === 404) {
         expect(body.error).toBeDefined();
         expect(body.error).not.toBe("not found");
      }
    });
  }
});
