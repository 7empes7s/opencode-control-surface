import { REPORT_TEMPLATES } from "../reporting/index.ts";
import { getTenantContext } from "../tenancy/context.ts";
import {
  errorResponse,
  formatDate,
  requireReportsDb,
  rowsFromOutput,
  type ReportRunRow,
} from "./reports.ts";

export type ReportExportFormat = "pdf" | "pptx" | "docx";

type ChartPoint = { label: string; value: number };

type ReportExportModel = {
  runId: string;
  templateId: string;
  templateName: string;
  description: string;
  status: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  fromTs: number | null;
  toTs: number | null;
  rowCount: number;
  headers: string[];
  rows: Record<string, unknown>[];
  chart: { labelKey: string; valueKey: string; points: ChartPoint[] } | null;
  execSummary: string;
};

const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 8;

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

const IDENTIFIER_KEY_PATTERN = /(^id$|_id$|^ts$|_ts$|hash)/i;

function findFirstNumericKey(rows: Record<string, unknown>[]): string | null {
  if (!rows.length) return null;
  const headers = Object.keys(rows[0]);
  return headers.find((key) => typeof rows[0][key] === "number" && !IDENTIFIER_KEY_PATTERN.test(key)) ?? null;
}

function findLabelKey(rows: Record<string, unknown>[], excludeKey: string | null): string {
  const headers = Object.keys(rows[0] ?? {});
  const stringKey = headers.find((key) => key !== excludeKey && typeof rows[0][key] === "string");
  return stringKey ?? headers[0] ?? "row";
}

function deriveChart(rows: Record<string, unknown>[]): ReportExportModel["chart"] {
  if (!rows.length) return null;
  const valueKey = findFirstNumericKey(rows);
  if (!valueKey) return null;
  const labelKey = findLabelKey(rows, valueKey);

  const points = [...rows]
    .map((row) => ({ label: cellText(row[labelKey]) || "(unlabeled)", value: Number(row[valueKey]) || 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  if (!points.some((point) => point.value > 0)) return null;
  return { labelKey, valueKey, points };
}

function formatPeriod(fromTs: number | null, toTs: number | null): string {
  if (fromTs === null || toTs === null) return "an unspecified period";
  return `${new Date(fromTs).toLocaleDateString()} to ${new Date(toTs).toLocaleDateString()}`;
}

function buildExecSummary(input: {
  templateName: string;
  status: string;
  error: string | null;
  rows: Record<string, unknown>[];
  fromTs: number | null;
  toTs: number | null;
}): string {
  const period = formatPeriod(input.fromTs, input.toTs);

  if (input.status === "failed") {
    return `This ${input.templateName} report did not complete successfully for ${period}. Error: ${input.error ?? "unknown error"}.`;
  }

  if (!input.rows.length) {
    return `This ${input.templateName} report covers ${period} and found no matching data in that window. There are no findings to report.`;
  }

  const numericKey = findFirstNumericKey(input.rows);
  let extra = "";
  if (numericKey) {
    const labelKey = findLabelKey(input.rows, numericKey);
    const total = input.rows.reduce((sum, row) => sum + (Number(row[numericKey]) || 0), 0);
    const top = [...input.rows].sort((a, b) => (Number(b[numericKey]) || 0) - (Number(a[numericKey]) || 0))[0];
    const readableKey = numericKey.replace(/_/g, " ");
    const topLabel = top ? cellText(top[labelKey]) : "";
    extra = topLabel
      ? ` The total ${readableKey} across all rows is ${total}, with the largest contributor being "${topLabel}" at ${cellText(top[numericKey])}.`
      : ` The total ${readableKey} across all rows is ${total}.`;
  }

  return `This ${input.templateName} report covers ${period} and captured ${input.rows.length} row(s) of data.${extra}`;
}

function buildReportModel(run: ReportRunRow): ReportExportModel {
  const template = REPORT_TEMPLATES.find((candidate) => candidate.id === run.template_id);
  const templateName = template?.name ?? run.template_id;
  const params = run.params_json ? JSON.parse(run.params_json) as { fromTs?: number; toTs?: number } : {};
  const fromTs = typeof params.fromTs === "number" ? params.fromTs : null;
  const toTs = typeof params.toTs === "number" ? params.toTs : null;
  const rows = rowsFromOutput(run.output_json);
  const headers = rows.length ? Object.keys(rows[0]).slice(0, MAX_TABLE_COLUMNS) : [];

  return {
    runId: run.id,
    templateId: run.template_id,
    templateName,
    description: template?.description ?? "",
    status: run.status,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    error: run.error,
    fromTs,
    toTs,
    rowCount: run.row_count,
    headers,
    rows: rows.slice(0, MAX_TABLE_ROWS),
    chart: deriveChart(rows),
    execSummary: buildExecSummary({ templateName, status: run.status, error: run.error, rows, fromTs, toTs }),
  };
}

async function renderPdf(model: ReportExportModel): Promise<Buffer> {
  const PDFDocument = (await import("pdfkit")).default;
  const doc = new PDFDocument({ margin: 50, size: "A4" });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  doc.fontSize(20).fillColor("#111111").text(`${model.templateName} Report`, { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor("#555555").text(`Period: ${formatPeriod(model.fromTs, model.toTs)}`);
  doc.text(`Run: ${model.runId} · Status: ${model.status} · Generated: ${formatDate(model.finishedAt ?? model.startedAt)}`);
  doc.moveDown(0.8);

  doc.fontSize(12).fillColor("#000000").text(model.execSummary, { align: "left" });
  doc.moveDown(1);

  doc.fontSize(14).fillColor("#111111").text("Findings");
  doc.moveDown(0.3);

  if (!model.rows.length) {
    doc.fontSize(11).fillColor("#555555").text("No data available for this report.");
  } else {
    const colWidth = (doc.page.width - 100) / model.headers.length;
    const startX = 50;
    let y = doc.y;
    doc.fontSize(9).fillColor("#ffffff");
    doc.rect(startX, y, colWidth * model.headers.length, 18).fill("#333333");
    doc.fillColor("#ffffff");
    model.headers.forEach((header, i) => {
      doc.text(header.slice(0, 18), startX + i * colWidth + 4, y + 5, { width: colWidth - 8, ellipsis: true });
    });
    y += 18;

    doc.fontSize(9);
    for (const row of model.rows) {
      if (y > doc.page.height - 80) {
        doc.addPage();
        y = 50;
      }
      doc.fillColor("#000000");
      model.headers.forEach((header, i) => {
        doc.text(cellText(row[header]).slice(0, 40), startX + i * colWidth + 4, y + 4, { width: colWidth - 8, ellipsis: true });
      });
      doc.moveTo(startX, y + 18).lineTo(startX + colWidth * model.headers.length, y + 18).strokeColor("#dddddd").stroke();
      y += 18;
    }
    doc.y = y + 10;
  }

  if (model.chart) {
    doc.moveDown(1);
    if (doc.y > doc.page.height - 200) doc.addPage();
    doc.fontSize(14).fillColor("#111111").text(`Chart — ${model.chart.valueKey.replace(/_/g, " ")}`);
    doc.moveDown(0.5);

    const chartX = 50;
    let chartY = doc.y;
    const maxValue = Math.max(...model.chart.points.map((p) => p.value), 1);
    const barMaxWidth = 350;

    for (const point of model.chart.points) {
      const barWidth = Math.max(2, (point.value / maxValue) * barMaxWidth);
      doc.fontSize(9).fillColor("#000000").text(point.label.slice(0, 24), chartX, chartY + 3, { width: 130, ellipsis: true });
      doc.rect(chartX + 135, chartY, barWidth, 14).fill("#4477cc");
      doc.fillColor("#000000").text(String(point.value), chartX + 135 + barWidth + 6, chartY + 3);
      chartY += 20;
    }
    doc.y = chartY;
  }

  doc.end();
  return done;
}

async function renderPptx(model: ReportExportModel): Promise<Buffer> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  const summarySlide = pptx.addSlide();
  summarySlide.addText(`${model.templateName} Report`, { x: 0.4, y: 0.3, fontSize: 26, bold: true, color: "1F2937" });
  summarySlide.addText(
    `Period: ${formatPeriod(model.fromTs, model.toTs)}  ·  Status: ${model.status}  ·  Run ${model.runId}`,
    { x: 0.4, y: 0.95, fontSize: 11, color: "6B7280" },
  );
  summarySlide.addText(model.execSummary, { x: 0.4, y: 1.5, w: 9.2, h: 1.6, fontSize: 13, color: "111827", valign: "top" });

  const tableSlide = pptx.addSlide();
  tableSlide.addText("Findings", { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: "1F2937" });
  if (!model.rows.length) {
    tableSlide.addText("No data available for this report.", { x: 0.4, y: 1, fontSize: 13, color: "6B7280" });
  } else {
    const headerRow = model.headers.map((header) => ({
      text: header,
      options: { bold: true, fill: { color: "334155" }, color: "FFFFFF", fontSize: 9 },
    }));
    const bodyRows = model.rows.slice(0, 15).map((row) =>
      model.headers.map((header) => ({ text: cellText(row[header]).slice(0, 40), options: { fontSize: 8, color: "111827" } }))
    );
    tableSlide.addTable([headerRow, ...bodyRows], {
      x: 0.4,
      y: 0.9,
      w: 9.2,
      border: { type: "solid", color: "CBD5E1", pt: 0.5 },
      autoPage: false,
    });
    if (model.rows.length > 15) {
      tableSlide.addText(`Showing 15 of ${model.rows.length} rows.`, { x: 0.4, y: 6.9, fontSize: 9, color: "6B7280" });
    }
  }

  if (model.chart) {
    const chartSlide = pptx.addSlide();
    chartSlide.addText(`Chart — ${model.chart.valueKey.replace(/_/g, " ")}`, { x: 0.4, y: 0.3, fontSize: 22, bold: true, color: "1F2937" });
    chartSlide.addChart(
      pptx.ChartType.bar,
      [{ name: model.chart.valueKey, labels: model.chart.points.map((p) => p.label), values: model.chart.points.map((p) => p.value) }],
      { x: 0.5, y: 1, w: 9, h: 4.8, showLegend: false, barDir: "bar" },
    );
  }

  const buffer = await pptx.write({ outputType: "nodebuffer" });
  return buffer as Buffer;
}

async function renderDocx(model: ReportExportModel): Promise<Buffer> {
  const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun, WidthType, ShadingType } = await import("docx");

  const children: InstanceType<typeof Paragraph>[] = [
    new Paragraph({ text: `${model.templateName} Report`, heading: HeadingLevel.TITLE }),
    new Paragraph({
      children: [new TextRun({
        text: `Period: ${formatPeriod(model.fromTs, model.toTs)} · Status: ${model.status} · Run ${model.runId}`,
        color: "6B7280",
        size: 20,
      })],
    }),
    new Paragraph({ text: "", spacing: { after: 100 } }),
    new Paragraph({ children: [new TextRun(model.execSummary)] }),
    new Paragraph({ text: "", spacing: { after: 100 } }),
    new Paragraph({ text: "Findings", heading: HeadingLevel.HEADING_1 }),
  ];

  if (!model.rows.length) {
    children.push(new Paragraph({ text: "No data available for this report." }));
  } else {
    const headerCells = model.headers.map((header) =>
      new TableCell({
        shading: { type: ShadingType.CLEAR, fill: "334155" },
        children: [new Paragraph({ children: [new TextRun({ text: header, bold: true, color: "FFFFFF" })] })],
      })
    );
    const bodyRows = model.rows.map((row) =>
      new TableRow({
        children: model.headers.map((header) =>
          new TableCell({ children: [new Paragraph(cellText(row[header]).slice(0, 60))] })
        ),
      })
    );
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [new TableRow({ children: headerCells }), ...bodyRows],
      }) as unknown as InstanceType<typeof Paragraph>,
    );
    if (model.rowCount > model.rows.length) {
      children.push(new Paragraph({ text: `Showing ${model.rows.length} of ${model.rowCount} rows.`, spacing: { before: 100 } }));
    }
  }

  if (model.chart) {
    children.push(new Paragraph({ text: "", spacing: { after: 100 } }));
    children.push(new Paragraph({ text: `Chart — ${model.chart.valueKey.replace(/_/g, " ")}`, heading: HeadingLevel.HEADING_1 }));
    const maxValue = Math.max(...model.chart.points.map((p) => p.value), 1);
    const chartRows = model.chart.points.map((point) => {
      const barLength = Math.max(1, Math.round((point.value / maxValue) * 30));
      return new TableRow({
        children: [
          new TableCell({ children: [new Paragraph(point.label)] }),
          new TableCell({ children: [new Paragraph("█".repeat(barLength))] }),
          new TableCell({ children: [new Paragraph(String(point.value))] }),
        ],
      });
    });
    children.push(
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({
            children: [
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Label", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Bar", bold: true })] })] }),
              new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: "Value", bold: true })] })] }),
            ],
          }),
          ...chartRows,
        ],
      }) as unknown as InstanceType<typeof Paragraph>,
    );
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

const CONTENT_TYPES: Record<ReportExportFormat, string> = {
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

export async function reportsExportHandler(req: Request, runId: string, formatParam: string | null): Promise<Response> {
  const format = (formatParam ?? "").toLowerCase() as ReportExportFormat;
  if (format !== "pdf" && format !== "pptx" && format !== "docx") {
    return errorResponse("format must be one of: pdf, pptx, docx", 400);
  }

  const dbOrResponse = requireReportsDb();
  if (dbOrResponse instanceof Response) return dbOrResponse;

  const ctx = getTenantContext(req);
  const run = dbOrResponse.query("SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?").get(runId, ctx.tenantId) as ReportRunRow | null;

  if (!run) return errorResponse("run not found", 404);
  if (run.status !== "success") return errorResponse("run not completed", 409);

  const model = buildReportModel(run);

  try {
    const buffer = format === "pdf" ? await renderPdf(model) : format === "pptx" ? await renderPptx(model) : await renderDocx(model);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": CONTENT_TYPES[format],
        "Content-Disposition": `attachment; filename="report-${model.templateId}-${runId}.${format}"`,
      },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return errorResponse(`export generation failed: ${errMsg}`, 500);
  }
}
