import { describe, it, expect } from "bun:test";
import { cloudTierStatusHandler } from "./cloud-tier.ts";

describe("cloud-tier status", () => {
  it("returns correct shape", async () => {
    const res = cloudTierStatusHandler();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      supported: boolean;
      provisionedAt: string | null;
      instanceUrl: string | null;
    };
    expect(body.supported).toBe(true);
    expect(body.provisionedAt === null || typeof body.provisionedAt === "string").toBe(true);
    expect(body.instanceUrl === null || typeof body.instanceUrl === "string").toBe(true);
  });
});
