import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { gridTable } from "@/lib/eventRoster";
import { rosterGrid } from "@/lib/eventRosterServer";
import { buildCsv, todayStamp } from "@/lib/exporters";

// B16 — download the roster grid. GET ?format=csv|pdf (events:view).
// Positions down the side, one column per roster, names in the cells
// ("(pending)" = waiting on the coach). The waitlist follows the grid.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;
  const event = await prisma.event.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    include: { customEventType: { select: { defaultPolicy: true } } },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const grid = await rosterGrid(event.id, resolveEventPolicy(event).holdSpotDuringReview);
  const t = gridTable(grid);
  const slug = event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
  const filename = `${slug}-roster-${todayStamp()}`;
  const format = new URL(req.url).searchParams.get("format") === "pdf" ? "pdf" : "csv";

  if (format === "csv") {
    const rows: string[][] = t.rows.map((r) => r.map((c) => c.replace(/\n/g, "; ")));
    if (t.waitlistRows.length) rows.push([], ["Waitlist"], ["Position", "Roster", "Name"], ...t.waitlistRows);
    return new Response(buildCsv(t.headers, rows), {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.csv"` },
    });
  }

  const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });
  doc.setFontSize(16);
  doc.text(`${event.name} — roster`, 40, 40);
  doc.setFontSize(10);
  doc.setTextColor(120);
  doc.text(
    `${event.startsAt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })} · ${grid.counts.confirmed} confirmed · ${grid.counts.pending} pending · ${grid.counts.waitlist} waitlist · generated ${new Date().toLocaleDateString("en-US")}`,
    40,
    58,
  );
  doc.setTextColor(0);
  autoTable(doc, {
    head: [t.headers],
    body: t.rows,
    startY: 74,
    styles: { fontSize: 9, cellPadding: 4, overflow: "linebreak", valign: "top" },
    headStyles: { fillColor: [83, 74, 183], textColor: 255, fontStyle: "bold" },
    columnStyles: { 0: { fontStyle: "bold", cellWidth: 70 } },
    alternateRowStyles: { fillColor: [245, 243, 238] },
    margin: { left: 40, right: 40 },
  });
  if (t.waitlistRows.length) {
    const y = (doc as unknown as { lastAutoTable?: { finalY: number } }).lastAutoTable?.finalY ?? 74;
    autoTable(doc, {
      head: [["Waitlist — position", "Roster", "Name"]],
      body: t.waitlistRows,
      startY: y + 20,
      styles: { fontSize: 9, cellPadding: 4 },
      headStyles: { fillColor: [180, 83, 9], textColor: 255 },
      margin: { left: 40, right: 40 },
    });
  }
  const out = Buffer.from(doc.output("arraybuffer"));
  return new Response(out as unknown as BodyInit, {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}.pdf"` },
  });
}
