// B3 slice 1 — the database half of lib/eventAutoDiscounts. Who is in this
// athlete's family on this event, how many share their group value, and the
// catch-up when a group reaches its number.

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { capacityWhere } from "@/lib/eventPayments";
import { grossExpectedAmount, pricingLockReason, type PricingEvent } from "@/lib/eventRepricing";
import { registrationDiscountFields } from "@/lib/eventDiscounts";
import { writeBillingAudit } from "@/lib/billingAudit";
import {
  parseAutoDiscounts,
  siblingActive,
  groupActive,
  autoCandidates,
  groupCatchUp,
  normalizeGroupValue,
  type AppliedDiscount,
  type AutoDiscounts,
} from "@/lib/eventAutoDiscounts";

/** Registrations that count as "signed up": spot-holding rows plus requests
 *  still waiting on the coach. Declined, canceled and abandoned checkouts don't. */
function countingWhere(eventId: string, now: Date): Prisma.EventRegistrationWhereInput {
  return {
    eventId,
    AND: [
      capacityWhere(now, { holdSpotDuringReview: true }),
      { OR: [{ approvalStatus: null }, { approvalStatus: { not: "DECLINED" } }] },
    ],
  };
}

const lower = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const nameKey = (s: string | null | undefined) => lower(s).replace(/\s+/g, " ");

/** The athletes a set of logins / emails are family for: the members those
 *  users are a confirmed guardian of, plus their own member rows. */
async function familyMemberIds(clubId: string, userIds: string[], emails: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  const cleanEmails = Array.from(new Set(emails.map(lower).filter(Boolean)));
  const users = cleanEmails.length
    ? await prisma.user.findMany({
        where: { OR: cleanEmails.map((e) => ({ email: { equals: e, mode: "insensitive" as const } })) },
        select: { id: true },
      })
    : [];
  const allUsers = Array.from(new Set([...userIds.filter(Boolean), ...users.map((u) => u.id)]));
  if (allUsers.length === 0) return ids;
  const [links, own] = await Promise.all([
    prisma.memberGuardianUser.findMany({
      where: { clubId, userId: { in: allUsers }, status: "CONFIRMED" },
      select: { memberId: true },
    }),
    prisma.member.findMany({ where: { clubId, userId: { in: allUsers }, deletedAt: null }, select: { id: true } }),
  ]);
  links.forEach((l) => ids.add(l.memberId));
  own.forEach((m) => ids.add(m.id));
  return ids;
}

export type AutoDiscountContext = {
  cfg: AutoDiscounts;
  candidates: AppliedDiscount[];
  siblingPosition: number;
  /** The family's other athletes already on this event (names). */
  familyNames: string[];
  groupCount: number;
};

/**
 * What the event's automatic rules offer the registration being made now.
 * Nothing is written. `excludeRegistrationId` = the row being replaced (the
 * portal re-submitting an existing registration doesn't count as a sibling).
 */
export async function autoDiscountsForSignup(args: {
  event: { id: string; clubId: string; autoDiscounts: unknown };
  athlete: { memberId: string | null; name: string };
  emails: string[];
  userIds: string[];
  groupDisplay: string | null;
  excludeRegistrationId?: string | null;
  now?: Date;
}): Promise<AutoDiscountContext> {
  const cfg = parseAutoDiscounts(args.event.autoDiscounts);
  const empty: AutoDiscountContext = { cfg, candidates: [], siblingPosition: 1, familyNames: [], groupCount: 1 };
  const wantSibling = siblingActive(cfg);
  const wantGroup = groupActive(cfg) && !!normalizeGroupValue(args.groupDisplay);
  if (!wantSibling && !wantGroup) return empty;

  const now = args.now ?? new Date();
  const rows = await prisma.eventRegistration.findMany({
    where: {
      ...countingWhere(args.event.id, now),
      ...(args.excludeRegistrationId ? { id: { not: args.excludeRegistrationId } } : {}),
    },
    select: { id: true, name: true, memberId: true, email: true, groupValue: true, createdAt: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  // An athlete is their name on the registration. Not memberId: a public-link
  // row carries the member matched by the PARENT's email, so two siblings
  // registered that way share a memberId. Two different athletes with one
  // name in one family / one school is the accepted edge.
  const me = nameKey(args.athlete.name);
  const sameAthlete = (r: (typeof rows)[number]) => nameKey(r.name) === me;
  const athleteKey = (r: (typeof rows)[number]) => nameKey(r.name);
  const others = rows.filter((r) => !sameAthlete(r));

  let siblingPosition = 1;
  const familyNames: string[] = [];
  if (wantSibling) {
    const emailSet = new Set(args.emails.map(lower).filter(Boolean));
    const fam = await familyMemberIds(args.event.clubId, args.userIds, args.emails);
    const seen = new Set<string>();
    for (const r of others) {
      const inFamily = (r.memberId && fam.has(r.memberId)) || emailSet.has(lower(r.email));
      if (!inFamily || seen.has(athleteKey(r))) continue;
      seen.add(athleteKey(r));
      familyNames.push(r.name);
    }
    siblingPosition = seen.size + 1;
  }

  let groupCount = 1;
  if (wantGroup) {
    const key = normalizeGroupValue(args.groupDisplay);
    groupCount = new Set(others.filter((r) => normalizeGroupValue(r.groupValue) === key).map(athleteKey)).size + 1;
  }

  return {
    cfg,
    candidates: autoCandidates({ cfg, siblingPosition, groupDisplay: args.groupDisplay, groupCount }),
    siblingPosition,
    familyNames,
    groupCount,
  };
}

/**
 * A registration just joined a group. If that took the group to its number,
 * everyone already in it whose price can still change gets the rate (when it
 * beats what they have). Rows already paid or authorized are returned in
 * `owedBack` — no refund is ever issued automatically. Never throws: a failed
 * catch-up must not fail the registration that triggered it.
 */
export async function catchUpGroupRate(args: {
  event: PricingEvent & { id: string; clubId: string; name: string; autoDiscounts: unknown; variableCostEnabled?: boolean | null };
  groupDisplay: string | null;
  now?: Date;
}): Promise<{ updated: string[]; owedBack: { id: string; name: string; off: number }[] }> {
  const none = { updated: [] as string[], owedBack: [] as { id: string; name: string; off: number }[] };
  try {
    const cfg = parseAutoDiscounts(args.event.autoDiscounts);
    const key = normalizeGroupValue(args.groupDisplay);
    if (!groupActive(cfg) || !key || args.event.variableCostEnabled) return none;
    const now = args.now ?? new Date();
    const all = await prisma.eventRegistration.findMany({
      where: countingWhere(args.event.id, now),
      include: { _count: { select: { entries: { where: { status: { not: "DROPPED" } } } } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const activeCount = await prisma.eventRegistration.count({ where: { eventId: args.event.id, status: { not: "CANCELED" } } });
    const inGroup = all.filter((r) => normalizeGroupValue(r.groupValue) === key);
    const plan = groupCatchUp({
      cfg,
      displayValue: (args.groupDisplay ?? "").trim(),
      rows: inGroup.map((r) => ({
        id: r.id,
        name: r.name,
        gross: grossExpectedAmount(args.event, activeCount, { memberId: r.memberId, entryCount: Math.max(1, r._count.entries) }),
        currentOff: Number(r.discountAmount ?? 0),
        locked: !!pricingLockReason(r, now),
        source: r.discountSource ?? (r.discountCode ? "CODE" : null),
        fixed: (r.sessionIds?.length ?? 0) > 0,
      })),
    });
    const updated: string[] = [];
    for (const u of plan.update) {
      const r = inGroup.find((x) => x.id === u.id)!;
      const gross = grossExpectedAmount(args.event, activeCount, { memberId: r.memberId, entryCount: Math.max(1, r._count.entries) });
      const fields = registrationDiscountFields(u.discount, gross);
      const res = await prisma.eventRegistration.updateMany({
        where: {
          id: r.id,
          clubId: args.event.clubId,
          status: { notIn: ["PAID", "SCHEDULED", "CANCELED", "AWAITING_CASH", "AWAITING_CHECK"] },
          transactionId: null,
        },
        data: fields,
      });
      if (res.count === 0) continue;
      updated.push(r.name);
      // A saved-card consent records the amount the family agreed to; the
      // new number is lower, which the consent covers ("up to").
      await writeBillingAudit({
        clubId: args.event.clubId,
        memberId: r.memberId,
        actorUserId: null,
        action: "EVENT_REGISTRATION_DISCOUNT_SET",
        before: { registrationId: r.id, name: r.name, amountDue: r.amountDue == null ? null : Number(r.amountDue), discountLabel: r.discountLabel ?? r.discountCode ?? null },
        after: { registrationId: r.id, name: r.name, amountDue: fields.amountDue, discountLabel: fields.discountLabel, discountAmount: fields.discountAmount },
        note: `${fields.discountLabel} reached ${cfg.group!.threshold} athletes on ${args.event.name} — applied automatically. No money moved.`,
      }).catch(() => undefined);
    }
    return { updated, owedBack: plan.owedBack };
  } catch (err) {
    console.error("[eventAutoDiscounts] group catch-up failed", err);
    return none;
  }
}
