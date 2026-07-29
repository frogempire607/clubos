import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { computeBankBasedTaxSummary } from "@/lib/taxSummary";

// GET /api/financials/tax-summary?entity=&from=&to=
//
// Bank-based Tax Summary — see lib/taxSummary.ts for the rules. This is the
// only supported entry point; the Financials → Tax Summary tab calls it.

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const fromParam = url.searchParams.get("from");
  const toParam = url.searchParams.get("to");

  const from = fromParam ? new Date(fromParam) : null;
  const to = toParam ? new Date(toParam) : null;

  const summary = await computeBankBasedTaxSummary(session.user.clubId, {
    entity,
    from,
    to,
  });

  return NextResponse.json(summary);
}
