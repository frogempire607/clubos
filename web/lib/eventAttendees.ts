// One Attendees ledger for an event — the read-only merge of the roster
// (Booking) and the money (EventRegistration).
//
// PURE. No prisma, no Date.now(). The loader in lib/eventAttendeesServer.ts
// fetches the rows and passes them in, which is what lets every branch below
// be exercised by hand in scripts/event-attendees-tests.ts.
//
// ── The rule this must never break ──────────────────────────────────────────
// CLAUDE.md, "Event money model": EventRegistration is the money spine and
// Booking is derived from it. This module reads both and WRITES NEITHER. It
// exists so the events page can show one list instead of a Bookings modal
// and a Registrations modal that disagree about who is coming and who owes —
// the design handoff (docs/improvement/design_handoff_event_editor) merges the
// two into one screen for DISPLAY. The tables stay separate; nothing here is a
// new source of truth.
//
// ── Everything stated twice is derived ──────────────────────────────────────
// One ledger feeds the tiles, the filter counts, the capacity bar segments,
// the event rows' "$x to collect" chip and every "Attendees · n" button. The
// handoff's review found three rounds of drift where those were hard-coded
// copies. They are all computed from `rows` here, once.

import {
  ACTIVE_REGISTRATION_STATUSES,
  UNPAID_REGISTRATION_STATUSES,
  registrationWaitingOn,
  type RegistrationWaitingOn,
} from "@/lib/eventPayments";

export type AttendeeSource = "MEMBER" | "PUBLIC";

/** The status vocabulary the row renders. Reuses REG_STATUS_UI's keys plus the
 *  two roster-only states a booking can be in without any money attached. */
export type AttendeeStatus =
  | "PAID"
  | "SCHEDULED"
  | "AWAITING_CASH"
  | "AWAITING_CHECK"
  | "PAYMENT_FAILED"
  | "PENDING_PAYMENT"
  | "PENDING_REVIEW"
  | "REGISTERED"
  | "CANCELED"
  /** A booking with no registration on an event that has a membership cover
   *  or no price at all — they are coming and owe nothing. */
  | "COVERED"
  /** A booking on the waitlist. Not a spot, not money. */
  | "WAITLISTED";

export type AttendeeTone = "paid" | "owed" | "warn" | "muted" | "info";

export const ATTENDEE_STATUS_UI: Record<AttendeeStatus, { label: string; tone: AttendeeTone }> = {
  PAID: { label: "Paid", tone: "paid" },
  SCHEDULED: { label: "Card charge scheduled", tone: "muted" },
  AWAITING_CASH: { label: "Awaiting cash", tone: "owed" },
  AWAITING_CHECK: { label: "Awaiting check", tone: "owed" },
  PAYMENT_FAILED: { label: "Payment failed", tone: "warn" },
  PENDING_PAYMENT: { label: "Didn't finish checkout", tone: "warn" },
  PENDING_REVIEW: { label: "Waiting on you", tone: "info" },
  REGISTERED: { label: "Registered", tone: "muted" },
  CANCELED: { label: "Canceled", tone: "muted" },
  COVERED: { label: "Covered", tone: "paid" },
  WAITLISTED: { label: "Waitlisted", tone: "muted" },
};

/** What the loader hands in for each registration. A subset of the Prisma row
 *  plus the two things only the server can resolve (recipient, waitingOn). */
export type LedgerRegistration = {
  id: string;
  memberId: string | null;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  amountDue: number | null;
  amountPaid: number | null;
  approvalStatus?: string | null;
  proposedChange?: unknown;
  proposedChangeRespondedAt?: Date | string | null;
  scheduledChargeAt?: Date | string | null;
  paidAt?: Date | string | null;
  createdAt?: Date | string | null;
  /** Slice 2 — sessions a per-session purchase bought. Empty/absent = whole event. */
  sessionIds?: string[] | null;
  formResponses?: Record<string, unknown> | null;
  /** Resolved through the family model; null = undeliverable. */
  recipientEmail?: string | null;
  recipientName?: string | null;
};

export type LedgerBooking = {
  id: string;
  memberId: string;
  status: string; // BookingStatus
  member: { id: string; firstName: string; lastName: string; email?: string | null; phone?: string | null; guardianEmail?: string | null; guardianName?: string | null };
  createdAt?: Date | string | null;
};

export type LedgerEvent = {
  capacity: number | null;
  /** True when a membership covers this event or there is no price at all —
   *  a booking-only row then reads COVERED rather than REGISTERED. */
  coveredOrFree: boolean;
  /** The club's word for the first signup question ("Weight", "Division"…). */
  categoryKey?: string | null;
  categoryLabel?: string | null;
  sessionCount: number;
};

export type AttendeeRow = {
  /** registration id when one exists, else the booking id (prefixed). */
  id: string;
  registrationId: string | null;
  bookingId: string | null;
  source: AttendeeSource;
  memberId: string | null;
  name: string;
  /** The address a bill would actually go to (family-resolved), or null. */
  email: string | null;
  emailNote: string | null;
  phone: string | null;
  categoryValue: string | null;
  /** "Whole event" / "Whole event · 6 sessions" / "2 of 6 sessions" (slice 2). */
  attending: string;
  owes: number;
  paid: number;
  scheduledAmount: number;
  scheduledAt: string | null;
  status: AttendeeStatus;
  label: string;
  tone: AttendeeTone;
  waitingOn: RegistrationWaitingOn | null;
  bookingStatus: string | null;
  /** True for CANCELED registrations and CANCELED bookings — hidden by default. */
  removed: boolean;
  createdAt: string | null;
};

export type AttendeeFilter = "all" | "owes" | "waiting" | "scheduled" | "settled";

export type AttendeeLedger = {
  rows: AttendeeRow[];
  /** Rows not marked removed — what the screen shows by default. */
  visible: number;
  removed: number;
  tiles: {
    collected: number;
    outstanding: number;
    outstandingCount: number;
    scheduled: number;
    scheduledCount: number;
    waitingOnYou: number;
  };
  filters: Record<AttendeeFilter, number>;
  /** Segments for the capacity bar, all counts of VISIBLE spot-holding rows. */
  capacity: {
    capacity: number | null;
    attendees: number;
    settled: number;
    owe: number;
    scheduled: number;
    review: number;
    spotsLeft: number | null;
  };
};

const num = (v: unknown): number => {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

const money = (n: number) => Math.round(n * 100) / 100;

function iso(v: Date | string | null | undefined): string | null {
  if (!v) return null;
  return typeof v === "string" ? v : v.toISOString();
}

function categoryValueOf(responses: Record<string, unknown> | null | undefined, key: string | null | undefined): string | null {
  if (!responses || !key) return null;
  const v = responses[key];
  if (v == null || v === "") return null;
  return typeof v === "string" ? v : String(v);
}

function attendingLabel(ev: LedgerEvent, sessionIds?: string[] | null): string {
  // Slice 2: a per-session purchase says which sessions it bought. Nothing
  // else about the row changes — owes/paid still come from the snapshot.
  if (sessionIds && sessionIds.length > 0) {
    return sessionIds.length === 1 ? "1 session" : `${sessionIds.length} of ${ev.sessionCount} sessions`;
  }
  if (ev.sessionCount > 1) return `Whole event · ${ev.sessionCount} sessions`;
  return "Whole event";
}

/** Does this row belong in the "owes money" bucket? */
export function rowOwes(r: Pick<AttendeeRow, "owes" | "status">): boolean {
  return r.owes > 0 && (UNPAID_REGISTRATION_STATUSES as string[]).includes(r.status);
}

/** Does this row hold a spot (count against capacity)? */
export function rowHoldsSpot(r: Pick<AttendeeRow, "status" | "removed" | "bookingStatus" | "registrationId">): boolean {
  if (r.removed) return false;
  if (r.registrationId) return (ACTIVE_REGISTRATION_STATUSES as string[]).includes(r.status);
  // Booking-only rows: CONFIRMED/ATTENDED/NO_SHOW hold a spot, WAITLISTED does not.
  return r.bookingStatus !== "WAITLISTED";
}

export function matchesFilter(r: AttendeeRow, f: AttendeeFilter): boolean {
  switch (f) {
    case "all":
      return true;
    case "owes":
      return rowOwes(r);
    case "waiting":
      return r.waitingOn === "COACH" || r.status === "PENDING_REVIEW";
    case "scheduled":
      return r.status === "SCHEDULED";
    case "settled":
      return r.status === "PAID" || r.status === "COVERED";
  }
}

/**
 * Merge registrations (money) and bookings (roster) into one ledger.
 *
 * Join rule: a booking and a registration for the same memberId are ONE row —
 * the registration wins the status and the money, the booking contributes the
 * waitlist/attended state. A registration with no booking (public signup, or a
 * member registration whose booking is still being created) is a row on its
 * own. A booking with no registration is a roster-only row that owes nothing.
 */
export function buildAttendeeLedger(
  ev: LedgerEvent,
  registrations: LedgerRegistration[],
  bookings: LedgerBooking[],
  opts: { now?: Date } = {},
): AttendeeLedger {
  const now = opts.now ?? new Date(0);
  const bookingByMember = new Map<string, LedgerBooking>();
  for (const b of bookings) bookingByMember.set(b.memberId, b);
  const consumedBookings = new Set<string>();

  const rows: AttendeeRow[] = [];

  for (const r of registrations) {
    const booking = r.memberId ? bookingByMember.get(r.memberId) ?? null : null;
    if (booking) consumedBookings.add(booking.id);
    const status = (r.status in ATTENDEE_STATUS_UI ? r.status : "REGISTERED") as AttendeeStatus;
    const ui = ATTENDEE_STATUS_UI[status];
    const due = num(r.amountDue);
    const paid = num(r.amountPaid);
    const unpaid = (UNPAID_REGISTRATION_STATUSES as string[]).includes(r.status);
    const owes = unpaid ? money(Math.max(0, due - paid)) : 0;
    const waitingOn = registrationWaitingOn(r, { now });
    const removed = r.status === "CANCELED" || r.approvalStatus === "DECLINED";
    rows.push({
      id: r.id,
      registrationId: r.id,
      bookingId: booking?.id ?? null,
      source: r.memberId ? "MEMBER" : "PUBLIC",
      memberId: r.memberId,
      name: r.name || (booking ? `${booking.member.firstName} ${booking.member.lastName}` : "—"),
      email: r.recipientEmail ?? r.email ?? null,
      emailNote: r.recipientName ?? null,
      phone: r.phone ?? booking?.member.phone ?? null,
      categoryValue: categoryValueOf(r.formResponses, ev.categoryKey),
      attending: attendingLabel(ev, r.sessionIds),
      owes,
      paid: r.status === "PAID" ? money(paid > 0 ? paid : due) : money(paid),
      scheduledAmount: r.status === "SCHEDULED" ? money(due) : 0,
      scheduledAt: r.status === "SCHEDULED" ? iso(r.scheduledChargeAt) : null,
      status,
      label: status === "PAID" && paid > 0 ? `Paid $${money(paid).toFixed(2)}` : ui.label,
      tone: ui.tone,
      waitingOn,
      bookingStatus: booking?.status ?? null,
      removed,
      createdAt: iso(r.createdAt),
    });
  }

  for (const b of bookings) {
    if (consumedBookings.has(b.id)) continue;
    const removed = b.status === "CANCELED";
    const status: AttendeeStatus = b.status === "WAITLISTED" ? "WAITLISTED" : ev.coveredOrFree ? "COVERED" : "REGISTERED";
    const ui = ATTENDEE_STATUS_UI[status];
    rows.push({
      id: `booking:${b.id}`,
      registrationId: null,
      bookingId: b.id,
      source: "MEMBER",
      memberId: b.memberId,
      name: `${b.member.firstName} ${b.member.lastName}`.trim(),
      email: b.member.guardianEmail ?? b.member.email ?? null,
      emailNote: b.member.guardianEmail && b.member.guardianName ? `${b.member.guardianName} (guardian)` : null,
      phone: b.member.phone ?? null,
      categoryValue: null,
      attending: attendingLabel(ev),
      owes: 0,
      paid: 0,
      scheduledAmount: 0,
      scheduledAt: null,
      status,
      label: ui.label,
      tone: ui.tone,
      waitingOn: null,
      bookingStatus: b.status,
      removed,
      createdAt: iso(b.createdAt),
    });
  }

  // Newest signups first is how staff look for "did the Smiths get in".
  rows.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));

  const live = rows.filter((r) => !r.removed);
  const tiles = {
    collected: money(live.reduce((s, r) => s + (r.status === "PAID" ? r.paid : 0), 0)),
    outstanding: money(live.reduce((s, r) => s + (rowOwes(r) ? r.owes : 0), 0)),
    outstandingCount: live.filter(rowOwes).length,
    scheduled: money(live.reduce((s, r) => s + r.scheduledAmount, 0)),
    scheduledCount: live.filter((r) => r.status === "SCHEDULED").length,
    waitingOnYou: live.filter((r) => matchesFilter(r, "waiting")).length,
  };

  const filters: Record<AttendeeFilter, number> = {
    all: live.length,
    owes: live.filter((r) => matchesFilter(r, "owes")).length,
    waiting: tiles.waitingOnYou,
    scheduled: tiles.scheduledCount,
    settled: live.filter((r) => matchesFilter(r, "settled")).length,
  };

  const holding = live.filter(rowHoldsSpot);
  const capacity = {
    capacity: ev.capacity,
    attendees: holding.length,
    settled: holding.filter((r) => matchesFilter(r, "settled") || (r.status === "REGISTERED" && r.owes === 0)).length,
    owe: holding.filter(rowOwes).length,
    scheduled: holding.filter((r) => r.status === "SCHEDULED").length,
    review: live.filter((r) => matchesFilter(r, "waiting")).length,
    spotsLeft: ev.capacity != null ? Math.max(0, ev.capacity - holding.length) : null,
  };

  return { rows, visible: live.length, removed: rows.length - live.length, tiles, filters, capacity };
}

/** The per-event summary the events list needs for its row treatments. The
 *  same numbers as the ledger's tiles/capacity, minus the rows. */
export type EventMoneySummary = {
  attendees: number;
  settled: number;
  owe: number;
  outstanding: number;
  scheduled: number;
  scheduledAmount: number;
  review: number;
  collected: number;
  waitlisted: number;
};

export function summarizeLedger(l: AttendeeLedger): EventMoneySummary {
  return {
    attendees: l.capacity.attendees,
    settled: l.capacity.settled,
    owe: l.capacity.owe,
    outstanding: l.tiles.outstanding,
    scheduled: l.capacity.scheduled,
    scheduledAmount: l.tiles.scheduled,
    review: l.capacity.review,
    collected: l.tiles.collected,
    waitlisted: l.rows.filter((r) => !r.removed && r.status === "WAITLISTED").length,
  };
}
