// A class day the CLUB cancelled, as families see it (pure — no prisma, safe
// in client components).
//
// A cancelled class day never vanishes from a family's screens: it stays where
// it was, reads "Canceled", is greyed and struck through, and offers no
// booking, price, check-in or cancel action. Two surfaces share these rules:
//
//   the schedule      app/api/member/schedule → app/member/schedule
//   the bookings list app/api/member/portal   → components/member/BookingsPanel
//
// Visibility is NOT decided here. Each feed keeps the filter it always had (a
// PRIVATE, roster-only class stays roster-only; a booking is only ever the
// family's own), so a cancelled day shows only where the class already did.

export type CanceledDayFacts = {
  canceled?: boolean | null;
  cancelReason?: string | null;
  /** BOOKED | CLASS_MEMBERS | BOTH | NONE — who the club chose to tell. */
  cancelNotifyAudience?: string | null;
};

/** The word families read on a cancelled class day (the spelling the portal already uses). */
export const CANCELED_LABEL = "Canceled";

/**
 * The reason a family may read. Only when the cancellation was announced to
 * families (an audience other than NONE) — otherwise the reason is a
 * staff-side note and stays one.
 */
export function sharedCancelReason(s: CanceledDayFacts): string | null {
  if (!s.canceled) return null;
  if (!s.cancelNotifyAudience || s.cancelNotifyAudience === "NONE") return null;
  const reason = typeof s.cancelReason === "string" ? s.cancelReason.trim() : "";
  return reason || null;
}

/**
 * What a family's schedule entry for one class day may offer. A cancelled day
 * keeps nothing actionable, whatever the membership or booking says.
 */
export function canceledDayOffer<T extends { canBook: boolean; statusText: string; price: string | null; bookingLabel: string | null }>(
  offer: T,
  canceled: boolean,
): T {
  return canceled ? { ...offer, canBook: false, statusText: CANCELED_LABEL, price: null, bookingLabel: null } : offer;
}

/** Statuses that are over for good — nothing left to act on. */
export const TERMINAL_BOOKING_STATUSES: ReadonlySet<string> = new Set(["CANCELED", "DECLINED", "COMPLETED"]);

export type ClassBookingState = {
  /** CONFIRMED, or CANCELED when the club cancelled the class day. */
  status: "CONFIRMED" | "CANCELED";
  /** true = the CLUB cancelled the day (not the family cancelling their booking). */
  dayCanceled: boolean;
  cancelReason: string | null;
};

/** A booked class day → how it reads in the family's bookings list. */
export function classBookingState(s: CanceledDayFacts): ClassBookingState {
  if (!s.canceled) return { status: "CONFIRMED", dayCanceled: false, cancelReason: null };
  return { status: "CANCELED", dayCanceled: true, cancelReason: sharedCancelReason(s) };
}

type ListedBooking = { status: string; dayCanceled?: boolean; startMs: number };

/**
 * Does a booking belong under "Upcoming"? Anything still ahead that is not
 * over — PLUS a class day the club cancelled, which stays in place (marked
 * Canceled) until its time has passed, instead of dropping out of the list the
 * family is looking at.
 */
export function isUpcomingBooking(b: ListedBooking, nowMs: number): boolean {
  if (b.startMs < nowMs) return false;
  return !TERMINAL_BOOKING_STATUSES.has(b.status) || !!b.dayCanceled;
}

/** "Past" is everything "Upcoming" is not. */
export function isPastBooking(b: ListedBooking, nowMs: number): boolean {
  return !isUpcomingBooking(b, nowMs);
}

/** May the family act on it (check in, cancel, manage)? Never on a terminal or cancelled day. */
export function bookingIsActionable(b: { status: string; dayCanceled?: boolean }): boolean {
  return !b.dayCanceled && !TERMINAL_BOOKING_STATUSES.has(b.status);
}

/**
 * The staff-side cancellation audit must not ride along to a family's browser
 * with their booking: who cancelled, whether coaches were still paid, how many
 * people were told — and the reason, unless it was shared. Mutates and returns
 * the row (the portal feed scrubs each booked class day before responding).
 */
export function scrubCancelAudit<T extends Record<string, unknown> & CanceledDayFacts>(session: T): T {
  const s = session as Record<string, unknown>;
  s.cancelReason = sharedCancelReason(session);
  for (const k of ["canceledByUserId", "cancelNotifiedCount", "cancelPaidByUserId", "cancelPaidAt"]) if (k in s) s[k] = null;
  if ("cancelPaid" in s) s.cancelPaid = false;
  return session;
}
