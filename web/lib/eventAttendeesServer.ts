// The ONE loader for the Attendees ledger. The pure resolver in
// lib/eventAttendees.ts decides; this fetches. Read-only — it never writes a
// registration, a booking or a transaction.

import { prisma } from "@/lib/prisma";
import { resolveRegistrationRecipients } from "@/lib/eventRecipients";
import { resolveEventPolicy } from "@/lib/eventPayments";
import { resolveCategoryFields } from "@/lib/eventCategories";
import {
  buildAttendeeLedger,
  summarizeLedger,
  type AttendeeLedger,
  type EventMoneySummary,
  type LedgerBooking,
  type LedgerRegistration,
} from "@/lib/eventAttendees";

const REG_SELECT = {
  id: true,
  eventId: true,
  memberId: true,
  name: true,
  email: true,
  phone: true,
  status: true,
  amountDue: true,
  amountPaid: true,
  sessionIds: true,
  approvalStatus: true,
  proposedChange: true,
  proposedChangeRespondedAt: true,
  scheduledChargeAt: true,
  paidAt: true,
  createdAt: true,
  formResponses: true,
} as const;

const BOOKING_SELECT = {
  id: true,
  eventId: true,
  memberId: true,
  status: true,
  createdAt: true,
  member: {
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, guardianEmail: true, guardianName: true },
  },
} as const;

function coveredOrFree(e: {
  memberPrice: unknown;
  nonMemberPrice: unknown;
  dropInFee: unknown;
  variableCostEnabled: boolean;
  pricingOptions: unknown;
}): boolean {
  const covered = Array.isArray(e.pricingOptions)
    ? (e.pricingOptions as Array<{ type?: string; membershipId?: string }>).some(
        (p) => p?.type === "membership" && !!p.membershipId,
      )
    : false;
  const priced = e.memberPrice != null || e.nonMemberPrice != null || e.dropInFee != null || e.variableCostEnabled;
  return covered || !priced;
}

export type EventAttendeesPayload = {
  event: {
    id: string;
    name: string;
    startsAt: Date;
    endsAt: Date;
    capacity: number | null;
    publicSlug: string | null;
    sessionCount: number;
    categoryLabel: string | null;
    categoryKey: string | null;
  };
  ledger: AttendeeLedger;
};

export async function loadEventAttendees(clubId: string, eventId: string): Promise<EventAttendeesPayload | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      startsAt: true,
      endsAt: true,
      capacity: true,
      publicSlug: true,
      registrationForm: true,
      memberPrice: true,
      nonMemberPrice: true,
      dropInFee: true,
      variableCostEnabled: true,
      pricingOptions: true,
      requiresCoachApproval: true,
      approvalPaymentIntent: true,
      allowProposedChanges: true,
      responsibleCoachUserId: true,
      holdSpotDuringReview: true,
      customEventType: { select: { defaultPolicy: true } },
      _count: { select: { sessions: true } },
    },
  });
  if (!event) return null;

  const [regs, bookings] = await Promise.all([
    prisma.eventRegistration.findMany({ where: { eventId: event.id }, select: REG_SELECT }),
    prisma.booking.findMany({ where: { eventId: event.id }, select: BOOKING_SELECT }),
  ]);

  // Where each bill would ACTUALLY go — the family model, not the snapshot
  // on the registration row (blank for minors without their own address).
  const recipients = await resolveRegistrationRecipients(clubId, regs);

  const policy = resolveEventPolicy(event);
  const category = resolveCategoryFields(event, policy)[0] ?? null;

  const ledgerRegs: LedgerRegistration[] = regs.map((r) => {
    const rec = recipients.get(r.id);
    return {
      ...r,
      amountDue: r.amountDue == null ? null : Number(r.amountDue),
      amountPaid: r.amountPaid == null ? null : Number(r.amountPaid),
      formResponses: (r.formResponses ?? null) as Record<string, unknown> | null,
      recipientEmail: rec?.email ?? null,
      recipientName: rec?.displayName ?? null,
    };
  });
  const ledgerBookings: LedgerBooking[] = bookings.map((b) => ({ ...b, status: String(b.status) }));

  const ledger = buildAttendeeLedger(
    {
      capacity: event.capacity,
      coveredOrFree: coveredOrFree(event),
      categoryKey: category?.key ?? null,
      categoryLabel: category?.label ?? null,
      sessionCount: event._count.sessions,
    },
    ledgerRegs,
    ledgerBookings,
    { now: new Date() },
  );

  return {
    event: {
      id: event.id,
      name: event.name,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      capacity: event.capacity,
      publicSlug: event.publicSlug,
      sessionCount: event._count.sessions,
      categoryLabel: category?.label ?? null,
      categoryKey: category?.key ?? null,
    },
    ledger,
  };
}

/**
 * Per-event money summaries for the events LIST — the numbers behind the
 * "$x to collect" chip, the segmented capacity bar and "Attendees · n" on
 * every row treatment. Two queries for the whole list, never one per event.
 * Recipients are not resolved here (the list never shows an address).
 */
export async function loadEventMoneySummaries(
  clubId: string,
  events: Array<{
    id: string;
    capacity: number | null;
    memberPrice: unknown;
    nonMemberPrice: unknown;
    dropInFee: unknown;
    variableCostEnabled: boolean;
    pricingOptions: unknown;
    sessions?: unknown[];
  }>,
): Promise<Map<string, EventMoneySummary>> {
  const out = new Map<string, EventMoneySummary>();
  if (events.length === 0) return out;
  const ids = events.map((e) => e.id);
  const [regs, bookings] = await Promise.all([
    prisma.eventRegistration.findMany({ where: { eventId: { in: ids }, event: { clubId } }, select: REG_SELECT }),
    prisma.booking.findMany({ where: { eventId: { in: ids }, event: { clubId } }, select: BOOKING_SELECT }),
  ]);
  const regsBy = new Map<string, LedgerRegistration[]>();
  for (const r of regs) {
    const row: LedgerRegistration = {
      ...r,
      amountDue: r.amountDue == null ? null : Number(r.amountDue),
      amountPaid: r.amountPaid == null ? null : Number(r.amountPaid),
      formResponses: null,
    };
    regsBy.set(r.eventId, [...(regsBy.get(r.eventId) ?? []), row]);
  }
  const bookingsBy = new Map<string, LedgerBooking[]>();
  for (const b of bookings) {
    bookingsBy.set(b.eventId, [...(bookingsBy.get(b.eventId) ?? []), { ...b, status: String(b.status) }]);
  }
  const now = new Date();
  for (const e of events) {
    const ledger = buildAttendeeLedger(
      {
        capacity: e.capacity,
        coveredOrFree: coveredOrFree(e),
        sessionCount: Array.isArray(e.sessions) ? e.sessions.length : 0,
      },
      regsBy.get(e.id) ?? [],
      bookingsBy.get(e.id) ?? [],
      { now },
    );
    out.set(e.id, summarizeLedger(ledger));
  }
  return out;
}
