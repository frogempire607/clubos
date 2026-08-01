// Personalization token interpolation (plan §3F).
//
// Tokens supported (verbatim from plan §3F):
//   member_first_name         member's first name
//   athlete_first_name        athlete the send is FOR (same as member for adults;
//                             the actual child for guardian-received minor sends)
//   guardian_first_name       primary guardian's first name
//   membership_name           name of the athlete's active membership
//   membership_end_date       date the athlete's membership expires
//   outstanding_balance       athlete's unpaid balance across all sources
//   event_name                context-supplied event (from send call site)
//   class_name                context-supplied class
//   coach_name                context-supplied coach
//   club_name                 the sending club
//   club_contact_information  one-line phone / email string
//   registration_link         context-supplied URL
//   payment_link              context-supplied URL
//   migration_link            per-recipient migration URL (via activationToken)
//
// Missing tokens: interpolation leaves them blank (never leaks a raw
// {{token}} to the recipient) but marks them in the return value's
// `missingTokens` set so the composer can warn pre-send. This is the
// "warn when a personalization field is unavailable for some
// recipients" guarantee from plan §3F.
//
// Cross-family safety: every token resolves against a SPECIFIC recipient
// context. Iterating members and re-resolving per row is the caller's
// job (see /api/emails/personalization-preview). Never bulk-render a
// single interpolated body with mixed contexts — plan §3F: "Never
// expose another family's information through incorrect personalization."

import { prisma } from "@/lib/prisma";
import type { EmailBlock, InlineRun } from "@/lib/emailBlocks";
import { getEmailBaseUrl } from "@/lib/baseUrl";

export const PERSONALIZATION_TOKENS = [
  "member_first_name",
  "athlete_first_name",
  "guardian_first_name",
  "membership_name",
  "membership_end_date",
  "outstanding_balance",
  "event_name",
  "class_name",
  "coach_name",
  "club_name",
  "club_contact_information",
  "registration_link",
  "payment_link",
  "migration_link",
] as const;
export type PersonalizationToken = (typeof PERSONALIZATION_TOKENS)[number];

export interface PersonalizationContext {
  // Owner-supplied context for the whole send. Any of these override
  // the per-member auto-resolution when set (e.g. "the event is X" for
  // a campaign about one specific event).
  eventName?: string | null;
  className?: string | null;
  coachName?: string | null;
  registrationLink?: string | null;
  paymentLink?: string | null;
  // Additional owner-typed key/value overrides — applied last, wins over
  // both context + auto-resolved. Advanced use.
  overrides?: Record<string, string | null | undefined>;
}

export interface PersonalizationValues {
  values: Partial<Record<PersonalizationToken, string>>;
  missingTokens: PersonalizationToken[];
}

// Substitutes {{token}} occurrences in a string. Unknown tokens are left
// as-is so a typo doesn't silently drop content — but see `interpolateBlocks`
// which normalizes typos to blank and records them as missing.
export function interpolateString(s: string, values: Partial<Record<string, string>>): string {
  return s.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, name: string) => {
    if (Object.prototype.hasOwnProperty.call(values, name)) {
      return values[name] ?? "";
    }
    // Unknown token — remove braces so recipients never see "{{foo}}"
    // in a rendered email. Recorded upstream via missingTokens.
    return "";
  });
}

// Walk an EmailBlock[] and interpolate every user-visible string field.
// Also collects the set of tokens the body actually references so the
// composer can highlight which ones apply to this template.
export function interpolateBlocks(blocks: EmailBlock[], values: Partial<Record<string, string>>): EmailBlock[] {
  return blocks.map((b) => interpolateBlock(b, values));
}

function interpolateBlock(b: EmailBlock, values: Partial<Record<string, string>>): EmailBlock {
  switch (b.type) {
    case "heading": return { ...b, text: interpolateString(b.text, values) };
    case "paragraph": return { ...b, runs: interpolateRuns(b.runs, values) };
    case "list": return { ...b, items: b.items.map((runs) => interpolateRuns(runs, values)) };
    case "button": return { ...b, text: interpolateString(b.text, values), href: interpolateString(b.href, values) };
    case "image": return { ...b, alt: interpolateString(b.alt, values), src: interpolateString(b.src, values), href: b.href ? interpolateString(b.href, values) : b.href };
    case "divider":
    case "spacer":
    case "contact":
    case "logo":
      return b;
  }
}

function interpolateRuns(runs: InlineRun[], values: Partial<Record<string, string>>): InlineRun[] {
  return runs.map((r) => {
    if (r.kind === "link") return { ...r, text: interpolateString(r.text, values), href: interpolateString(r.href, values) };
    return { ...r, text: interpolateString(r.text, values) };
  });
}

// Extract every {{token}} the body references. Used by the composer to
// tell the sender WHICH tokens might be blank for some recipients.
export function extractTokensFromBlocks(blocks: EmailBlock[]): string[] {
  const seen = new Set<string>();
  const collect = (s: string | undefined | null) => {
    if (!s) return;
    for (const m of s.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) seen.add(m[1]);
  };
  for (const b of blocks) {
    switch (b.type) {
      case "heading": collect(b.text); break;
      case "paragraph": b.runs.forEach((r) => { collect(r.text); if (r.kind === "link") collect(r.href); }); break;
      case "list": b.items.forEach((runs) => runs.forEach((r) => { collect(r.text); if (r.kind === "link") collect(r.href); })); break;
      case "button": collect(b.text); collect(b.href); break;
      case "image": collect(b.alt); collect(b.src); if (b.href) collect(b.href); break;
      case "divider": case "spacer": case "contact": case "logo": break;
    }
  }
  return Array.from(seen);
}

// Resolves every token for ONE recipient member. Fetches minimal fields
// only. Missing tokens are the ones the body references that we could
// not resolve.
export async function resolveMemberPersonalization(args: {
  clubId: string;
  memberId: string;
  referencedTokens: string[];
  context?: PersonalizationContext;
}): Promise<PersonalizationValues> {
  const { clubId, memberId, referencedTokens, context } = args;

  // Bail early when the body references nothing.
  if (referencedTokens.length === 0) {
    return { values: {}, missingTokens: [] };
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    select: {
      id: true,
      firstName: true, lastName: true,
      isMinor: true,
      activationToken: true,
      guardianName: true, guardianEmail: true,
      guardianLinks: {
        select: {
          userId: true,
          createdAt: true,
          user: { select: { firstName: true, lastName: true } },
        },
        orderBy: { createdAt: "asc" },
      },
      subscriptions: {
        where: { status: { in: ["active", "past_due", "trialing"] } },
        select: { membership: { select: { name: true } }, endDate: true },
        orderBy: { createdAt: "desc" },
      },
      membership: { select: { name: true } },
    },
  });

  if (!member) return { values: {}, missingTokens: referencedTokens as PersonalizationToken[] };

  const club = await prisma.club.findUnique({
    where: { id: clubId },
    select: {
      name: true,
      publicEmail: true, contactEmail: true,
      publicPhone: true, contactPhone: true,
    },
  });

  const primaryGuardianUser = member.guardianLinks[0]?.user ?? null;
  const guardianFirstName = primaryGuardianUser?.firstName?.trim() ||
    (member.guardianName ? member.guardianName.trim().split(/\s+/)[0] : null);

  const membership = member.subscriptions[0]?.membership?.name ?? member.membership?.name ?? null;
  const membershipEnd = member.subscriptions[0]?.endDate ?? null;

  const outstanding = await outstandingBalance(clubId, member.id);

  const contactEmail = club?.publicEmail ?? club?.contactEmail ?? null;
  const contactPhone = club?.publicPhone ?? club?.contactPhone ?? null;
  const contactInfo = [contactEmail, contactPhone].filter(Boolean).join(" · ") || null;

  const migrationLink = member.activationToken
    ? `${getEmailBaseUrl()}/activate/${member.activationToken}`
    : null;

  // Auto-resolved values.
  const auto: Partial<Record<PersonalizationToken, string | null>> = {
    member_first_name: member.firstName || null,
    athlete_first_name: member.firstName || null,
    guardian_first_name: guardianFirstName,
    membership_name: membership,
    membership_end_date: membershipEnd ? membershipEnd.toISOString().slice(0, 10) : null,
    outstanding_balance: outstanding != null ? formatMoney(outstanding) : null,
    event_name: context?.eventName ?? null,
    class_name: context?.className ?? null,
    coach_name: context?.coachName ?? null,
    club_name: club?.name ?? null,
    club_contact_information: contactInfo,
    registration_link: context?.registrationLink ?? null,
    payment_link: context?.paymentLink ?? null,
    migration_link: migrationLink,
  };

  // Apply owner overrides (win over auto).
  if (context?.overrides) {
    for (const [k, v] of Object.entries(context.overrides)) {
      if (PERSONALIZATION_TOKENS.includes(k as PersonalizationToken)) {
        auto[k as PersonalizationToken] = v ?? null;
      }
    }
  }

  const values: Partial<Record<PersonalizationToken, string>> = {};
  const missing: PersonalizationToken[] = [];
  for (const t of referencedTokens) {
    if (!PERSONALIZATION_TOKENS.includes(t as PersonalizationToken)) {
      missing.push(t as PersonalizationToken); // unknown token → missing
      continue;
    }
    const v = auto[t as PersonalizationToken];
    if (v == null || v === "") missing.push(t as PersonalizationToken);
    else values[t as PersonalizationToken] = v;
  }

  return { values, missingTokens: missing };
}

// Outstanding balance = SUM(Transaction.amount WHERE status=PENDING or
// past-due invoice sub) minus known-refunded. Cheap approximation for
// the reminder token — an accurate ledger is a Phase-5 concern.
async function outstandingBalance(clubId: string, memberId: string): Promise<number | null> {
  const rows = await prisma.transaction.findMany({
    where: {
      clubId,
      memberId,
      status: "PENDING",
      reconciliationStatus: { not: "VOID" },
    },
    select: { amount: true, refundedAmount: true },
  });
  if (rows.length === 0) return 0;
  const sum = rows.reduce((acc, r) => {
    const amt = Number(r.amount ?? 0);
    const refunded = Number(r.refundedAmount ?? 0);
    return acc + amt - refunded;
  }, 0);
  return Math.max(0, sum);
}

function formatMoney(n: number): string {
  return `$${n.toFixed(2)}`;
}
