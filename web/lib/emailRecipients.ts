// Recipient resolution + household deduplication for Phase 3 sends.
//
// Given a set of selected member IDs + a HouseholdMode, resolve to the exact
// EmailSend rows we should insert. The rules are strict — plan §3A / §3E:
//
//   HOUSEHOLD (default)
//     One email per unique household address. A guardian with two athletes
//     yields ONE row. Adult members yield ONE row at their own address.
//     dedupeKey = lower(email)
//
//   PER_MEMBER
//     One email per selected member. A guardian with two athletes yields
//     TWO rows at the same guardian address, one per member. The composer
//     preview must state plainly that the same person will receive N copies.
//     dedupeKey = lower(email) + ':' + memberId
//
//   PER_ATHLETE_PRIMARY
//     One email per athlete's primary contact. Identical to PER_MEMBER for
//     rosters of adult athletes; for minors, routes to the primary guardian.
//     If a minor has two linked guardians, the primary wins. If no primary
//     is flagged, the first-linked guardian is treated as primary
//     (deterministic — orderBy createdAt asc).
//     dedupeKey = lower(email) + ':' + athleteMemberId
//
// The dedupeKey is what the M16 partial unique index enforces at insert
// time — the second insert with the same (sendBatchId, dedupeKey) tuple
// fails with a unique-violation, so a double-click / retry / job restart
// cannot silently ship a duplicate.
//
// Every EmailSend row also gets a skippedReason if it will not actually
// send (no-email, opted-out, invalid-address, duplicate-in-batch). Those
// rows are inserted with status='SKIPPED' so the pre-send review count
// matches what the receipt page shows.

import { prisma } from "@/lib/prisma";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";

// Recipient targeting mode (plan §3A + §3E). Named "HouseholdMode" for
// back-compat; conceptually this is the "who receives it" axis.
//
// HOUSEHOLD (default)             — one email per unique household address
// PER_MEMBER                      — one email per selected member (may repeat address)
// PER_ATHLETE_PRIMARY             — one email per athlete's primary contact
// ATHLETE_ONLY                    — deliver directly to the athlete's own email;
//                                   minors without their own email are SKIPPED
//                                   (deliberate — the sender chose "athlete only")
// PRIMARY_GUARDIAN                — deliver to the athlete's primary guardian.
//                                   Adults with no guardian → self.
// ALL_GUARDIANS                   — deliver to EVERY authorized guardian of the
//                                   member (multiple rows). Adults with no
//                                   guardians → self.
// PAYER                           — deliver to Member.responsiblePayerUserId's
//                                   email (falls back to guardian, then self).
// ACCOUNT_HOLDER                  — the User attached to the member row
//                                   (Member.userId). Guardian-managed minors
//                                   without their own login → guardian.
// BILLING_CONTACT                 — deliver to whoever manages the money for
//                                   this athlete: for a MINOR always a
//                                   guardian (canPay preferred, then the
//                                   family's primary), never the child's own
//                                   address; for an ADULT always themselves.
//                                   Use for invoices and payment links — a
//                                   bill must reach whoever manages the
//                                   account, not the 12-year-old who owns the
//                                   iCloud address on the member record.
export type HouseholdMode =
  | "HOUSEHOLD"
  | "PER_MEMBER"
  | "PER_ATHLETE_PRIMARY"
  | "ATHLETE_ONLY"
  | "PRIMARY_GUARDIAN"
  | "ALL_GUARDIANS"
  | "PAYER"
  | "ACCOUNT_HOLDER"
  | "BILLING_CONTACT";

export interface RecipientCandidate {
  memberId: string;
  memberFirstName: string;
  memberLastName: string;
  isMinor: boolean;
  // "delivery" = the address this recipient will actually receive at.
  deliveryEmail: string | null;
  deliveryUserId: string | null;
  // The guardian's name when routing goes to a guardian, so the composer
  // preview can label the row "guardian for <child>".
  deliveryDisplayName: string | null;
  // athleteMemberId is the ATHLETE the email is about. In HOUSEHOLD mode
  // it's null for adults and the child memberId for minors; in
  // PER_ATHLETE_PRIMARY it's always the athlete.
  athleteMemberId: string | null;
  skippedReason?: SkippedReason;
}

export interface ResolvedRecipient {
  memberId: string;
  memberFirstName: string;
  memberLastName: string;
  isMinor: boolean;
  recipientEmail: string;
  recipientUserId: string | null;
  recipientMemberId: string;   // the member this row is FOR (drives 3G history)
  recipientDisplayName: string | null;
  dedupeKey: string;
  athleteMemberId: string | null;
}

export interface SkippedRecipient {
  memberId: string;
  memberFirstName: string;
  memberLastName: string;
  reason: SkippedReason;
  attemptedEmail: string | null;
}

export type SkippedReason =
  | "NO_EMAIL"
  | "OPTED_OUT"
  | "INVALID_ADDRESS"
  | "DUPLICATE_IN_BATCH";

export interface RecipientResolution {
  send: ResolvedRecipient[];
  skipped: SkippedRecipient[];
  // For pre-send review:
  counts: {
    selectedMembers: number;
    uniqueAddresses: number;   // number of distinct DELIVERY email addresses
    willSendRows: number;      // exact number of EmailSend rows we'll insert
    noEmail: number;
    optedOut: number;
    invalidAddress: number;
    duplicateInBatch: number;
  };
}

// ── Public entry point ────────────────────────────────────────────────────

export async function resolveRecipients(args: {
  clubId: string;
  memberIds: string[];
  mode: HouseholdMode;
  // MARKETING sends respect the opt-out list; TRANSACTIONAL do not.
  respectMarketingOptOut: boolean;
}): Promise<RecipientResolution> {
  const { clubId, memberIds, mode, respectMarketingOptOut } = args;

  if (!memberIds.length) {
    return emptyResolution(0);
  }

  // Pull members + guardian relationships + guardian legacy row in one round-trip.
  const members = await prisma.member.findMany({
    where: { id: { in: memberIds }, clubId, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      isMinor: true,
      userId: true,
      guardianName: true,
      guardianEmail: true,
      // 3E PAYER mode. Populated when the club has explicitly assigned a
      // payer distinct from the account holder (see billing-admin).
      responsiblePayerUserId: true,
      guardian: { select: { email: true, firstName: true, lastName: true } },
      // The User row attached DIRECTLY to this member (account holder for
      // ACCOUNT_HOLDER mode + fallback source of member email for adults).
      user: {
        select: { id: true, email: true, firstName: true, lastName: true, deletedAt: true },
      },
      // guardianLinks is the AUTHORITATIVE guardian-of-this-member set
      // (MemberGuardianUser). Legacy Guardian row is a fallback.
      // NOTE: MemberGuardianUser has no isPrimary column today — the
      // "primary" is now a REAL column (Phase 4) — pickPrimaryGuardian
      // honors isPrimary first and keeps first-linked (createdAt asc) as the
      // deterministic tiebreak for families where nobody is flagged.
      guardianLinks: {
        where: ACTIVE_GUARDIAN_LINK,
        select: {
          userId: true,
          createdAt: true,
          isPrimary: true,
          canPay: true,
          user: {
            select: {
              id: true,
              email: true,
              firstName: true,
              lastName: true,
              deletedAt: true,
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  // Pre-fetch marketing opt-outs for the club (indexed on clubId).
  const optOuts = respectMarketingOptOut
    ? await prisma.emailOptOut.findMany({
        where: { clubId, scope: { in: ["MARKETING", "ALL"] } },
        select: { email: true },
      })
    : [];
  const optOutSet = new Set(optOuts.map((o) => o.email.trim().toLowerCase()));

  // PAYER mode needs to resolve responsiblePayerUserId → email. Batch
  // fetch across every distinct payer id so we're not N+1'ing.
  const payerIds = Array.from(
    new Set(
      members
        .map((m) => m.responsiblePayerUserId)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );
  const payerUsers = payerIds.length
    ? await prisma.user.findMany({
        where: { id: { in: payerIds }, deletedAt: null },
        select: { id: true, email: true, firstName: true, lastName: true },
      })
    : [];
  const payerById = new Map(payerUsers.map((u) => [u.id, u]));

  return resolveRecipientsPure({
    members,
    mode,
    optOutSet,
    payerById,
    selectedMemberCount: memberIds.length,
  });
}

// Pure algorithm — every candidate build, opt-out check, and dedup lives here.
// The DB-facing resolveRecipients() above is a thin adapter that fetches the
// two datasets (members + opt-outs) and calls in. Tests (and any future
// non-Prisma caller — e.g. a queue worker rehydrating a snapshot) drive this
// function directly with fixtures so the recipient rules stay verifiable
// without a database.
export function resolveRecipientsPure(args: {
  members: MemberForResolve[];
  mode: HouseholdMode;
  optOutSet: Set<string>;
  // Payer lookup for PAYER mode. Absent for legacy callers → PAYER mode
  // then falls back through the normal chain (guardian → self).
  payerById?: Map<string, { id: string; email: string; firstName: string | null; lastName: string | null }>;
  selectedMemberCount?: number;
}): RecipientResolution {
  const { members, mode, optOutSet } = args;
  const payerById = args.payerById ?? new Map();
  const selectedMemberCount = args.selectedMemberCount ?? members.length;

  // Build candidates per (member, mode). Each member can produce 0, 1, or
  // more candidate rows depending on mode.
  const candidates: RecipientCandidate[] = [];
  for (const m of members) {
    const perMember = candidatesFor(m, mode, payerById);
    candidates.push(...perMember);
  }

  // Dedup + classify.
  const seenBatchKeys = new Set<string>();
  const send: ResolvedRecipient[] = [];
  const skipped: SkippedRecipient[] = [];
  let noEmail = 0;
  let optedOutCount = 0;
  let invalid = 0;
  let duplicate = 0;

  for (const c of candidates) {
    if (c.skippedReason === "NO_EMAIL") {
      skipped.push({
        memberId: c.memberId,
        memberFirstName: c.memberFirstName,
        memberLastName: c.memberLastName,
        reason: "NO_EMAIL",
        attemptedEmail: null,
      });
      noEmail++;
      continue;
    }
    const rawEmail = (c.deliveryEmail ?? "").trim().toLowerCase();
    if (!rawEmail) {
      skipped.push({
        memberId: c.memberId,
        memberFirstName: c.memberFirstName,
        memberLastName: c.memberLastName,
        reason: "NO_EMAIL",
        attemptedEmail: null,
      });
      noEmail++;
      continue;
    }
    if (!isPlausibleEmail(rawEmail)) {
      skipped.push({
        memberId: c.memberId,
        memberFirstName: c.memberFirstName,
        memberLastName: c.memberLastName,
        reason: "INVALID_ADDRESS",
        attemptedEmail: rawEmail,
      });
      invalid++;
      continue;
    }
    if (optOutSet.has(rawEmail)) {
      skipped.push({
        memberId: c.memberId,
        memberFirstName: c.memberFirstName,
        memberLastName: c.memberLastName,
        reason: "OPTED_OUT",
        attemptedEmail: rawEmail,
      });
      optedOutCount++;
      continue;
    }
    const dedupeKey = buildDedupeKey(mode, rawEmail, c.memberId, c.athleteMemberId);
    if (seenBatchKeys.has(dedupeKey)) {
      skipped.push({
        memberId: c.memberId,
        memberFirstName: c.memberFirstName,
        memberLastName: c.memberLastName,
        reason: "DUPLICATE_IN_BATCH",
        attemptedEmail: rawEmail,
      });
      duplicate++;
      continue;
    }
    seenBatchKeys.add(dedupeKey);
    send.push({
      memberId: c.memberId,
      memberFirstName: c.memberFirstName,
      memberLastName: c.memberLastName,
      isMinor: c.isMinor,
      recipientEmail: rawEmail,
      recipientUserId: c.deliveryUserId,
      recipientMemberId: c.memberId,
      recipientDisplayName: c.deliveryDisplayName,
      dedupeKey,
      athleteMemberId: c.athleteMemberId,
    });
  }

  const uniqueAddresses = new Set(send.map((s) => s.recipientEmail)).size;

  return {
    send,
    skipped,
    counts: {
      selectedMembers: selectedMemberCount,
      uniqueAddresses,
      willSendRows: send.length,
      noEmail,
      optedOut: optedOutCount,
      invalidAddress: invalid,
      duplicateInBatch: duplicate,
    },
  };
}

function emptyResolution(selectedMembers: number): RecipientResolution {
  return {
    send: [],
    skipped: [],
    counts: {
      selectedMembers,
      uniqueAddresses: 0,
      willSendRows: 0,
      noEmail: 0,
      optedOut: 0,
      invalidAddress: 0,
      duplicateInBatch: 0,
    },
  };
}

// ── Per-member candidate build ────────────────────────────────────────────

export type MemberForResolve = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  isMinor: boolean;
  userId: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  responsiblePayerUserId?: string | null;
  user?: { id: string; email: string; firstName: string | null; lastName: string | null; deletedAt: Date | null } | null;
  guardian: { email: string; firstName: string; lastName: string } | null;
  guardianLinks: Array<{
    userId: string;
    createdAt: Date;
    // Phase 4 columns — honored by pickPrimaryGuardian / pickBillingGuardian.
    isPrimary?: boolean | null;
    canPay?: boolean | null;
    user: { id: string; email: string; firstName: string | null; lastName: string | null; deletedAt: Date | null } | null;
  }>;
};

type PayerLookup = Map<string, { id: string; email: string; firstName: string | null; lastName: string | null }>;

// Small helper — pack an unauthenticated recipient contact into the
// shape candidatesFor emits.
interface TargetContact {
  email: string | null;
  userId: string | null;
  displayName: string | null;
}

function candidatesFor(m: MemberForResolve, mode: HouseholdMode, payerById: PayerLookup): RecipientCandidate[] {
  const liveGuardianLinks = m.guardianLinks.filter((g) => g.user && !g.user.deletedAt);
  const primaryGuardian = pickPrimaryGuardian(liveGuardianLinks);
  const legacyGuardianEmail = m.guardian?.email ?? m.guardianEmail ?? null;
  const legacyGuardianName = m.guardian
    ? [m.guardian.firstName, m.guardian.lastName].join(" ").trim()
    : m.guardianName ?? null;

  const base = {
    memberId: m.id,
    memberFirstName: m.firstName,
    memberLastName: m.lastName,
    isMinor: m.isMinor,
  };

  const primaryGuardianTarget: TargetContact | null = primaryGuardian?.user
    ? {
        email: primaryGuardian.user.email,
        userId: primaryGuardian.user.id,
        displayName: guardianDisplay(primaryGuardian.user.firstName, primaryGuardian.user.lastName),
      }
    : legacyGuardianEmail
    ? { email: legacyGuardianEmail, userId: null, displayName: legacyGuardianName }
    : null;

  const selfTarget: TargetContact = {
    email: m.email ?? m.user?.email ?? null,
    userId: m.userId,
    displayName: null,
  };

  // 3E — ATHLETE_ONLY: strictly the athlete's own email. Minors without
  // their own address get SKIPPED, deliberately (sender chose the mode).
  if (mode === "ATHLETE_ONLY") {
    if (!selfTarget.email) {
      return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
    }
    return [{ ...base, deliveryEmail: selfTarget.email, deliveryUserId: selfTarget.userId, deliveryDisplayName: selfTarget.displayName, athleteMemberId: m.id }];
  }

  // 3E — PRIMARY_GUARDIAN: send to the primary guardian; fall back to
  // self for adults with no guardian. Minors with no guardian → skip.
  if (mode === "PRIMARY_GUARDIAN") {
    const t = primaryGuardianTarget ?? (m.isMinor ? null : selfTarget);
    if (!t || !t.email) {
      return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
    }
    return [{ ...base, deliveryEmail: t.email, deliveryUserId: t.userId, deliveryDisplayName: t.displayName, athleteMemberId: m.id }];
  }

  // 3E — ALL_GUARDIANS: one row per live guardian link. Adults with no
  // guardians → self.
  if (mode === "ALL_GUARDIANS") {
    if (liveGuardianLinks.length === 0) {
      if (!m.isMinor && selfTarget.email) {
        return [{ ...base, deliveryEmail: selfTarget.email, deliveryUserId: selfTarget.userId, deliveryDisplayName: selfTarget.displayName, athleteMemberId: m.id }];
      }
      // Minor with no guardian links but legacy guardianEmail present →
      // still route the legacy address so nothing is silently dropped.
      if (legacyGuardianEmail) {
        return [{ ...base, deliveryEmail: legacyGuardianEmail, deliveryUserId: null, deliveryDisplayName: legacyGuardianName, athleteMemberId: m.id }];
      }
      return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
    }
    return liveGuardianLinks.map((g) => ({
      ...base,
      deliveryEmail: g.user!.email,
      deliveryUserId: g.user!.id,
      deliveryDisplayName: guardianDisplay(g.user!.firstName, g.user!.lastName),
      athleteMemberId: m.id,
    }));
  }

  // 3E — PAYER: the responsible-payer User; fall back to primary guardian,
  // then self. This is the "send financial reminders to whoever pays"
  // shortcut.
  if (mode === "PAYER") {
    const payer = m.responsiblePayerUserId ? payerById.get(m.responsiblePayerUserId) : undefined;
    const t: TargetContact | null = payer
      ? { email: payer.email, userId: payer.id, displayName: guardianDisplay(payer.firstName, payer.lastName) }
      : primaryGuardianTarget ?? (m.isMinor ? null : selfTarget);
    if (!t || !t.email) {
      return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
    }
    return [{ ...base, deliveryEmail: t.email, deliveryUserId: t.userId, deliveryDisplayName: t.displayName, athleteMemberId: m.id }];
  }

  // 3E — ACCOUNT_HOLDER: the User attached to the member row. Guardian-
  // managed minors without a User of their own → primary guardian.
  if (mode === "ACCOUNT_HOLDER") {
    const holderEmail = m.user?.email ?? m.email ?? null;
    if (m.userId && holderEmail) {
      return [{ ...base, deliveryEmail: holderEmail, deliveryUserId: m.userId, deliveryDisplayName: m.user ? guardianDisplay(m.user.firstName, m.user.lastName) : null, athleteMemberId: m.id }];
    }
    // No direct account holder — fall back to primary guardian.
    if (primaryGuardianTarget?.email) {
      return [{ ...base, deliveryEmail: primaryGuardianTarget.email, deliveryUserId: primaryGuardianTarget.userId, deliveryDisplayName: primaryGuardianTarget.displayName, athleteMemberId: m.id }];
    }
    return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
  }

  if (mode === "HOUSEHOLD") {
    // One row per member — but the athleteMemberId stays null for adults so
    // household dedup collapses adults at one address.
    if (m.isMinor) {
      // Route to primary guardian; fall back to legacy guardianEmail.
      if (primaryGuardian?.user) {
        return [{
          ...base,
          deliveryEmail: primaryGuardian.user.email,
          deliveryUserId: primaryGuardian.user.id,
          deliveryDisplayName: guardianDisplay(primaryGuardian.user.firstName, primaryGuardian.user.lastName),
          athleteMemberId: null, // HOUSEHOLD mode ignores athlete axis
        }];
      }
      if (legacyGuardianEmail) {
        return [{
          ...base,
          deliveryEmail: legacyGuardianEmail,
          deliveryUserId: null,
          deliveryDisplayName: legacyGuardianName,
          athleteMemberId: null,
        }];
      }
      return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: null, skippedReason: "NO_EMAIL" }];
    }
    // Adult
    return [{
      ...base,
      deliveryEmail: m.email,
      deliveryUserId: m.userId,
      deliveryDisplayName: null,
      athleteMemberId: null,
    }];
  }

  if (mode === "PER_MEMBER") {
    // One row per member, address chosen the same way as HOUSEHOLD but
    // the dedup axis includes memberId — so two children at one guardian
    // address produce TWO rows.
    if (m.isMinor) {
      const target = primaryGuardian?.user
        ? { email: primaryGuardian.user.email, userId: primaryGuardian.user.id, name: guardianDisplay(primaryGuardian.user.firstName, primaryGuardian.user.lastName) }
        : legacyGuardianEmail
        ? { email: legacyGuardianEmail, userId: null, name: legacyGuardianName }
        : null;
      if (!target) return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
      return [{ ...base, deliveryEmail: target.email, deliveryUserId: target.userId, deliveryDisplayName: target.name, athleteMemberId: m.id }];
    }
    return [{ ...base, deliveryEmail: m.email, deliveryUserId: m.userId, deliveryDisplayName: null, athleteMemberId: m.id }];
  }

  // 3E — BILLING_CONTACT: the money contact for this athlete.
  //
  // A minor NEVER receives their own bill here, even when the member record
  // carries their personal address. Maximus Alexander's record has
  // maximus8910@icloud.com; his invoice belongs with Adam Alexander. Adults
  // are always billed at their own address — the guardian rule must not
  // follow an adult who manages their own account.
  if (mode === "BILLING_CONTACT") {
    if (m.isMinor) {
      const billing = pickBillingGuardian(liveGuardianLinks);
      const target = billing?.user
        ? { email: billing.user.email, userId: billing.user.id, name: guardianDisplay(billing.user.firstName, billing.user.lastName) }
        : legacyGuardianEmail
          ? { email: legacyGuardianEmail, userId: null, name: legacyGuardianName }
          : null;
      if (!target) {
        return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
      }
      return [{ ...base, deliveryEmail: target.email, deliveryUserId: target.userId, deliveryDisplayName: target.name, athleteMemberId: m.id }];
    }
    return [{ ...base, deliveryEmail: m.email ?? m.user?.email ?? null, deliveryUserId: m.userId, deliveryDisplayName: null, athleteMemberId: m.id, ...(m.email || m.user?.email ? {} : { skippedReason: "NO_EMAIL" as const }) }];
  }

  // PER_ATHLETE_PRIMARY
  // Same as PER_MEMBER — one row per athlete's primary contact — but the
  // key semantics call out the intent: even for adults, dedupe axis is the
  // athlete. Behaviorally identical to PER_MEMBER for now; kept distinct
  // so the composer preview text is honest about the sender's choice.
  if (m.isMinor) {
    const target = primaryGuardian?.user
      ? { email: primaryGuardian.user.email, userId: primaryGuardian.user.id, name: guardianDisplay(primaryGuardian.user.firstName, primaryGuardian.user.lastName) }
      : legacyGuardianEmail
      ? { email: legacyGuardianEmail, userId: null, name: legacyGuardianName }
      : null;
    if (!target) return [{ ...base, deliveryEmail: null, deliveryUserId: null, deliveryDisplayName: null, athleteMemberId: m.id, skippedReason: "NO_EMAIL" }];
    return [{ ...base, deliveryEmail: target.email, deliveryUserId: target.userId, deliveryDisplayName: target.name, athleteMemberId: m.id }];
  }
  return [{ ...base, deliveryEmail: m.email, deliveryUserId: m.userId, deliveryDisplayName: null, athleteMemberId: m.id }];
}

function pickPrimaryGuardian<
  T extends { createdAt: Date; isPrimary?: boolean | null },
>(links: T[]): T | null {
  if (!links.length) return null;
  // Phase 4 gave MemberGuardianUser a real isPrimary flag. Honor it — a
  // family that has explicitly named its primary contact must not be
  // second-guessed by link order. First-linked stays the deterministic
  // tiebreak when nobody is flagged (links arrive orderBy createdAt asc).
  return links.find((l) => l.isPrimary) ?? links[0];
}

/**
 * Who should receive a BILL for this athlete. Prefers a guardian authorized to
 * pay, then the family's designated primary, then first-linked. A guardian
 * with canPay=false can still be a valid contact, so they remain the fallback
 * rather than being dropped — a bill nobody receives is worse than a bill sent
 * to the only adult on file.
 */
function pickBillingGuardian<
  T extends { createdAt: Date; isPrimary?: boolean | null; canPay?: boolean | null },
>(links: T[]): T | null {
  if (!links.length) return null;
  const payers = links.filter((l) => l.canPay);
  return pickPrimaryGuardian(payers.length ? payers : links);
}

function guardianDisplay(first: string | null, last: string | null): string | null {
  const name = [first ?? "", last ?? ""].join(" ").trim();
  return name || null;
}

function buildDedupeKey(mode: HouseholdMode, email: string, memberId: string, athleteMemberId: string | null): string {
  switch (mode) {
    case "HOUSEHOLD":
      // Adult-only fold: for adults there's no athleteMemberId, so the
      // key IS just the email. For minors HOUSEHOLD folds guardians of
      // multiple children into one delivery — same key.
      return email;
    case "PER_MEMBER":
    case "ACCOUNT_HOLDER":
    case "PAYER":
      // One row per selected member, even if the address collapses.
      return `${email}:${memberId}`;
    case "PER_ATHLETE_PRIMARY":
    case "PRIMARY_GUARDIAN":
    case "ATHLETE_ONLY":
    case "BILLING_CONTACT":
      // One row per athlete axis. Two siblings billed to the same guardian
      // produce TWO rows — they're separate registrations owing separate
      // money, so folding them would drop one family's bill.
      return `${email}:${athleteMemberId ?? memberId}`;
    case "ALL_GUARDIANS":
      // One row per (guardian address, athlete) pair. The candidate build
      // sets deliveryUserId to the specific guardian; fold on that so
      // two guardians of one child both receive, but a guardian of two
      // children only receives once per child.
      return `${email}:${athleteMemberId ?? memberId}`;
  }
}

function isPlausibleEmail(s: string): boolean {
  // Deliberately permissive — RFC 5322 is a swamp, and Resend/SMTP will
  // do the real validation at send time. We only want to catch obvious
  // typos ("no@", "foo.bar", trailing spaces) before enqueueing.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
