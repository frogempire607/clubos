import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { buildReport, reportToCsv, REPORT_TYPES, type ReportType } from "@/lib/financialReports";

// GET /api/financials/export?type=&entity=&from=&to=
// CSV download of any tax-ready report (or type=year_end for the full package).
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const typeParam = url.searchParams.get("type") || "pnl";
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  const range = {
    entity: url.searchParams.get("entity"),
    from: fromStr ? new Date(fromStr) : null,
    to: toStr ? new Date(toStr) : null,
  };
  const clubId = session.user.clubId;
  const stamp = new Date().toISOString().slice(0, 10);

  // Year-end package: every report concatenated into one CSV with section
  // headers — a single file the owner can hand to their accountant.
  if (typeParam === "year_end") {
    const sections: string[] = [
      "AthletixOS year-end financial package",
      "Tax-ready summaries to share with your accountant or use while filing. This does not file taxes.",
      "",
    ];
    for (const t of REPORT_TYPES) {
      const res = await buildReport(clubId, t, range);
      sections.push(`## ${res.title}`);
      sections.push(reportToCsv(res));
      sections.push("");
    }
    return new NextResponse(sections.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="year-end-package-${stamp}.csv"`,
      },
    });
  }

  if (!REPORT_TYPES.includes(typeParam as ReportType)) {
    return NextResponse.json({ error: "Unknown report type" }, { status: 400 });
  }
  const res = await buildReport(clubId, typeParam as ReportType, range);
  return new NextResponse(reportToCsv(res), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${typeParam}-${stamp}.csv"`,
    },
  });
}
