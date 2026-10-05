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

// ── Public signup → member matching ─────────────────────────────────────────
//
// A public registration carries a name and an email and nothing else. Matching
// on the email alone is how two brothers registered by one parent both landed
// on the FIRST brother's member record (Finger Lakes Duals, 2026-10): the
// second registration then shared his Booking, and approving one collided with
// the other. An email identifies a household, not an athlete — the name picks
// the athlete inside it.

export type SignupMatchCandidate = { id: string; firstName: string; lastName: string };

/** The member's name as a registration would spell it. */
export function memberNameKey(m: { firstName: string; lastName: string }): string {
  return nameKey(`${m.firstName} ${m.lastName}`);
}

/**
 * Which member a public signup is for. `candidates` are the club's non-deleted
 * members reachable by the submitted email (their own, or a guardian's). The
 * registration links only when EXACTLY ONE of them has the submitted name;
 * otherwise it stays unlinked (null) and staff link it from Attendees →
 * "Link to member". Never guesses: no name match, or two members with the same
 * name on one email, is null.
 */
export function matchMemberForPublicSignup(args: {
  name: string;
  candidates: readonly SignupMatchCandidate[];
}): string | null {
  const key = nameKey(args.name);
  if (!key) return null;
  const hits = new Set<string>();
  for (const c of args.candidates) if (memberNameKey(c) === key) hits.add(c.id);
  if (hits.size !== 1) return null;
  return Array.from(hits)[0];
}

// ── Approval → Booking ──────────────────────────────────────────────────────

/**
 * What approving a member-linked registration does to the member's Booking.
 * Decided by READING the row first — never by attempting a create and catching
 * the unique violation, which inside a Postgres transaction aborts the whole
 * transaction and silently loses the approval itself.
 */
export function bookingActionOnApprove(existing: { status: string } | null): "create" | "reconfirm" | "keep" {
  if (!existing) return "create";
  return existing.status === "CANCELED" ? "reconfirm" : "keep";
}

/**
 * Two registrations on one event pointing at one member record, under
 * different names, are two athletes — one of them is linked to the wrong
 * member. Approval still goes through (the coach's call), but says so.
 * `others` = the event's other non-canceled registrations with the same memberId.
 */
export function sharedMemberWarning(args: {
  registrationName: string;
  memberName: string | null;
  others: readonly { name: string }[];
}): string | null {
  const mine = nameKey(args.registrationName);
  const clash = args.others.find((o) => nameKey(o.name) !== mine);
  if (!clash) return null;
  const member = (args.memberName ?? "").trim();
  // Whichever of the two does NOT carry the member's name is the mislinked one.
  const wrong = member && nameKey(member) === mine ? clash.name : args.registrationName;
  return member
    ? `${wrong.trim()}'s registration is linked to ${member}'s member record — link it to the right member from Attendees.`
    : `${args.registrationName.trim()} and ${clash.name.trim()} are linked to the same member record — link one of them to the right member from Attendees.`;
}

/**
 * Does declining/withdrawing this registration release the member's Booking?
 * Not while another registration on the same event, for the same member
 * record, still holds a confirmed spot — the Booking is theirs too.
 */
export function releasesBookingOnDecline(
  othersOnSameMember: readonly { status: string; approvalStatus?: string | null }[],
  activeStatuses: readonly string[],
): boolean {
  return !othersOnSameMember.some((o) => linkBookingNeeded(o, activeStatuses));
}
