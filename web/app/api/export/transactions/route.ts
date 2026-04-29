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
    const features = getTierFeatures(club?.tier ?? "starter");
    if (!features.reports) {
      return new Response(
        "Excel and PDF exports require a Growth plan or higher. Use CSV instead, or upgrade.",
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

  const headers = [
    "Date", "Member First Name", "Member Last Name",
    "Amount ($)", "Platform Fee ($)", "Type", "Status", "Description",
    "Stripe Payment Intent",
  ];

  const rows = transactions.map((t) => [
    t.createdAt.toISOString().split("T")[0],
    t.member?.firstName ?? "",
    t.member?.lastName ?? "",
    t.amount.toString(),
    t.platformFee?.toString() ?? "",
    t.type,
    t.status,
    t.description ?? "",
    t.stripePaymentIntentId ?? "",
  ]);

  return exportResponse(
    format,
    "transactions-export",
    headers,
    rows,
    "Transactions Export",
    "Transactions",
  );
}
