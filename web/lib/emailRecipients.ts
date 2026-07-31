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

export type HouseholdMode = "HOUSEHOLD" | "PER_MEMBER" | "PER_ATHLETE_PRIMARY";

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
    return {
      send: [],
      skipped: [],
      counts: { selectedMembers: 0, uniqueAddresses: 0, willSendRows: 0, noEmail: 0, optedOut: 0, invalidAddress: 0, duplicateInBatch: 0 },
    };
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
      guardian: { select: { email: true, firstName: true, lastName: true } },
      // guardianLinks is the AUTHORITATIVE guardian-of-this-member set
      // (MemberGuardianUser). Legacy Guardian row is a fallback.
      // NOTE: MemberGuardianUser has no isPrimary column today — the
      // "primary" concept is derived (first-linked wins, deterministic by
      // createdAt asc). Phase 4.5 (M25) adds a real status/permission
      // grid; when that lands, update pickPrimaryGuardian() to honor it.
      guardianLinks: {
        select: {
          userId: true,
          createdAt: true,
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

  // Build candidates per (member, mode). Each member can produce 0, 1, or
  // more candidate rows depending on mode.
  const candidates: RecipientCandidate[] = [];
  for (const m of members) {
    const perMember = candidatesFor(m, mode);
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
      selectedMembers: memberIds.length,
      uniqueAddresses,
      willSendRows: send.length,
      noEmail,
      optedOut: optedOutCount,
      invalidAddress: invalid,
      duplicateInBatch: duplicate,
    },
  };
}

// ── Per-member candidate build ────────────────────────────────────────────

type MemberForResolve = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  isMinor: boolean;
  userId: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardian: { email: string; firstName: string; lastName: string } | null;
  guardianLinks: Array<{
    userId: string;
    createdAt: Date;
    user: { id: string; email: string; firstName: string | null; lastName: string | null; deletedAt: Date | null } | null;
  }>;
};

function candidatesFor(m: MemberForResolve, mode: HouseholdMode): RecipientCandidate[] {
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
  T extends { createdAt: Date },
>(links: T[]): T | null {
  if (!links.length) return null;
  // Deterministic: first-linked wins (already orderBy createdAt asc).
  // Phase 4.5 (M25) will add a real per-link status/flag we can honor here.
  return links[0];
}

function guardianDisplay(first: string | null, last: string | null): string | null {
  const name = [first ?? "", last ?? ""].join(" ").trim();
  return name || null;
}

function buildDedupeKey(mode: HouseholdMode, email: string, memberId: string, athleteMemberId: string | null): string {
  switch (mode) {
    case "HOUSEHOLD":
      return email;
    case "PER_MEMBER":
      return `${email}:${memberId}`;
    case "PER_ATHLETE_PRIMARY":
      return `${email}:${athleteMemberId ?? memberId}`;
  }
}

function isPlausibleEmail(s: string): boolean {
  // Deliberately permissive — RFC 5322 is a swamp, and Resend/SMTP will
  // do the real validation at send time. We only want to catch obvious
  // typos ("no@", "foo.bar", trailing spaces) before enqueueing.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}
