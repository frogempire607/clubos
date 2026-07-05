import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";

export type ExportFormat = "csv" | "xlsx" | "pdf";

export function todayStamp(): string {
  return new Date().toISOString().split("T")[0];
}

function csvEscape(val: unknown): string {
  if (val === null || val === undefined) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  return [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\r\n");
}

export async function buildXlsx(
  headers: string[],
  rows: (string | number | null | undefined)[][],
  sheetName: string
): Promise<Buffer> {
  // Excel sheet names: max 31 chars and cannot contain : \ / ? * [ ]
  const safeName = sheetName.replace(/[:\\/?*\[\]]/g, "").slice(0, 31) || "Sheet1";

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeName);

  ws.addRow(headers);
  for (const r of rows) {
    ws.addRow(r.map((c) => (c === null || c === undefined ? "" : c)));
  }

  // Auto-fit-ish column widths (same heuristic as the previous `wch` sizing)
  headers.forEach((h, i) => {
    let max = String(h).length;
    for (const row of rows) {
      const cell = row[i];
      const len = cell === null || cell === undefined ? 0 : String(cell).length;
      if (len > max) max = len;
    }
    ws.getColumn(i + 1).width = Math.min(max + 2, 60);
  });

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

export function buildPdf(opts: {
  title: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}): Buffer {
  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  const generated = new Date().toLocaleString();

  doc.setFontSize(16);
  doc.text(opts.title, 40, 40);

  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(`Generated ${generated}`, 40, 58);
  doc.setTextColor(0);

  autoTable(doc, {
    head: [opts.headers],
    body: opts.rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c)))),
    startY: 76,
    styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [83, 74, 183], textColor: 255, fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 243, 238] },
    margin: { left: 40, right: 40 },
  });

  const out = doc.output("arraybuffer");
  return Buffer.from(out);
}

export async function exportResponse(
  format: ExportFormat,
  baseName: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  pdfTitle: string,
  sheetName: string
): Promise<Response> {
  const date = todayStamp();
  const filename = `${baseName}-${date}.${format}`;

  if (format === "xlsx") {
    const buf = await buildXlsx(headers, rows, sheetName);
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  if (format === "pdf") {
    const buf = buildPdf({ title: pdfTitle, headers, rows });
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  }

  // CSV (default)
  const csv = buildCsv(headers, rows);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

export function parseExportFormat(url: URL): ExportFormat {
  const f = (url.searchParams.get("format") || "csv").toLowerCase();
  if (f === "xlsx" || f === "pdf") return f;
  return "csv";
}

/**
 * XLSX and PDF exports are considered advanced reporting features and require
 * `reports` to be enabled on the club's tier. CSV remains free on all tiers.
 */
export function isAdvancedExport(format: ExportFormat): boolean {
  return format === "xlsx" || format === "pdf";
}
