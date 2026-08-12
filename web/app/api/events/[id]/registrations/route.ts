import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { runDueEventCharges } from "@/lib/eventAutoCharge";
import {
  eventAllowedPaymentMethods,
  UNPAID_REGISTRATION_STATUSES,
  ACTIVE_REGISTRATION_STATUSES,
  AWAITING_OFFLINE_STATUSES,
  resolveEventPolicy,
  registrationWaitingOn,
} from "@/lib/eventPayments";
import { canDecideRegistrations } from "@/lib/eventApproval";
import { hasPermission } from "@/lib/permissions";
import { publicFixedPrice } from "@/lib/eventPricing";
import { resolveRegistrationRecipients } from "@/lib/eventRecipients";

// The lazy charge sweep below talks to Stripe, so this GET can outlive the
// default serverless limit. It stays deliberately small (see the sweep call) —
// /api/cron/event-charges is the path built for volume.
export const maxDuration = 60;

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
      registrationDeadline: true,
      // Phase 5 — the roster is where a coach decides, so it needs the policy
      // (resolved, never the raw columns) and the responsible coach.
      requiresCoachApproval: true,
      approvalPaymentIntent: true,
      allowProposedChanges: true,
      responsibleCoachUserId: true,
      holdSpotDuringReview: true,
      cancellationPolicyText: true,
      paymentDueBy: true,
      customEventType: { select: { defaultPolicy: true } },
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Lazy sweep: with no cron in the app, opening the roster is one of the
  // moments a due event-day charge actually runs. Never blocks the response on
  // failure (runDueEventCharges swallows its own errors). Capped low on
  // purpose — each charge is a round trip to Stripe, and staff opening a roster
  // shouldn't wait on a long queue. Whatever's left is picked up by the next
  // open or by /api/cron/event-charges.
  await runDueEventCharges({ clubId: session.user.clubId, eventId: event.id, limit: 3 });

  const rows = await prisma.eventRegistration.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: "asc" },
    include: {
      member: {
        // isMinor + guardianName drive the roster's inline "add an email"
        // repair: a minor's address belongs on the guardian fields, and the
        // member PATCH rejects a guardian email with no guardian name.
        select: { id: true, firstName: true, lastName: true, isMinor: true, guardianName: true },
      },
    },
  });

  // Where each invoice would ACTUALLY go. EventRegistration.email is a
  // snapshot from row-creation time and is empty for any minor without a
  // personal address — rendering it raw showed a blank Contact cell for
  // families who all have deliverable guardian addresses, and staff read that
  // as "no email on file". Resolved through the Phase 3E family model so the
  // roster preview and the send agree.
  const recipients = await resolveRegistrationRecipients(session.user.clubId, rows);
  const now = new Date();
  const registrations = rows.map((r) => ({
    ...r,
    recipient: recipients.get(r.id) ?? null,
    // One resolver for "who is this waiting on" — the same function the render
    // context, the probes and the reminder scheduler use, so the roster can
    // never disagree with the email the family got.
    waitingOn: registrationWaitingOn(r, { now }),
  }));

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
  const awaitingOfflineCount = registrations.filter((r) =>
    (AWAITING_OFFLINE_STATUSES as string[]).includes(r.status),
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

  const policy = resolveEventPolicy(event);
  const pendingReviewCount = registrations.filter((r) => r.approvalStatus === "PENDING").length;
  const awaitingParentCount = registrations.filter(
    (r) => !!r.proposedChange && !r.proposedChangeRespondedAt,
  ).length;

  return NextResponse.json({
    event: {
      ...event,
      paymentMethods: eventAllowedPaymentMethods(event),
      policy,
      // Whether THIS user may approve/decline/propose here. The responsible
      // coach can decide their own event without event-editing rights, so the
      // answer is per-user and belongs on the server side of the wire.
      canDecide: canDecideRegistrations(
        session,
        event,
        hasPermission(
          (session.user as unknown as { permissions?: Record<string, unknown> | null }).permissions ?? null,
          "events",
          "edit",
        ),
      ),
    },
    pendingReviewCount,
    awaitingParentCount,
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
