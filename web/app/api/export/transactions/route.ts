import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { exportResponse, parseExportFormat, isAdvancedExport } from "@/lib/exporters";
import { getTierFeatures } from "@/lib/tier";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");
  const format = parseExportFormat(url);

  if (isAdvancedExport(format)) {
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { tier: true },
    });
    const features = getTierFeatures(club?.tier ?? "growth");
    if (!features.advancedAnalytics) {
      return new Response(
        "Excel and PDF exports are available on Pro and Enterprise plans. Use CSV instead, or upgrade.",
        { status: 403 },
      );
    }
  }

  const transactions = await prisma.transaction.findMany({
    where: {
      clubId: session.user.clubId,
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    include: {
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // VOID rows stay in the export (history) but must be identifiable: the
  // Verification column marks them so a spreadsheet sum can exclude them the
  // same way every in-app total does.
  const headers = [
    "Date", "Member First Name", "Member Last Name",
    "Amount ($)", "Stripe Fee ($)", "Net ($)", "Platform Fee ($)",
    "Type", "Status", "Payment Source", "Verification", "Description",
    "Stripe Payment Intent",
  ];

  const rows = transactions.map((t) => [
    t.createdAt.toISOString().split("T")[0],
    t.member?.firstName ?? "",
    t.member?.lastName ?? "",
    t.amount.toString(),
    t.stripeFeeAmount?.toString() ?? "",
    t.netAmount?.toString() ?? "",
    t.platformFee?.toString() ?? "",
    t.type,
    t.status,
    t.paymentSource ?? "",
    t.reconciliationStatus ?? "",
    t.description ?? "",
    t.stripePaymentIntentId ?? "",
  ]);

  return await exportResponse(
    format,
    "transactions-export",
    headers,
    rows,
    "Transactions Export",
    "Transactions",
  );
}
