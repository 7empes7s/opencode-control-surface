import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "vast-host-"));
const samplePath = join(tempDir, "vast-host.json");
process.env.VAST_HOST_SAMPLE_PATH = samplePath;

const { sampleVastHost, readVastHostSample } = await import("./vastHost.ts");

describe("vast host sampler (honest degrade)", () => {
  beforeEach(() => {
    rmSync(samplePath, { force: true });
  });

  afterAll(() => {
    rmSync(tempDir, { recursive: true, force: true });
    delete process.env.VAST_HOST_SAMPLE_PATH;
  });

  it("degrades to an explicit off state when no instance is rented — no fake metrics", async () => {
    const sample = await sampleVastHost({ known: true, instance: null });
    expect(sample.status).toBe("off");
    expect(sample.reason).toContain("off by operator");
    expect(sample.cpuPct).toBeNull();
    expect(sample.gpuUtilPct).toBeNull();

    // The state is persisted so /api/infra renders it honestly.
    expect(existsSync(samplePath)).toBe(true);
    const persisted = readVastHostSample();
    expect(persisted?.status).toBe("off");
    expect(persisted?.sampledAt).toBeGreaterThan(0);
  });

  it("degrades to off when the instance exists but is stopped", async () => {
    const sample = await sampleVastHost({
      known: true,
      instance: {
        id: "1", status: "stopped", gpu: "RTX 3090", vcpus: 8, ram: 32, disk: 100,
        gpuRam: 24, hourlyRate: 0.14, ip: "203.0.113.7", sshPort: 22, machineId: "m", uptime: 0, gpuUtil: 0,
      },
    });
    expect(sample.status).toBe("off");
    expect(sample.reason).toContain("stopped");
  });

  it("reports unknown (not off) when the vast CLI is unavailable", async () => {
    const sample = await sampleVastHost({ known: false, instance: null });
    expect(sample.status).toBe("unknown");
    expect(sample.reason).toContain("could not be read");
  });

  it("reports unreachable when a running instance has no SSH address", async () => {
    const sample = await sampleVastHost({
      known: true,
      instance: {
        id: "1", status: "running", gpu: "RTX 3090", vcpus: 8, ram: 32, disk: 100,
        gpuRam: 24, hourlyRate: 0.14, ip: "", sshPort: 0, machineId: "m", uptime: 0, gpuUtil: 0,
      },
    });
    expect(sample.status).toBe("unreachable");
    expect(sample.reason).toContain("SSH address");
  });

  it("round-trips samples through the state file", async () => {
    await sampleVastHost({ known: true, instance: null });
    const raw = JSON.parse(readFileSync(samplePath, "utf8")) as { status: string };
    expect(raw.status).toBe("off");
  });
});
