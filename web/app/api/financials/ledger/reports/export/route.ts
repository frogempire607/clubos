import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { buildCsv, buildWorkbook, todayStamp, type WorkbookSheet } from "@/lib/exporters";
import { parseBasis } from "@/lib/glReports";
import {
  balanceSheetReport,
  cashFlowReport,
  generalLedgerReport,
  profitAndLossReport,
  trialBalanceReport,
} from "@/lib/glReportsServer";
import {
  STATEMENT_LABELS,
  balanceSheetTable,
  cashFlowTable,
  generalLedgerTable,
  parseStatementKey,
  pnlTable,
  tableToCsvRows,
  trialBalanceTable,
  type ExportTable,
} from "@/lib/glReportsExport";

export const dynamic = "force-dynamic";
// A year's general ledger can be tens of thousands of lines, and exceljs
// builds the workbook in memory, so this needs more than the default.
export const maxDuration = 60;

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// GET /api/financials/ledger/reports/export — the CPA's download. finances:view, Pro+.
//
//   ?statement=trial-balance|general-ledger|balance-sheet|pnl|cash-flow
//   &format=csv|xlsx              (one statement, one file)
//   ?package=cpa&year=2027        (TB + GL + BS + P&L as ONE workbook,
//                                  one sheet each — the "hand it to my CPA"
//                                  button; xlsx only, since a single CSV
//                                  cannot carry four sheets)
//
// Uses exceljs, never xlsx (SheetJS) — a written-down project decision, see
// docs/accounting/plan.md.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const entity = p.get("entity");
  const program = p.get("program");
  const base = {
    legalEntityId: entity && entity !== "all" ? entity : null,
    program: program && program !== "all" ? program : null,
    basis: parseBasis(p.get("basis")),
  };

  // ── The CPA package ───────────────────────────────────────────────────────
  if (p.get("package") === "cpa") {
    const year = Number(p.get("year"));
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return NextResponse.json(
        { error: "A CPA package needs a four-digit year." },
        { status: 400 },
      );
    }
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;
    const q = { ...base, from, to };

    const [tb, gl, bs, pnl] = await Promise.all([
      trialBalanceReport(clubId, q),
      generalLedgerReport(clubId, q),
      balanceSheetReport(clubId, q),
      profitAndLossReport(clubId, { ...q, byMonth: true }),
    ]);

    const sheets: WorkbookSheet[] = [
      toSheet(trialBalanceTable(tb, `Trial Balance ${year}`)),
      toSheet(generalLedgerTable(gl.accounts, `General Ledger ${year}`)),
      toSheet(balanceSheetTable(bs, `Balance Sheet ${year}`)),
      toSheet(pnlTable(pnl, `Profit and Loss ${year}`)),
      // A cover sheet is not decoration: whoever opens this needs to know the
      // basis, the entity, and — above all — whether the statements inside
      // actually balance, before they build a return on them.
      {
        name: "About this package",
        headers: ["Item", "Value"],
        rows: [
          ["Year", String(year)],
          ["Basis", q.basis],
          ["Basis note", tb.basisNote],
          ["Entity filter", base.legalEntityId ?? "All entities"],
          ["Program filter", base.program ?? "All programs"],
          ["Trial balance debits", tb.totalDebitCents / 100],
          ["Trial balance credits", tb.totalCreditCents / 100],
          ["Trial balance in balance", tb.balanced ? "Yes" : `NO — off by ${tb.differenceCents / 100}`],
          ["Balance sheet balances", bs.balanced ? "Yes" : `NO — off by ${bs.differenceCents / 100}`],
          ["Net income", pnl.netIncome.totalCents / 100],
          ["Generated", todayStamp()],
          [
            "Note",
            "Amounts are dollars. AthletixOS keeps the ledger in integer cents, so these figures are exact to the cent.",
          ],
        ],
      },
    ];

    const buf = await buildWorkbook(sheets);
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="cpa-package-${year}-${todayStamp()}.xlsx"`,
      },
    });
  }

  // ── One statement ─────────────────────────────────────────────────────────
  const key = parseStatementKey(p.get("statement"));
  if (!key) {
    return NextResponse.json(
      {
        error:
          "Unknown statement. Use trial-balance, general-ledger, balance-sheet, pnl or cash-flow — or package=cpa&year=YYYY.",
      },
      { status: 400 },
    );
  }
  const q = { ...base, from: p.get("from"), to: p.get("to") };

  let table: ExportTable;
  switch (key) {
    case "trial-balance":
      table = trialBalanceTable(await trialBalanceReport(clubId, q));
      break;
    case "general-ledger":
      table = generalLedgerTable((await generalLedgerReport(clubId, q)).accounts);
      break;
    case "balance-sheet":
      table = balanceSheetTable(await balanceSheetReport(clubId, q));
      break;
    case "pnl":
      table = pnlTable(await profitAndLossReport(clubId, { ...q, byMonth: p.get("byMonth") === "1" }));
      break;
    case "cash-flow":
      table = cashFlowTable(await cashFlowReport(clubId, q));
      break;
  }

  const stamp = todayStamp();
  const stem = `${key}-${stamp}`;

  if ((p.get("format") || "csv").toLowerCase() === "xlsx") {
    const buf = await buildWorkbook([toSheet(table)]);
    return new Response(buf as unknown as BodyInit, {
      headers: {
        "Content-Type": XLSX_TYPE,
        "Content-Disposition": `attachment; filename="${stem}.xlsx"`,
      },
    });
  }

  const rows = tableToCsvRows(table);
  const csv = buildCsv(rows[0].map(String), rows.slice(1));
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${stem}.csv"`,
    },
  });
}

function toSheet(t: ExportTable): WorkbookSheet {
  return { name: t.title, headers: t.headers, rows: t.rows };
}

void STATEMENT_LABELS;
