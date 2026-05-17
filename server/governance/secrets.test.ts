import { describe, it, expect, beforeAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeSecret, readSecretPlaintext, listSecrets, deleteSecret } from "./secrets.ts";

const TEST_DIR = "/tmp/control-surface-test-secrets";
const TEST_KEK_FILE = join(TEST_DIR, "test-master.key");

function setupTestKek() {
  mkdirSync(TEST_DIR, { recursive: true });
  chmodSync(TEST_DIR, 0o700);
  writeFileSync(TEST_DIR + "/master.key", randomUUID().replace(/-/g, "").slice(0, 64), { encoding: "utf8" });
  chmodSync(TEST_DIR + "/master.key", 0o600);
}

describe("secrets", () => {
  beforeAll(() => {
    // Stub KEK path for tests
    process.env.TIB_BUILDER_TEST = "1";
  });

  it("round-trip encrypt/decrypt", () => {
    const name = "test-api-key-" + randomUUID().slice(0, 8);
    const plaintext = "sk-super-secret-12345";
    const entry = writeSecret(name, plaintext, "Test API key");
    expect(entry.id).toMatch(/^sec_/);
    expect(entry.name).toBe(name);
    const retrieved = readSecretPlaintext(name);
    expect(retrieved).toBe(plaintext);
  });

  it("listSecrets hides plaintext values", () => {
    const name = "test-list-" + randomUUID().slice(0, 8);
    writeSecret(name, "super-secret-value", "A secret");
    const listed = listSecrets();
    const found = listed.find((s) => s.name === name);
    expect(found).toBeDefined();
    expect((found as { encryptedValue?: string }).encryptedValue).toBe("");
  });

  it("deleteSecret removes the secret", () => {
    const name = "test-delete-" + randomUUID().slice(0, 8);
    writeSecret(name, "deleteme");
    const deleted = deleteSecret(name);
    expect(deleted).toBe(true);
    expect(readSecretPlaintext(name)).toBeNull();
  });

  it("update replaces existing secret", () => {
    const name = "test-update-" + randomUUID().slice(0, 8);
    writeSecret(name, "original-value");
    writeSecret(name, "updated-value");
    expect(readSecretPlaintext(name)).toBe("updated-value");
  });
});