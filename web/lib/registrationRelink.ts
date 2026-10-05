// Repairing registrations linked to the WRONG member — the pure rule behind
// scripts/fix-martinez-registration.ts. No database.
//
// How they got there: the public signup used to match a member by email only,
// so a second sibling registered from the same parent email landed on the
// first sibling's member record (see lib/registrationLink).
//
// The rule is deliberately narrow. A registration is re-linked only when
//   1. it is active (not canceled / declined) and linked to a member,
//   2. its name is NOT that member's name, and
//   3. EXACTLY ONE other non-deleted member of the same club has exactly its
//      name (nameKey), and
//   4. that member has no other active registration on the same event.
// A nickname mismatch ("Zachary Boudreau" on member "Zach Boudreau") fails 3 —
// nobody else carries that name — and is left alone.

import { nameKey, memberNameKey, linkBookingNeeded } from "@/lib/registrationLink";

export type RelinkRegistration = {
  id: string;
  eventId: string;
  clubId: string;
  memberId: string | null;
  name: string;
  status: string;
  approvalStatus: string | null;
};
export type RelinkMember = { id: string; clubId: string; firstName: string; lastName: string };
export type RelinkBooking = { id: string; eventId: string; memberId: string; status: string };

export type BookingStep =
  /** The registration holds no confirmed spot yet — approval will book the right member. */
  | { kind: "NONE"; why: string }
  /** The wrongly-linked member's Booking was really this athlete's: re-point it. */
  | { kind: "MOVE"; bookingId: string }
  /** The right member already has a live Booking; the stray one is canceled. */
  | { kind: "CANCEL_STRAY"; bookingId: string; keepBookingId: string }
  /** The right member's Booking was canceled; this registration holds a spot — reconfirm it (and cancel the stray). */
  | { kind: "RECONFIRM"; bookingId: string; strayBookingId: string | null }
  /** The wrong member keeps their own Booking (they are approved too); the right member needs one. */
  | { kind: "CREATE" };

export type RelinkPlan = {
  registrationId: string;
  registrationName: string;
  eventId: string;
  clubId: string;
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string;
  toMemberName: string;
  booking: BookingStep;
};

export type RelinkSkip = { registrationId: string; registrationName: string; memberName: string; reason: string };

const isActive = (r: { status: string; approvalStatus: string | null }) =>
  r.status !== "CANCELED" && r.approvalStatus !== "DECLINED";

export function planRelinks(input: {
  registrations: readonly RelinkRegistration[];
  /** Non-deleted members of every club the registrations belong to. */
  members: readonly RelinkMember[];
  bookings: readonly RelinkBooking[];
  activeStatuses: readonly string[];
}): { plans: RelinkPlan[]; skipped: RelinkSkip[] } {
  const memberById = new Map(input.members.map((m) => [m.id, m]));
  const byClubName = new Map<string, RelinkMember[]>();
  for (const m of input.members) {
    const k = `${m.clubId}\u0000${memberNameKey(m)}`;
    byClubName.set(k, [...(byClubName.get(k) ?? []), m]);
  }
  const full = (m: RelinkMember) => `${m.firstName} ${m.lastName}`.trim();
  const active = input.registrations.filter(isActive);
  const bookingFor = (eventId: string, memberId: string) =>
    input.bookings.find((b) => b.eventId === eventId && b.memberId === memberId) ?? null;

  const plans: RelinkPlan[] = [];
  const skipped: RelinkSkip[] = [];
  // Targets claimed in this run, so two rows can't both be moved onto one member.
  const claimed = new Set<string>();

  for (const reg of active) {
    if (!reg.memberId) continue;
    const from = memberById.get(reg.memberId);
    if (!from) continue; // deleted member — not this script's business
    const key = nameKey(reg.name);
    if (!key || key === memberNameKey(from)) continue;

    const sameName = (byClubName.get(`${reg.clubId}\u0000${key}`) ?? []).filter((m) => m.id !== from.id);
    const skip = (reason: string) =>
      skipped.push({ registrationId: reg.id, registrationName: reg.name, memberName: full(from), reason });
    if (sameName.length === 0) {
      skip("no other member in the club has this exact name — left alone (nickname / spelling difference)");
      continue;
    }
    if (sameName.length > 1) {
      skip(`${sameName.length} members in the club have this exact name — ambiguous, link by hand`);
      continue;
    }
    const to = sameName[0];
    const targetTaken =
      claimed.has(`${reg.eventId}\u0000${to.id}`) ||
      active.some((r) => r.id !== reg.id && r.eventId === reg.eventId && r.memberId === to.id);
    if (targetTaken) {
      skip(`${full(to)} already has a registration on this event — remove one of the two by hand`);
      continue;
    }
    claimed.add(`${reg.eventId}\u0000${to.id}`);

    // ── The Booking ──
    const holdsSpot = linkBookingNeeded(reg, input.activeStatuses);
    const stray = bookingFor(reg.eventId, from.id);
    const strayLive = stray && stray.status !== "CANCELED" ? stray : null;
    const target = bookingFor(reg.eventId, to.id);
    // Does the wrongly-linked member hold a confirmed spot of their own here?
    const fromKeepsBooking = active.some(
      (r) => r.id !== reg.id && r.eventId === reg.eventId && r.memberId === from.id && linkBookingNeeded(r, input.activeStatuses),
    );

    let booking: BookingStep;
    if (!holdsSpot) {
      booking = { kind: "NONE", why: "registration is not confirmed yet — approving it books the right member" };
    } else if (fromKeepsBooking) {
      // from's Booking is legitimately theirs; give the right member their own.
      if (!target) booking = { kind: "CREATE" };
      else if (target.status === "CANCELED") booking = { kind: "RECONFIRM", bookingId: target.id, strayBookingId: null };
      else booking = { kind: "NONE", why: "both members already have their own Booking" };
    } else if (target && target.status !== "CANCELED") {
      booking = strayLive
        ? { kind: "CANCEL_STRAY", bookingId: strayLive.id, keepBookingId: target.id }
        : { kind: "NONE", why: "the right member already has the Booking" };
    } else if (target) {
      // Unique (eventId, memberId): a canceled row is in the way of a move.
      booking = { kind: "RECONFIRM", bookingId: target.id, strayBookingId: strayLive?.id ?? null };
    } else if (strayLive) {
      booking = { kind: "MOVE", bookingId: strayLive.id };
    } else {
      booking = { kind: "CREATE" };
    }

    plans.push({
      registrationId: reg.id,
      registrationName: reg.name,
      eventId: reg.eventId,
      clubId: reg.clubId,
      fromMemberId: from.id,
      fromMemberName: full(from),
      toMemberId: to.id,
      toMemberName: full(to),
      booking,
    });
  }
  return { plans, skipped };
}
