import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { requireTierFeature } from "@/lib/tierGuard";
import { buildCsv, todayStamp } from "@/lib/exporters";
import { FORM_1099_CSV_HEADERS, form1099CsvRows } from "@/lib/form1099";
import { form1099Report, form1099Years, setThreshold } from "@/lib/form1099Server";

export const dynamic = "force-dynamic";

// GET /api/financials/ledger/form1099?year=2026[&format=csv] — who needs a
// 1099 and for how much. finances:view, Pro+.
//
// ⚠️  NO TAX IDENTIFICATION NUMBER is read, returned or logged by this route,
// because none is stored anywhere in AthletixOS. The brief asked for an
// encrypted, masked, owner-only TIN and said to stop and propose a design if
// no field-level encryption existed — it doesn't. The design is in
// docs/accounting/plan.md under "1099 — the TIN question".
//
// This route FILES NOTHING. It is a report and a CSV.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;
  const clubId = session.user.clubId;

  const p = new URL(req.url).searchParams;
  const years = await form1099Years(clubId);
  const yearParam = Number(p.get("year"));
  const year = Number.isInteger(yearParam) && yearParam >= 2000 && yearParam <= 2100
    ? yearParam
    : (years[0] ?? new Date().getUTCFullYear() - 1);

  const report = await form1099Report(clubId, year);

  if ((p.get("format") || "").toLowerCase() === "csv") {
    const rows = form1099CsvRows(report, { includeBelow: p.get("includeBelow") === "1" });
    const csv = buildCsv(FORM_1099_CSV_HEADERS, rows);
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="1099-${year}-${todayStamp()}.csv"`,
      },
    });
  }

  return NextResponse.json({ report, years });
}

const thresholdSchema = z
  .object({
    year: z.number().int().min(2000).max(2100),
    /// Integer cents, or null to go back to the statutory default.
    thresholdCents: z.number().int().min(0).max(100_000_000).nullable(),
  })
  .strict();

// PATCH /api/financials/ledger/form1099 — set one year's threshold.
// finances:full, Pro+.
//
// Per-year and club-settable because the figure moves: $600 before 2026,
// $2,000 for 2026 under OBBBA, and inflation-indexed from 2027 — a number
// hardcoded in this repo would go stale and nobody would notice until the
// forms were wrong.
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const tierGate = await requireTierFeature(session.user.clubId, "fullFinancials");
  if (tierGate) return tierGate;

  const parsed = thresholdSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });

  const thresholds = await setThreshold(
    session.user.clubId,
    parsed.data.year,
    parsed.data.thresholdCents,
  );
  const report = await form1099Report(session.user.clubId, parsed.data.year);
  return NextResponse.json({ thresholds, report });
}
