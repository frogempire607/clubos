import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { isYmd, ledgerCsv } from "@/lib/payLedger";
import { getLedgerStart, loadLedgerExport, syncPayLines } from "@/lib/payLedgerServer";

export const dynamic = "force-dynamic";

// GET /api/payroll/ledger/export?from=YYYY-MM-DD&to=YYYY-MM-DD[&userId=]
// The pay lines in a date range as a CSV for accounting / reconciliation:
// coach, date, class / event / private, role, the plan and rate used, the
// calculated amount, any override or adjustment with its reason, the final
// amount, and the payout it was paid on. finances:view (live). Never returns
// anything dated before the club's ledger start date.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  if (!isYmd(from) || !isYmd(to) || to < from) {
    return NextResponse.json({ error: "from and to must be dates like 2026-10-13, in order.", code: "BAD_INPUT" }, { status: 400 });
  }
  const start = await getLedgerStart(clubId);
  if (!start) return NextResponse.json({ error: "The pay ledger has not been started for this club.", code: "NO_LEDGER" }, { status: 409 });
  const fromYmd = from > start ? from : start;
  await syncPayLines(clubId);
  const rows = to < fromYmd ? [] : await loadLedgerExport(clubId, { fromYmd, toYmd: to, userId: url.searchParams.get("userId") });
  return new NextResponse(ledgerCsv(rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="pay-lines-${fromYmd}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
