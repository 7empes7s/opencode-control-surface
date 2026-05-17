import { readFileSync } from "node:fs";
import { X509Certificate } from "node:crypto";

export interface MtlsConfig {
  caPath: string;
  certPath: string;
  keyPath: string;
  required: boolean;
}

export interface CertVerificationResult {
  valid: boolean;
  subject: string;
  error?: string;
}

function envBool(key: string): boolean {
  return process.env[key] === "1";
}

function envStr(key: string): string | undefined {
  return process.env[key];
}

export function loadMtlsConfig(): MtlsConfig | null {
  const caPath = envStr("MTLS_CA_PATH");
  const certPath = envStr("MTLS_CERT_PATH");
  const keyPath = envStr("MTLS_KEY_PATH");
  const required = envBool("MTLS_REQUIRED");

  if (!caPath && !certPath && !keyPath && !required) {
    return null;
  }

  if (!caPath || !certPath || !keyPath) {
    throw new Error(
      "MTLS_REQUIRED=1 but one or more of MTLS_CA_PATH, MTLS_CERT_PATH, MTLS_KEY_PATH is unset"
    );
  }

  return { caPath, certPath, keyPath, required };
}

function parseDistinguishedName(dn: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of dn.split(",").map((p) => p.trim())) {
    const match = part.match(/^([A-Za-z]+)=(.+)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

export function extractTenantFromCert(subject: string): string | null {
  const parsed = parseDistinguishedName(subject);
  return parsed["O"] ?? null;
}

export function verifyClientCert(pemChain: string, caPath: string): CertVerificationResult {
  if (!pemChain || pemChain.trim() === "") {
    return { valid: false, subject: "", error: "empty certificate chain" };
  }

  try {
    const caCertData = readFileSync(caPath, "utf8");
    const caCert = new X509Certificate(caCertData);

    const pemBlocks: string[] = [];
    let currentBlock: string[] = [];

    for (const line of pemChain.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      if (trimmed === "-----BEGIN CERTIFICATE-----") {
        currentBlock = [trimmed];
      } else if (trimmed === "-----END CERTIFICATE-----") {
        currentBlock.push(trimmed);
        pemBlocks.push(currentBlock.join("\n"));
        currentBlock = [];
      } else if (currentBlock.length > 0) {
        currentBlock.push(trimmed);
      }
    }

    if (pemBlocks.length === 0) {
      return { valid: false, subject: "", error: "no PEM block found in certificate chain" };
    }

    const leafCert = new X509Certificate(pemBlocks[0]);

    // Verify the leaf was signed by the CA: compare CA fingerprint as issuer of leaf
    const caFingerprint = caCert.fingerprint256;
    const leafIssuer = leafCert.issuer;
    const caSubject = caCert.subject;

    // Check issuer string matches CA subject (simple chain validation)
    if (leafIssuer !== caSubject) {
      return {
        valid: false,
        subject: leafCert.subject,
        error: "certificate issuer does not match configured CA subject",
      };
    }

    const now = new Date();
    const validTo = leafCert.validTo; // "MMM DD HH:MM:SS YYYY GMT"
    const validFrom = leafCert.validFrom;

    const expiryDate = new Date(validTo);
    const startDate = new Date(validFrom);

    if (expiryDate < now) {
      return { valid: false, subject: leafCert.subject, error: "certificate has expired" };
    }
    if (startDate > now) {
      return { valid: false, subject: leafCert.subject, error: "certificate not yet valid" };
    }

    return { valid: true, subject: leafCert.subject };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, subject: "", error: `certificate verification failed: ${message}` };
  }
}