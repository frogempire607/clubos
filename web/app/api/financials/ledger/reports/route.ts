import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { parseBasis } from "@/lib/glReports";
import {
  balanceSheetReport,
  cashFlowReport,
  drilldownReport,
  generalLedgerReport,
  profitAndLossReport,
  reportFilterOptions,
  trialBalanceReport,
} from "@/lib/glReportsServer";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/reports?statement=… — the ledger's financial
// statements. finances:view, Pro+.
//
// ONE route rather than one per statement, deliberately: the permission check
// and the tier gate are the parts that must never be missing, and there is one
// of each here instead of six places to forget them.
//
// Filters, shared by every statement: ?from= &to= &entity= &program= &basis=
//   statement=trial-balance  · the CPA's first check
//   statement=general-ledger · per-account detail with running balances
//   statement=balance-sheet  · cumulative through ?to=
//   statement=pnl            · add &byMonth=1 for a column per month
//   statement=cash-flow      · indirect method
//   statement=drilldown      · the journal lines behind one &account=
//   statement=options        · the entities and programs the filters can offer
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  // Explicit, before the guard: requirePermissionLive loses TypeScript's
  // null-narrowing on `session`, and without this the build fails with
  // "'session' is possibly null" (CLAUDE.md gotcha #1).
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  // Tier gate last, so a staffer without finance permission hears that rather
  // than "upgrade your plan".
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const entity = p.get("entity");
  const program = p.get("program");
  const q = {
    from: p.get("from"),
    to: p.get("to"),
    legalEntityId: entity && entity !== "all" ? entity : null,
    program: program && program !== "all" ? program : null,
    basis: parseBasis(p.get("basis")),
  };

  switch (p.get("statement")) {
    case "trial-balance":
      return NextResponse.json(await trialBalanceReport(clubId, q));
    case "general-ledger":
      return NextResponse.json(
        await generalLedgerReport(clubId, { ...q, accountId: p.get("account") || null }),
      );
    case "balance-sheet":
      return NextResponse.json(await balanceSheetReport(clubId, q));
    case "pnl":
      return NextResponse.json(
        await profitAndLossReport(clubId, { ...q, byMonth: p.get("byMonth") === "1" }),
      );
    case "cash-flow":
      return NextResponse.json(await cashFlowReport(clubId, q));
    case "drilldown": {
      const accountId = p.get("account");
      if (!accountId) {
        return NextResponse.json(
          { error: "A drill-down needs an account." },
          { status: 400 },
        );
      }
      return NextResponse.json(await drilldownReport(clubId, { ...q, accountId }));
    }
    case "options":
      return NextResponse.json(await reportFilterOptions(clubId));
    default:
      return NextResponse.json(
        {
          error:
            "Unknown statement. Use trial-balance, general-ledger, balance-sheet, pnl, cash-flow, drilldown or options.",
        },
        { status: 400 },
      );
  }
}
