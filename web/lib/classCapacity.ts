// Class limits (owner decision 2026-11-17).
//
// A class with a capacity takes that many people per class day. A member (or
// a parent booking for a child) cannot book a full day; it reads "Full".
// Staff can still add someone over the limit, after a clear warning. A class
// with NO capacity is unlimited, exactly as before, and nothing here ever
// removes a booking: a day that was already over its limit when this shipped
// simply shows as full.
//
// What counts as taken: every attendance row on that class day. A class
// booking IS an attendance row, a family cancelling deletes theirs, and
// someone marked absent afterwards still held their spot.
//
// PURE. The database half is lib/classCapacityServer.ts.

/** What a member sees and gets back when the day is full. */
export const CLASS_FULL_LABEL = "Full";
export const CLASS_FULL_CODE = "CLASS_FULL";
export const CLASS_FULL_BODY = {
  error: "This class is full. Ask the front desk if a spot opens up.",
  code: CLASS_FULL_CODE,
} as const;

/**
 * The limit for one class day: that day's own limit when a coach or owner set
 * one (ClassSession.capacity), otherwise the class's (RecurringClass.capacity).
 * Both unset = unlimited.
 */
export function dayCapacity(sessionCapacity: number | null | undefined, classCapacity: number | null | undefined): number | null {
  return classLimit(sessionCapacity) ?? classLimit(classCapacity);
}

/** null / undefined / 0 or less = no limit. */
export function classLimit(capacity: number | null | undefined): number | null {
  return capacity != null && capacity > 0 ? capacity : null;
}

export function classSpotsLeft(capacity: number | null | undefined, taken: number): number | null {
  const limit = classLimit(capacity);
  return limit == null ? null : Math.max(0, limit - taken);
}

export function classIsFull(capacity: number | null | undefined, taken: number): boolean {
  return classSpotsLeft(capacity, taken) === 0;
}

/**
 * What a member is offered on a full class day. Someone already booked keeps
 * their booking and everything they could do with it; everyone else sees
 * "Full" and has nothing to tap.
 */
export function fullDayOffer<T extends { canBook: boolean; statusText: string; bookingStatus?: string | null }>(offer: T, full: boolean): T {
  if (!full || offer.bookingStatus) return offer;
  return { ...offer, canBook: false, statusText: CLASS_FULL_LABEL };
}

/** The sentence staff read before adding someone to a full class day. */
export function overLimitWarning(capacity: number | null | undefined, taken: number, who?: string | null): string | null {
  const limit = classLimit(capacity);
  if (limit == null || taken < limit) return null;
  const name = who?.trim() || "this person";
  return `This class is full: ${taken} of ${limit} spots are taken. Adding ${name} puts it at ${taken + 1} of ${limit}.`;
}
