import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { getDashboardDb, isDashboardDbEnabled } from "../db/dashboard.ts";
import { buildEvidencePackV2, type EvidencePackV2 } from "./evidencePack.ts";

const SIGNING_KEY_STATE = "evidence_signing_key";
const SIGNING_SCHEME = "HMAC-SHA256(manifest_without_signature) with server signing key";
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;
const ZIP_VERSION = 20;

export type EvidenceManifest = {
  generatedAt: number;
  period: { from: number; to: number };
  entries: Array<{ name: string; sha256: string; bytes: number }>;
  scheme: typeof SIGNING_SCHEME;
  signingKeySha256: string;
};

export type EvidenceZipVerification = {
  ok: boolean;
  errors: string[];
  manifest: EvidenceManifest | null;
};

type ZipEntry = { name: string; data: Buffer };

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  crcTable = table;
  return table;
}

export function crc32(input: Uint8Array | string): number {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sha256(input: Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function readStoredSigningKey(): Buffer | null {
  const db = getDashboardDb();
  if (!db) return null;
  const row = db.query(`SELECT value_json FROM operator_state WHERE key = ?`)
    .get(SIGNING_KEY_STATE) as { value_json: string } | null;
  if (!row) return null;
  let value: { keyHex?: unknown };
  try {
    value = JSON.parse(row.value_json) as { keyHex?: unknown };
  } catch {
    throw new Error("Evidence signing key state is invalid");
  }
  if (typeof value.keyHex !== "string" || !/^[a-f0-9]{64}$/i.test(value.keyHex)) {
    throw new Error("Evidence signing key state is invalid");
  }
  return Buffer.from(value.keyHex, "hex");
}

function getOrCreateSigningKey(): Buffer {
  if (!isDashboardDbEnabled()) throw new Error("DASHBOARD_DB disabled");
  const db = getDashboardDb();
  if (!db) throw new Error("Dashboard database is unavailable");

  const stored = readStoredSigningKey();
  if (stored) return stored;

  const candidate = randomBytes(32);
  db.query(`INSERT OR IGNORE INTO operator_state (key, value_json, updated_at)
    VALUES (?, ?, ?)`)
    .run(SIGNING_KEY_STATE, JSON.stringify({ keyHex: candidate.toString("hex") }), Date.now());

  const persisted = readStoredSigningKey();
  if (!persisted) throw new Error("Failed to persist evidence signing key");
  return persisted;
}

function createStoreZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(STORE_METHOD, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(STORE_METHOD, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);

    localOffset += local.length + name.length + entry.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

export function buildEvidenceZip(periodStart: number, periodEnd: number): Buffer {
  const pack: EvidencePackV2 = buildEvidencePackV2(periodStart, periodEnd);
  const packBytes = Buffer.from(`${JSON.stringify(pack, null, 2)}\n`, "utf8");
  const signingKey = getOrCreateSigningKey();
  const manifest: EvidenceManifest = {
    generatedAt: pack.generatedAt,
    period: { from: periodStart, to: periodEnd },
    entries: [{ name: "pack.json", sha256: sha256(packBytes), bytes: packBytes.length }],
    scheme: SIGNING_SCHEME,
    signingKeySha256: sha256(signingKey),
  };
  const signature = createHmac("sha256", signingKey)
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");

  return createStoreZip([
    { name: "pack.json", data: packBytes },
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8") },
    { name: "signature.txt", data: Buffer.from(`${signature}\n`, "utf8") },
  ]);
}

function findEocd(buffer: Buffer): number {
  const minimum = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function parseZip(buffer: Buffer, errors: string[]): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) {
    errors.push("ZIP end-of-central-directory record is missing");
    return entries;
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (centralOffset + 46 > buffer.length || buffer.readUInt32LE(centralOffset) !== 0x02014b50) {
      errors.push(`ZIP central-directory entry ${index} is invalid`);
      break;
    }
    const method = buffer.readUInt16LE(centralOffset + 10);
    const expectedCrc = buffer.readUInt32LE(centralOffset + 16);
    const compressedSize = buffer.readUInt32LE(centralOffset + 20);
    const uncompressedSize = buffer.readUInt32LE(centralOffset + 24);
    const nameLength = buffer.readUInt16LE(centralOffset + 28);
    const extraLength = buffer.readUInt16LE(centralOffset + 30);
    const commentLength = buffer.readUInt16LE(centralOffset + 32);
    const localOffset = buffer.readUInt32LE(centralOffset + 42);
    const nameStart = centralOffset + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > buffer.length) {
      errors.push(`ZIP central-directory entry ${index} has an invalid name`);
      break;
    }
    const name = buffer.subarray(nameStart, nameEnd).toString("utf8");
    centralOffset = nameEnd + extraLength + commentLength;

    if (entries.has(name)) {
      errors.push(`ZIP contains duplicate entry ${name}`);
      continue;
    }
    if (method !== STORE_METHOD || compressedSize !== uncompressedSize) {
      errors.push(`ZIP entry ${name} is not STORE-only`);
      continue;
    }
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      errors.push(`ZIP local header for ${name} is invalid`);
      continue;
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + uncompressedSize;
    if (dataEnd > buffer.length) {
      errors.push(`ZIP entry ${name} extends beyond the archive`);
      continue;
    }
    const data = buffer.subarray(dataStart, dataEnd);
    if (crc32(data) !== expectedCrc) errors.push(`CRC-32 mismatch for ${name}`);
    entries.set(name, data);
  }
  return entries;
}

function normalizeKey(key: Uint8Array | string): Buffer {
  if (typeof key !== "string") return Buffer.from(key);
  return /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, "hex") : Buffer.from(key, "utf8");
}

export function verifyEvidenceZip(
  input: Uint8Array,
  key: Uint8Array | string,
): EvidenceZipVerification {
  const errors: string[] = [];
  const entries = parseZip(Buffer.from(input), errors);
  for (const required of ["pack.json", "manifest.json", "signature.txt"]) {
    if (!entries.has(required)) errors.push(`ZIP entry ${required} is missing`);
  }

  let manifest: EvidenceManifest | null = null;
  const manifestBytes = entries.get("manifest.json");
  if (manifestBytes) {
    try {
      manifest = JSON.parse(manifestBytes.toString("utf8")) as EvidenceManifest;
    } catch {
      errors.push("manifest.json is not valid JSON");
    }
  }

  if (manifest) {
    if (manifest.scheme !== SIGNING_SCHEME) errors.push("Manifest signing scheme is unsupported");
    if (!Array.isArray(manifest.entries)) {
      errors.push("Manifest entries are invalid");
    } else {
      for (const item of manifest.entries) {
        const data = entries.get(item.name);
        if (!data) {
          errors.push(`Manifest entry ${item.name} is missing from ZIP`);
          continue;
        }
        if (data.length !== item.bytes) errors.push(`Byte length mismatch for ${item.name}`);
        if (sha256(data) !== item.sha256) errors.push(`SHA-256 mismatch for ${item.name}`);
      }
    }

    const normalizedKey = normalizeKey(key);
    if (sha256(normalizedKey) !== manifest.signingKeySha256) {
      errors.push("Signing key fingerprint mismatch");
    }
    const providedHex = entries.get("signature.txt")?.toString("utf8").trim() ?? "";
    const expected = createHmac("sha256", normalizedKey)
      .update(canonicalJson(manifest), "utf8")
      .digest();
    if (!/^[a-f0-9]{64}$/i.test(providedHex)) {
      errors.push("signature.txt is not a valid HMAC-SHA256 hex digest");
    } else {
      const provided = Buffer.from(providedHex, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        errors.push("HMAC signature mismatch");
      }
    }
  }

  return { ok: errors.length === 0, errors, manifest };
}
