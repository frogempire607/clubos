import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { buildReport, REPORT_TYPES, type ReportType } from "@/lib/financialReports";

// GET /api/financials/report?type=&entity=&from=&to=
// Tax-ready summary as JSON. Share with an accountant — does not file taxes.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const type = url.searchParams.get("type") as ReportType | null;
  if (!type || !REPORT_TYPES.includes(type)) {
    return NextResponse.json({ error: "Unknown report type" }, { status: 400 });
  }
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");

  const result = await buildReport(session.user.clubId, type, {
    entity: url.searchParams.get("entity"),
    from: fromStr ? new Date(fromStr) : null,
    to: toStr ? new Date(toStr) : null,
  });

  return NextResponse.json(result);
}
