import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";

const KEK_PATH = "/etc/tib-builder/master.key";
const KEK_DIR = dirname(KEK_PATH);

let _kek: Buffer | null = null;

export type SecretEntry = {
  id: string;
  name: string;
  description: string;
  encryptedValue: string;
  keyId: string;
  createdAt: number;
  updatedAt: number;
};

function requireDb() {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("dashboard SQLite unavailable");
  return db;
}

function ensureKekDir(): void {
  if (!existsSync(KEK_DIR)) {
    mkdirSync(KEK_DIR, { recursive: true });
    chmodSync(KEK_DIR, 0o700);
  }
}

function loadOrCreateKek(): Buffer {
  if (_kek) return _kek;
  ensureKekDir();
  if (existsSync(KEK_PATH)) {
    const hex = readFileSync(KEK_PATH, "utf8").trim();
    if (hex.length !== 64) throw new Error(`/etc/tib-builder/master.key: expected 64 hex chars (32 bytes), got ${hex.length}`);
    _kek = Buffer.from(hex, "hex");
  } else {
    _kek = randomBytes(32);
    writeFileSync(KEK_PATH, _kek.toString("hex"), { encoding: "utf8" });
    chmodSync(KEK_PATH, 0o600);
    console.warn("[governance-secrets] WARNING: generated new KEK at /etc/tib-builder/master.key — BACKUP THIS FILE!");
    console.warn("[governance-secrets] WARNING: loss of this key will make all stored secrets unreadable!");
  }
  return _kek;
}

function deriveKey(kek: Buffer, keyId: string): Buffer {
  return createHash("sha256").update(kek).update(keyId).digest();
}

function encryptPlaintext(plaintext: string, kek: Buffer): { encryptedValue: string; encryptedDek: string; iv: string; keyId: string } {
  const keyId = randomUUID();
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const derived = deriveKey(kek, keyId);
  const cipher = createCipheriv("aes-256-gcm", derived, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const encryptedDek = Buffer.concat([dek, authTag]);
  return {
    encryptedValue: encrypted.toString("base64"),
    encryptedDek: encryptedDek.toString("base64"),
    iv: iv.toString("base64"),
    keyId,
  };
}

function decryptPlaintext(encryptedValue: string, encryptedDek: string, iv: string, kek: Buffer, keyId: string): string {
  const derived = deriveKey(kek, keyId);
  const encryptedDekBuf = Buffer.from(encryptedDek, "base64");
  const dek = encryptedDekBuf.subarray(0, 32);
  const authTag = encryptedDekBuf.subarray(32);
  const decipher = createDecipheriv("aes-256-gcm", derived, Buffer.from(iv, "base64"));
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64")), decipher.final()]);
  return decrypted.toString("utf8");
}

export function writeSecret(name: string, plaintext: string, description = ""): SecretEntry {
  const db = requireDb();
  const kek = loadOrCreateKek();
  const { encryptedValue, encryptedDek, iv, keyId } = encryptPlaintext(plaintext, kek);
  const now = Date.now();
  const id = `sec_${randomUUID()}`;

  db.query(`
    INSERT INTO governance_secrets (id, name, description, encrypted_value, encrypted_dek, iv, key_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      encrypted_value = excluded.encrypted_value,
      encrypted_dek = excluded.encrypted_dek,
      iv = excluded.iv,
      key_id = excluded.key_id,
      updated_at = excluded.updated_at
  `).run(id, name, description, encryptedValue, encryptedDek, iv, keyId, now, now);

  return { id, name, description, encryptedValue, keyId, createdAt: now, updatedAt: now };
}

export function readSecretPlaintext(name: string): string | null {
  const db = requireDb();
  const row = db.query("SELECT * FROM governance_secrets WHERE name = ?").get(name) as {
    encrypted_value: string;
    encrypted_dek: string;
    iv: string;
    key_id: string;
  } | null;
  if (!row) return null;
  const kek = loadOrCreateKek();
  return decryptPlaintext(row.encrypted_value, row.encrypted_dek, row.iv, kek, row.key_id);
}

export function listSecrets(): SecretEntry[] {
  const db = requireDb();
  const rows = db.query("SELECT id, name, description, created_at, updated_at FROM governance_secrets ORDER BY name").all() as {
    id: string;
    name: string;
    description: string;
    created_at: number;
    updated_at: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? "",
    encryptedValue: "",
    keyId: "",
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export function deleteSecret(name: string): boolean {
  const db = requireDb();
  const before = db.query("SELECT id FROM governance_secrets WHERE name = ?").get(name);
  if (!before) return false;
  db.query("DELETE FROM governance_secrets WHERE name = ?").run(name);
  return true;
}