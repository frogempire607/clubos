import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/contractors/export — full contractor payment history as CSV,
// ready for accounting / payroll import.
export async function GET() {
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const payments = await prisma.contractorPayment.findMany({
    where: { clubId: session!.user.clubId },
    orderBy: { date: "desc" },
    include: { contractor: { select: { name: true, email: true, role: true } } },
  });

  const header = ["Date", "Contractor", "Role", "Email", "Amount", "Service", "Notes"];
  const rows = payments.map((p) => [
    p.date.toISOString().slice(0, 10),
    p.contractor.name,
    p.contractor.role ?? "",
    p.contractor.email ?? "",
    Number(p.amount).toFixed(2),
    p.service ?? "",
    p.notes ?? "",
  ]);

  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="contractor-payments-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
