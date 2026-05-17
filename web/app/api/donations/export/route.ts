import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { paymentMethodLabel } from "@/lib/financials";

function esc(v: string | number | null | undefined) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/donations/export — donor export / year-end giving summary CSV.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const donations = await prisma.donation.findMany({
    where: {
      clubId: session.user.clubId,
      ...(entity && entity !== "all" ? { legalEntityId: entity } : {}),
      ...(from || to
        ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
        : {}),
    },
    orderBy: { date: "desc" },
    include: { legalEntity: { select: { name: true } } },
  });

  const header = ["Date", "Donor", "Email", "Amount", "Fund", "Restricted", "Sponsorship", "Method", "Entity", "Receipt on file", "Notes"];
  const rows = donations.map((d) => [
    d.date.toISOString().slice(0, 10),
    d.donorName,
    d.donorEmail ?? "",
    Number(d.amount).toFixed(2),
    d.fund ?? "",
    d.restricted ? "Yes" : "No",
    d.sponsorship ? "Yes" : "No",
    paymentMethodLabel(d.paymentMethod),
    d.legalEntity?.name ?? "",
    d.receiptUrl ? "Yes" : "No",
    d.notes ?? "",
  ]);
  const csv = [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");

  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="donations-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
