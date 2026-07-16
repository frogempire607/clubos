import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runDueEventCharges } from "@/lib/eventAutoCharge";
import {
  eventAllowedPaymentMethods,
  UNPAID_REGISTRATION_STATUSES,
  ACTIVE_REGISTRATION_STATUSES,
} from "@/lib/eventPayments";
import { publicFixedPrice } from "@/lib/eventPricing";

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
      publicPricingOption: true,
      variableCostEnabled: true,
      variableCostMode: true,
      variableCostTotal: true,
      variableCostEstimatedSignups: true,
      variableCostEstimatedTotal: true,
      variableCostBilledAt: true,
      paymentMethods: true,
      autoChargeDate: true,
      requirePaymentBeforeCheckin: true,
      startsAt: true,
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Lazy sweep: with no cron in the app, opening the roster is one of the
  // moments a due event-day charge actually runs. Never blocks the response
  // on failure (runDueEventCharges swallows its own errors).
  await runDueEventCharges({ clubId: session.user.clubId, eventId: event.id, limit: 10 });

  const registrations = await prisma.eventRegistration.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: "asc" },
    include: { member: { select: { id: true, firstName: true, lastName: true } } },
  });

  // An abandoned card checkout (PENDING_PAYMENT) is not a registration —
  // it holds no spot and owes nothing until the client completes it.
  const activeCount = registrations.filter((r) =>
    (ACTIVE_REGISTRATION_STATUSES as string[]).includes(r.status),
  ).length;
  const unpaidCount = registrations.filter((r) =>
    (UNPAID_REGISTRATION_STATUSES as string[]).includes(r.status),
  ).length;
  const invoicedCount = registrations.filter((r) => r.invoiceCount > 0).length;
  // Offline money physically owed at the event — the "collect at the door" list.
  const awaitingOfflineCount = registrations.filter(
    (r) => r.status === "AWAITING_CASH" || r.status === "AWAITING_CHECK",
  ).length;
  const scheduledCount = registrations.filter((r) => r.status === "SCHEDULED").length;
  const failedCount = registrations.filter((r) => r.status === "PAYMENT_FAILED").length;

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
    event: { ...event, paymentMethods: eventAllowedPaymentMethods(event) },
    registrations,
    activeCount,
    unpaidCount,
    invoicedCount,
    awaitingOfflineCount,
    scheduledCount,
    failedCount,
    mode,
    perHead,
    // Fixed-price events: what a public registrant owes today (0 = free).
    // Lets the modal offer payment-link collection for unpaid registrants.
    publicPrice: event.variableCostEnabled ? null : publicFixedPrice(event),
    // Back-compat for any existing callers.
    officialPerHead: mode === "OFFICIAL" ? perHead : null,
  });
}
