import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { getTierFeatures, tierBlockedBody, upgradeRequired } from "@/lib/tier";
import { resolveReportsRange, type RangeKey } from "@/lib/reportsRange";
import { buildPnl, pnlToCsv, type PnlPeriod, type PnlBasis } from "@/lib/reportsPnl";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// GET /api/reports/pnl/export?format=csv|pdf&period=&basis=&range=…
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const denied = requirePermission(session, "reports", "view");
  if (denied) return denied;

  const clubId = session.user.clubId;
  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: { tier: true, timezone: true, wentLiveAt: true, createdAt: true, name: true },
  });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.reports) {
    return NextResponse.json(
      tierBlockedBody({
        message: "Reports & analytics aren't available on your current plan.",
        upgradeRequired: upgradeRequired(club?.tier ?? "growth", "reports"),
      }),
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const format = (url.searchParams.get("format") ?? "csv").toLowerCase();
  const period = (url.searchParams.get("period") ?? "monthly") as PnlPeriod;
  const basis = (url.searchParams.get("basis") ?? "cash") as PnlBasis;
  const range = resolveReportsRange({
    key: (url.searchParams.get("range") || "month") as RangeKey,
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    timezone: club?.timezone ?? null,
    wentLiveAt: club?.wentLiveAt ?? null,
    clubCreatedAt: club?.createdAt ?? new Date(),
  });

  const pnl = await buildPnl(clubId, range, period, basis);
  const stamp = new Date().toISOString().slice(0, 10);
  const baseName = `pnl-${period}-${basis}-${range.key}-${stamp}`;

  if (format === "csv") {
    const csv = pnlToCsv(pnl);
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${baseName}.csv"`,
      },
    });
  }

  if (format === "pdf") {
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
    const title = `Profit & Loss — ${club?.name ?? "Club"}`;
    const subtitle = `${period === "monthly" ? "Monthly" : "Weekly"} · ${basis === "cash" ? "Cash basis" : "Accrual basis"} · ${range.label}`;
    doc.setFontSize(16);
    doc.text(title, 40, 44);
    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(subtitle, 40, 62);

    const columns = ["Line", ...pnl.columns.map((c) => c.label + (c.isPartial ? " *" : ""))];
    const rows: string[][] = [];
    for (const section of pnl.sections) {
      rows.push([`— ${section.label} —`, ...pnl.columns.map(() => "")]);
      for (const line of section.lines) {
        rows.push([line.label, ...line.values.map(fmtMoney)]);
      }
      rows.push([section.total.label, ...section.total.values.map(fmtMoney)]);
    }
    rows.push(["Net profit", ...pnl.summary.map((s) => fmtMoney(s.netProfit))]);
    if (pnl.rollingAverage) {
      rows.push([pnl.rollingAverage.label, ...pnl.rollingAverage.values.map(fmtMoney)]);
    }
    autoTable(doc, {
      head: [columns],
      body: rows,
      startY: 78,
      styles: { fontSize: 8 },
      headStyles: { fillColor: [31, 31, 35], textColor: 255 },
      alternateRowStyles: { fillColor: [247, 247, 249] },
      columnStyles: {
        0: { fontStyle: "bold" },
      },
      didParseCell: (data) => {
        if (data.column.index > 0) data.cell.styles.halign = "right";
      },
    });
    if (pnl.warnings.length > 0) {
      const y = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 200;
      doc.setFontSize(9);
      doc.setTextColor(120);
      let cursor = y + 20;
      for (const w of pnl.warnings) {
        doc.text(`• ${w.message}`, 40, cursor);
        cursor += 12;
      }
    }

    const pdf = Buffer.from(doc.output("arraybuffer"));
    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${baseName}.pdf"`,
      },
    });
  }

  return NextResponse.json({ error: "Unknown format" }, { status: 400 });
}

function fmtMoney(n: number): string {
  const abs = Math.abs(n);
  const s = `$${abs.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return n < 0 ? `(${s})` : s;
}
