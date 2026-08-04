// Where an event registrant's mail actually goes.
//
// EventRegistration.email is a SNAPSHOT taken when the row was created
// (`email: member.email ?? ""`). For a minor with no personal address that
// snapshot is an empty string, and for anyone whose email was added to their
// member record afterwards it's stale. Two consequences, both live on Frog
// Empire Road Trip:
//
//   1. The roster's Contact column rendered blank, so staff read "no email on
//      file" for families who all have deliverable addresses.
//   2. `bill-registrants` refused to invoice those rows at all
//      ("<name>: no email on file") — 4 of 8 unpaid families on that camp.
//
// This module resolves the real delivery address through the Phase 3E family
// model (`lib/emailRecipients.ts`) rather than a second lookup, so the roster
// preview and the actual send can never disagree, and both agree with how
// every other club email is addressed.
//
// Precedence, deliberately: the registration's OWN address wins when it has
// one. It is what the registrant typed (public signups), it is where any
// prior invoice for this registration already went, and silently redirecting
// a family's mail to a different address because our household model prefers
// the guardian would be a worse bug than the one this fixes. The family
// resolver fills the gap ONLY when the snapshot is empty.

import { resolveRecipients } from "@/lib/emailRecipients";

export type RecipientSource = "REGISTRATION" | "MEMBER_FAMILY";

export type RegistrationRecipient = {
  registrationId: string;
  /** The address the invoice will actually be sent to; null = undeliverable. */
  email: string | null;
  source: RecipientSource | null;
  /** "Vanessa Guindon (guardian)" when we routed through the family model. */
  displayName: string | null;
  /** Plain-English reason there is no address, for the roster cell. */
  reason: string | null;
  /** Member whose contact details would fix it — drives the inline fixer. */
  fixMemberId: string | null;
};

export type RegistrationForRecipient = {
  id: string;
  name?: string | null;
  email?: string | null;
  memberId?: string | null;
};

function plausible(email: string | null | undefined): string | null {
  const e = (email ?? "").trim();
  if (!e || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(e)) return null;
  return e;
}

/**
 * Resolve delivery addresses for a batch of registrations in ONE round-trip.
 *
 * Uses PER_ATHLETE_PRIMARY: one address per athlete, routed to that athlete's
 * primary guardian when they're a minor, to themselves when they're an adult.
 * That is exactly the shape of a per-registrant invoice — every other mode
 * either collapses siblings into one send (HOUSEHOLD) or fans out to every
 * guardian (ALL_GUARDIANS), neither of which is what a per-registration
 * payment link wants.
 *
 * Transactional: `respectMarketingOptOut` is false. A parent who opted out of
 * marketing still gets the bill for a camp they signed their kid up for.
 */
export async function resolveRegistrationRecipients(
  clubId: string,
  registrations: RegistrationForRecipient[],
): Promise<Map<string, RegistrationRecipient>> {
  const out = new Map<string, RegistrationRecipient>();

  // Only rows whose snapshot is unusable need the family lookup.
  const needsLookup = registrations.filter((r) => !plausible(r.email) && r.memberId);
  const memberIds = [...new Set(needsLookup.map((r) => r.memberId as string))];

  const byMember = new Map<string, { email: string; displayName: string | null }>();
  if (memberIds.length > 0) {
    const resolution = await resolveRecipients({
      clubId,
      memberIds,
      mode: "PER_ATHLETE_PRIMARY",
      respectMarketingOptOut: false,
    });
    for (const r of resolution.send) {
      const key = r.athleteMemberId ?? r.recipientMemberId ?? r.memberId;
      if (key && !byMember.has(key)) {
        byMember.set(key, { email: r.recipientEmail, displayName: r.recipientDisplayName });
      }
    }
  }

  for (const reg of registrations) {
    const own = plausible(reg.email);
    if (own) {
      out.set(reg.id, {
        registrationId: reg.id,
        email: own,
        source: "REGISTRATION",
        displayName: null,
        reason: null,
        fixMemberId: reg.memberId ?? null,
      });
      continue;
    }

    const family = reg.memberId ? byMember.get(reg.memberId) : undefined;
    if (family) {
      out.set(reg.id, {
        registrationId: reg.id,
        email: family.email,
        source: "MEMBER_FAMILY",
        displayName: family.displayName,
        reason: null,
        fixMemberId: reg.memberId ?? null,
      });
      continue;
    }

    // Explicit, never blank. A cell that says nothing reads as "we didn't
    // check" — this says what's actually missing and who to fix it on.
    out.set(reg.id, {
      registrationId: reg.id,
      email: null,
      source: null,
      displayName: null,
      reason: reg.memberId
        ? "No email or guardian email on file"
        : "No email was given at registration",
      fixMemberId: reg.memberId ?? null,
    });
  }

  return out;
}
