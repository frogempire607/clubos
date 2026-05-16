import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/events/[id]/registrations
// Owner/staff: list everyone who signed up (public link or matched member),
// with form answers, payment status, and per-registrant invoice tracking.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      publicSlug: true,
      registrationForm: true,
      memberPrice: true,
      nonMemberPrice: true,
      dropInFee: true,
      variableCostEnabled: true,
      variableCostMode: true,
      variableCostTotal: true,
      variableCostEstimatedSignups: true,
      variableCostEstimatedTotal: true,
      variableCostBilledAt: true,
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const registrations = await prisma.eventRegistration.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: "asc" },
    include: { member: { select: { id: true, firstName: true, lastName: true } } },
  });

  const activeCount = registrations.filter((r) => r.status !== "CANCELED").length;
  const unpaidCount = registrations.filter(
    (r) => r.status !== "CANCELED" && r.status !== "PAID",
  ).length;
  const invoicedCount = registrations.filter((r) => r.invoiceCount > 0).length;

  // Compute the per-head share for the current mode so the UI can preview it.
  const mode = event.variableCostMode === "OFFICIAL" ? "OFFICIAL" : "ESTIMATED";
  let perHead: number | null = null;
  if (event.variableCostEnabled && activeCount > 0) {
    if (mode === "OFFICIAL" && event.variableCostTotal != null) {
      perHead = +(Number(event.variableCostTotal) / activeCount).toFixed(2);
    } else if (mode === "ESTIMATED") {
      const estTotal =
        event.variableCostTotal != null
          ? Number(event.variableCostTotal)
          : event.variableCostEstimatedTotal != null
            ? Number(event.variableCostEstimatedTotal)
            : 0;
      const divisor =
        event.variableCostEstimatedSignups && event.variableCostEstimatedSignups > 0
          ? event.variableCostEstimatedSignups
          : activeCount;
      if (estTotal > 0 && divisor > 0) perHead = +(estTotal / divisor).toFixed(2);
    }
  }

  return NextResponse.json({
    event,
    registrations,
    activeCount,
    unpaidCount,
    invoicedCount,
    mode,
    perHead,
    // Back-compat for any existing callers.
    officialPerHead: mode === "OFFICIAL" ? perHead : null,
  });
}
