import { describe, it, expect } from "bun:test";
import { executeActionHandler } from "./execute.ts";

describe("executeActionHandler", () => {
  async function makeRequest(body: unknown) {
    const res = await executeActionHandler(
      new Request("http://x/api/actions/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    const result = await res.json();
    return { status: res.status, result };
  }

  it("1. missing actionId returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({});
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("2. empty actionId returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({ actionId: "" });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("3. actionId with only one segment returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({ actionId: "navigate" });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("4. confirmation gate - start-job:service without confirmed returns 400 CONFIRM_REQUIRED", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:newsbites:restart",
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("CONFIRM_REQUIRED");
  });

  it("5. reason gate - start-job:service without reason returns 400 REASON_REQUIRED", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:newsbites:restart",
      confirmed: true,
    });
    expect(status).toBe(400);
    expect(result.code).toBe("REASON_REQUIRED");
  });

  it("6. allowlist gate - start-job:service with non-allowlisted service returns 400 ALLOWLIST", async () => {
    const { status, result } = await makeRequest({
      actionId: "start-job:service:random-svc:restart",
      confirmed: true,
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("ALLOWLIST");
  });

  it("7. navigate - low-risk, no gate returns 200 with action navigate", async () => {
    const { status, result } = await makeRequest({
      actionId: "navigate:service:newsbites",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("navigate");
  });

  it("8. copy-command for systemd service returns systemctl command", async () => {
    const { status, result } = await makeRequest({
      actionId: "copy-command:service:newsbites",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("copy-command");
    expect(result.text).toContain("systemctl is-active newsbites");
  });

  it("9. copy-command for Docker container returns docker inspect command", async () => {
    const { status, result } = await makeRequest({
      actionId: "copy-command:service:openclaw_gateway",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("copy-command");
    expect(result.text).toContain("docker inspect");
  });

  it("10. external-link for article returns article URL", async () => {
    const { status, result } = await makeRequest({
      actionId: "external-link:article:some-slug",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(true);
    expect(result.action).toBe("external-link");
    expect(result.url).toContain("some-slug");
  });

  it("11. incident acknowledge returns NOT_IMPLEMENTED", async () => {
    const { status, result } = await makeRequest({
      actionId: "acknowledge:incident:pipeline-failed:story-a:write:timeout",
    });
    expect(status).toBe(200);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_IMPLEMENTED");
  });

  it("12. mutate-policy with invalid suffix returns 400 BAD_REQUEST", async () => {
    const { status, result } = await makeRequest({
      actionId: "mutate-policy:model:editorial-heavy:delete",
      confirmed: true,
      reason: "test",
    });
    expect(status).toBe(400);
    expect(result.code).toBe("BAD_REQUEST");
  });

  it("13. unsupported kind returns 404 NOT_FOUND", async () => {
    const { status, result } = await makeRequest({
      actionId: "teleport:unknown:somewhere",
    });
    expect(status).toBe(404);
    expect(result.ok).toBe(false);
    expect(result.code).toBe("NOT_FOUND");
  });
});