import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { computePayroll, payrollRange } from "@/lib/payrollCalc";

// GET /api/staff/payroll?from=YYYY-MM-DD&to=YYYY-MM-DD
// Payroll preview driven by the modular compensation builder. Each staff
// member's pay = their StaffCompensation plan (base + stackable bonuses, scoped
// by assignment rules) evaluated against the period's classes/attendance/
// signups/revenue. Staff with no plan show zeros. The math lives in
// lib/payrollCalc.ts, shared with the payday reminders.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const fromStr = url.searchParams.get("from");
  const toStr = url.searchParams.get("to");
  if (!fromStr || !toStr) {
    return NextResponse.json({ error: "from and to required" }, { status: 400 });
  }
  const { from, to } = payrollRange(fromStr, toStr);
  const clubId = session.user.clubId;

  const { staff, totals } = await computePayroll(clubId, from, to);

  return NextResponse.json({
    from: from.toISOString(),
    to: to.toISOString(),
    staff,
    totals,
  });
}
