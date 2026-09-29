// Linking a public event signup to an existing club member — the pure rules
// behind /api/events/[id]/registrations/[regId]/link-member.

/** "  Eli   FASULO " → "eli fasulo". Exact-name suggestions compare on this. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Does linking this registration need the member's Booking created now?
 * Yes when it already holds a confirmed spot — an active status and not
 * waiting on (or refused by) a coach. That is exactly when approval (or a
 * member's own non-approval signup) would already have booked a member row.
 * Under review: approving it will create the Booking, as for any member.
 */
export function linkBookingNeeded(
  reg: { status: string; approvalStatus?: string | null },
  activeStatuses: readonly string[],
): boolean {
  if (!activeStatuses.includes(reg.status)) return false;
  return reg.approvalStatus !== "PENDING" && reg.approvalStatus !== "DECLINED";
}
