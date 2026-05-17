export type ReportTemplate = {
  id: string;
  name: string;
  description: string;
  params: Record<string, { type: string; required?: boolean }>;
};

export type ReportRun = {
  id: string;
  tenantId: string;
  templateId: string;
  params: Record<string, unknown>;
  status: "running" | "success" | "failed";
  output: unknown;
  rowCount: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
};

export type ReportOutput = {
  templateId: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  generatedAt: number;
};