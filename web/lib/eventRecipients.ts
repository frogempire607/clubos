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
// Precedence (owner decision, 2026-08-04):
//
//   MINOR    → ALWAYS the guardian, even when the member record carries the
//              athlete's own address. A bill must reach whoever manages the
//              account. Maximus Alexander's record has maximus8910@icloud.com
//              and his invoice belongs with Adam Alexander; Drayke Ulrich's
//              belongs with Christina Ulrich, not dtulrich6@gmail.com. The
//              registration snapshot is only a fallback for a minor with no
//              guardian on file at all.
//   ADULT    → ALWAYS themselves. The guardian rule must not follow a member
//              who manages their own account.
//   NO MEMBER→ the registration snapshot is the only address that exists
//              (public/walk-up registrants).
//
// This replaced an earlier "snapshot always wins" rule. That rule kept mail
// flowing to the address a prior invoice used, but it meant a minor with a
// personal email on file was billed directly — which is what the owner hit.

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
 * Uses BILLING_CONTACT: one address per athlete, routed to the guardian who
 * manages the money when they're a minor (canPay preferred, then the family's
 * designated primary, then first-linked), to themselves when they're an adult.
 * Every other mode either collapses siblings into one send (HOUSEHOLD) or
 * fans out to every guardian (ALL_GUARDIANS) — two payment links for one
 * registration invites two payments and a refund.
 *
 * Transactional: `respectMarketingOptOut` is false. A parent who opted out of
 * marketing still gets the bill for a camp they signed their kid up for.
 */
export async function resolveRegistrationRecipients(
  clubId: string,
  registrations: RegistrationForRecipient[],
): Promise<Map<string, RegistrationRecipient>> {
  const out = new Map<string, RegistrationRecipient>();

  // EVERY member-linked registration is resolved through the family model —
  // not just the ones with a blank snapshot. The snapshot can be the athlete's
  // own address, and for a minor that is precisely the address a bill must
  // not go to.
  const memberIds = [...new Set(registrations.map((r) => r.memberId).filter(Boolean) as string[])];

  const byMember = new Map<string, { email: string; displayName: string | null }>();
  if (memberIds.length > 0) {
    const resolution = await resolveRecipients({
      clubId,
      memberIds,
      mode: "BILLING_CONTACT",
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
    // The family model wins for anyone with a member record: it routes a
    // minor to their guardian and an adult to themselves.
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

    // No member record (public/walk-up), or a member the family model can't
    // route — the address captured at registration is all there is.
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

// ── Phase 5 §5.2.5 — who gets told about a registration's lifecycle ─────────
//
// Deliberately a DIFFERENT question from the one above. `resolveRegistrationRecipients`
// answers "where does the BILL go" and returns exactly one address per
// registration, because two payment links for one registration invites two
// payments and a refund. A lifecycle notice ("your coach approved", "your coach
// proposed a change", "we couldn't approve this") is not a bill: every adult
// who manages this athlete should see it, and none of them can act twice on it.
//
// So this returns the registrant's own address PLUS every confirmed guardian.
// Each address becomes its own EmailSend row, and the (sendBatchId, dedupeKey,
// recipientEmail) tuple is what stops a replay from re-sending — which is why
// addresses are normalized to lowercase and deduped here rather than at the
// call site.

export type LifecycleRecipient = {
  email: string;
  displayName: string | null;
  userId: string | null;
  memberId: string | null;
};

export async function resolveRegistrationNotifyRecipients(
  clubId: string,
  reg: RegistrationForRecipient,
): Promise<LifecycleRecipient[]> {
  const byEmail = new Map<string, LifecycleRecipient>();
  const add = (r: LifecycleRecipient) => {
    const email = plausible(r.email);
    if (!email) return;
    const key = email.toLowerCase();
    // First writer wins: a guardian resolved through the family model carries a
    // display name, and we'd rather keep that than overwrite it with the bare
    // snapshot address for the same person.
    if (!byEmail.has(key)) byEmail.set(key, { ...r, email: key });
  };

  if (reg.memberId) {
    try {
      const resolution = await resolveRecipients({
        clubId,
        memberIds: [reg.memberId],
        mode: "ALL_GUARDIANS",
        respectMarketingOptOut: false,
      });
      for (const r of resolution.send) {
        add({
          email: r.recipientEmail,
          displayName: r.recipientDisplayName,
          userId: r.recipientUserId,
          memberId: r.athleteMemberId ?? r.recipientMemberId ?? reg.memberId ?? null,
        });
      }
    } catch (e) {
      // Degrading to the registration snapshot is the pre-Phase-5 behavior —
      // worse, but not wrong. Failing the whole approval because a guardian
      // lookup broke would be.
      console.error("[eventRecipients] lifecycle guardian lookup failed", e);
    }
  }

  // The address captured at registration always counts: for a public/walk-up
  // registrant it is the only one that exists, and for a member it is the one
  // they typed into this specific form.
  add({ email: reg.email ?? "", displayName: reg.name ?? null, userId: null, memberId: reg.memberId ?? null });

  return [...byEmail.values()];
}
