import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DPA_TEMPLATE = join(__dirname, "./documents/dpa-template.md");
const SUBPROCESSORS = join(__dirname, "./documents/subprocessors.md");
const SOC2_MAPPING = join(__dirname, "./documents/soc2-control-mapping.md");

export function generateDpa(
  tenantId: string,
  customerName: string,
  effectiveDate: string,
): string {
  const tpl = readFileSync(DPA_TEMPLATE, "utf8");
  const retentionDays = process.env.AUDIT_RETENTION_DAYS || "90";
  const generatedDate = new Date().toISOString().split("T")[0];
  return tpl
    .replace(/\{\{CUSTOMER_NAME\}\}/g, customerName)
    .replace(/\{\{EFFECTIVE_DATE\}\}/g, effectiveDate)
    .replace(/\{\{TENANT_ID\}\}/g, tenantId)
    .replace(/\{\{RETENTION_DAYS\}\}/g, retentionDays)
    .replace(/\{\{GENERATED_DATE\}\}/g, generatedDate);
}

export function listSubprocessors(): string[] {
  const md = readFileSync(SUBPROCESSORS, "utf8");
  return md
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2).trim());
}

export function getSoc2Mapping(): Array<{ criteria: string; feature: string; notes: string }> {
  const md = readFileSync(SOC2_MAPPING, "utf8");
  const rows: Array<{ criteria: string; feature: string; notes: string }> = [];
  for (const line of md.split("\n")) {
    if (line.startsWith("| CC")) {
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 3) {
        rows.push({ criteria: parts[0], feature: parts[1], notes: parts[2] });
      }
    }
  }
  return rows;
}