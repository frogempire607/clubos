import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { loadEventAttendees } from "@/lib/eventAttendeesServer";
import { attendeeExportTable, parseExportFilter, tableToCsv } from "@/lib/eventAttendeeExtras";
import { buildPdf, todayStamp } from "@/lib/exporters";

// GET /api/events/[id]/attendees/export?format=csv|pdf&filter=all|owes|waiting|scheduled|settled&removed=1
//
// READ-ONLY (events:view, the same gate as the list it exports). The rows
// come from loadEventAttendees — the ONE loader the Attendees screen reads —
// through the screen's own filter (visibleRows), so the file is the list as
// shown, never a second computation of who owes what.
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;

  const payload = await loadEventAttendees(session.user.clubId, id);
  if (!payload) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const sp = new URL(req.url).searchParams;
  const filter = parseExportFilter(sp.get("filter"));
  const showRemoved = sp.get("removed") === "1" && filter === "all";
  const table = attendeeExportTable(payload.ledger, {
    filter,
    showRemoved,
    categoryLabel: payload.event.categoryLabel,
    extras: payload.extras,
  });

  const slug = payload.event.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "event";
  const filename = `${slug}-attendees${filter === "all" ? "" : `-${filter}`}-${todayStamp()}`;

  if (sp.get("format") === "pdf") {
    const pdf = buildPdf({
      title: `${payload.event.name} — attendees${filter === "all" ? "" : ` (${filter})`} · ${table.rows.length}`,
      headers: table.headers,
      rows: table.rows,
    });
    return new Response(pdf as unknown as BodyInit, {
      headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}.pdf"` },
    });
  }
  return new Response(tableToCsv(table), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}.csv"` },
  });
}
