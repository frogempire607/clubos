// B3 slice 2 — the database half of lib/membershipSiblingDiscount: who pays
// for whom, and each family's memberships as the rule sees them.

import { prisma } from "@/lib/prisma";
import { resolvePayerUserId } from "@/lib/familyAccess";
import { discountedPrice, type ValidDiscount } from "@/lib/discounts";
import { parseOptions } from "@/lib/membershipOptions";
import {
  parseMembershipSibling,
  planFamily,
  siblingForPurchase,
  siblingOn,
  type MembershipSiblingConfig,
  type SiblingLine,
  type SiblingSub,
} from "@/lib/membershipSiblingDiscount";

const LIVE = ["active", "past_due", "trialing"];

type MemberKeyInput = { id: string; userId: string | null; responsiblePayerUserId: string | null };

/** The primary (else earliest) CONFIRMED guardian login per member. */
async function primaryGuardians(clubId: string, memberIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (memberIds.length === 0) return out;
  const links = await prisma.memberGuardianUser.findMany({
    where: { clubId, memberId: { in: memberIds }, status: "CONFIRMED" },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { memberId: true, userId: true },
  });
  for (const l of links) if (!out.has(l.memberId)) out.set(l.memberId, l.userId);
  return out;
}

function payerKey(sub: { payerUserId: string | null } | null, m: MemberKeyInput, guardians: Map<string, string>): string | null {
  return (
    resolvePayerUserId({
      subscriptionPayerUserId: sub?.payerUserId ?? null,
      memberResponsiblePayerUserId: m.responsiblePayerUserId,
      memberUserId: m.userId,
    }) ??
    guardians.get(m.id) ??
    null
  );
}

export type Families = {
  cfg: MembershipSiblingConfig;
  /** payer key → that payer's live memberships. */
  byPayer: Map<string, SiblingSub[]>;
  /** subscription id → payer key. */
  keyOf: Map<string, string>;
};

/** Every paying family in the club. Club-sized scan, fine at club scale. */
export async function loadFamilies(clubId: string): Promise<Families> {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { siblingDiscount: true } });
  const cfg = parseMembershipSibling(club?.siblingDiscount);
  const subs = await prisma.memberSubscription.findMany({
    where: { status: { in: LIVE }, member: { clubId, deletedAt: null } },
    select: {
      id: true, memberId: true, membershipId: true, price: true, billingPeriod: true, status: true, deliberateFree: true,
      discountSource: true, discountAmount: true, discountCode: true, startDate: true, createdAt: true, payerUserId: true,
      member: { select: { id: true, firstName: true, lastName: true, userId: true, responsiblePayerUserId: true } },
    },
  });
  const guardians = await primaryGuardians(clubId, Array.from(new Set(subs.map((s) => s.memberId))));
  const byPayer = new Map<string, SiblingSub[]>();
  const keyOf = new Map<string, string>();
  for (const s of subs) {
    const key = payerKey(s, s.member, guardians);
    if (!key) continue; // no payer we can name ⇒ a family of one
    const price = Number(s.price);
    const off = s.discountAmount != null ? Number(s.discountAmount) : 0;
    const row: SiblingSub = {
      id: s.id,
      memberId: s.memberId,
      memberName: `${s.member.firstName} ${s.member.lastName ?? ""}`.trim(),
      membershipId: s.membershipId,
      listPrice: Math.round((price + (off > 0 ? off : 0)) * 100) / 100,
      price,
      billingPeriod: s.billingPeriod,
      status: s.status,
      deliberateFree: s.deliberateFree,
      discountSource: s.discountSource ?? (s.discountCode ? "CODE" : null),
      startDate: s.startDate ?? s.createdAt,
    };
    keyOf.set(s.id, key);
    byPayer.set(key, [...(byPayer.get(key) ?? []), row]);
  }
  return { cfg, byPayer, keyOf };
}

/** The family lines for one member's memberships (their siblings included). */
export async function siblingLinesForMember(clubId: string, memberId: string): Promise<{ cfg: MembershipSiblingConfig; lines: SiblingLine[]; family: SiblingLine[] }> {
  const f = await loadFamilies(clubId);
  const keys = new Set<string>();
  for (const [key, subs] of Array.from(f.byPayer.entries())) if (subs.some((s) => s.memberId === memberId)) keys.add(key);
  const family: SiblingLine[] = [];
  for (const k of Array.from(keys)) family.push(...planFamily(f.cfg, f.byPayer.get(k)!));
  return { cfg: f.cfg, lines: family.filter((l) => l.memberId === memberId), family };
}

/** Every membership whose price doesn't match the rule (Action Center). */
export async function siblingDrift(clubId: string): Promise<SiblingLine[]> {
  const f = await loadFamilies(clubId);
  const out: SiblingLine[] = [];
  for (const subs of Array.from(f.byPayer.values())) {
    if (subs.length < 2 && !subs.some((s) => s.discountSource === "SIBLING")) continue;
    out.push(...planFamily(f.cfg, subs).filter((l) => l.drift));
  }
  return out;
}

/**
 * The sibling discount a purchase being made NOW earns. The payer is resolved
 * the same way a stored membership's is (so what checkout gives is what the
 * panel later agrees with): responsible payer → own login → primary guardian.
 */
export async function siblingForNewMembership(args: {
  clubId: string;
  member: MemberKeyInput & { firstName?: string; lastName?: string | null };
  membershipId: string;
  listPrice: number;
  billingPeriod: string | null;
  excludeSubscriptionId?: string | null;
}): Promise<{ rule: { type: "PERCENT" | "FIXED"; value: number } | null; label: string | null; position: number | null; off: number }> {
  const none = { rule: null, label: null, position: null, off: 0 };
  const f = await loadFamilies(args.clubId);
  if (!siblingOn(f.cfg)) return none;
  const guardians = await primaryGuardians(args.clubId, [args.member.id]);
  const key = payerKey(null, args.member, guardians);
  if (!key) return none;
  const family = (f.byPayer.get(key) ?? []).filter((s) => s.id !== args.excludeSubscriptionId);
  return siblingForPurchase(f.cfg, family, {
    memberId: args.member.id,
    memberName: `${args.member.firstName ?? ""} ${args.member.lastName ?? ""}`.trim(),
    membershipId: args.membershipId,
    listPrice: args.listPrice,
    billingPeriod: args.billingPeriod,
    startDate: new Date(),
  });
}

export type PurchaseDiscount = {
  finalPrice: number;
  /** The typed code — only when it won (so only then is a use recorded). */
  code: ValidDiscount | null;
  /** Columns for the MemberSubscription row. */
  fields: {
    discountCode: string | null;
    discountAmount: number | null;
    discountSource: string | null;
    discountLabel: string | null;
    discountType: string | null;
    discountValue: number | null;
  };
  /** "Sibling membership discount (2nd athlete)" or "code SUMMER10", for descriptions. */
  label: string | null;
};

/**
 * The one discount a membership purchase gets: a typed code or the sibling
 * discount, whichever saves more (a tie goes to the sibling discount, so a
 * code isn't burned for nothing). Every purchase path calls this.
 */
export async function membershipDiscountAtPurchase(args: {
  clubId: string;
  memberId: string;
  membershipId: string;
  listPrice: number;
  billingPeriod: string | null;
  code: ValidDiscount | null;
  excludeSubscriptionId?: string | null;
}): Promise<PurchaseDiscount> {
  const list = Math.round(args.listPrice * 100) / 100;
  const codeNet = args.code ? discountedPrice(list, args.code) : list;
  const codeOff = Math.round((list - codeNet) * 100) / 100;
  const member = await prisma.member.findUnique({
    where: { id: args.memberId },
    select: { id: true, userId: true, responsiblePayerUserId: true, firstName: true, lastName: true },
  });
  const sib =
    member && args.billingPeriod !== "ONE_TIME"
      ? await siblingForNewMembership({
          clubId: args.clubId, member, membershipId: args.membershipId, listPrice: list,
          billingPeriod: args.billingPeriod, excludeSubscriptionId: args.excludeSubscriptionId,
        })
      : { rule: null, label: null, position: null, off: 0 };
  if (sib.rule && sib.off > 0 && sib.off >= codeOff) {
    return {
      finalPrice: Math.round((list - sib.off) * 100) / 100,
      code: null,
      fields: {
        discountCode: null, discountAmount: sib.off, discountSource: "SIBLING", discountLabel: sib.label,
        discountType: sib.rule.type, discountValue: sib.rule.value,
      },
      label: sib.label,
    };
  }
  if (args.code && codeOff > 0) {
    return {
      finalPrice: codeNet,
      code: args.code,
      fields: {
        discountCode: args.code.code, discountAmount: codeOff, discountSource: "CODE", discountLabel: args.code.code,
        discountType: args.code.type, discountValue: Number(args.code.value),
      },
      label: `code ${args.code.code}`,
    };
  }
  return {
    finalPrice: list,
    code: args.code, // a 0-off code still "applied" the way it always did
    fields: {
      discountCode: args.code?.code ?? null, discountAmount: null, discountSource: args.code ? "CODE" : null,
      discountLabel: args.code?.code ?? null, discountType: null, discountValue: null,
    },
    label: args.code ? `code ${args.code.code}` : null,
  };
}

/**
 * The sibling discount a Change plan carries onto its new price: the family's
 * rule applied to the TARGET option, with this membership taken out of the
 * family and re-ranked as the replacement. Null when it earns nothing. The
 * owner sees it in the preview line before confirming.
 */
export async function siblingDiscountForPlanChange(input: {
  clubId: string;
  memberId: string;
  subscriptionId: string;
  optionId: string;
}): Promise<{ source: "SIBLING"; type: "PERCENT" | "FIXED"; value: number; label: string } | null> {
  const plans = await prisma.membership.findMany({ where: { clubId: input.clubId, deletedAt: null }, select: { id: true, options: true } });
  let hit: { planId: string; price: number; billingPeriod: string } | null = null;
  for (const p of plans) {
    const o = parseOptions(p.options).find((x) => x.id === input.optionId);
    if (o) { hit = { planId: p.id, price: o.price, billingPeriod: o.billingPeriod }; break; }
  }
  if (!hit || hit.price <= 0 || hit.billingPeriod === "ONE_TIME") return null;
  const member = await prisma.member.findFirst({
    where: { id: input.memberId, clubId: input.clubId },
    select: { id: true, userId: true, responsiblePayerUserId: true, firstName: true, lastName: true },
  });
  if (!member) return null;
  const sib = await siblingForNewMembership({
    clubId: input.clubId, member, membershipId: hit.planId, listPrice: hit.price,
    billingPeriod: hit.billingPeriod, excludeSubscriptionId: input.subscriptionId,
  });
  return sib.rule && sib.label && sib.off > 0 ? { source: "SIBLING", type: sib.rule.type, value: sib.rule.value, label: sib.label } : null;
}

/**
 * The portal's preview: for each athlete a family can buy for, what each
 * option would cost with the sibling discount. One family scan for the page.
 * Keys are `${membershipId}:${optionLabel}`; only discounted options appear.
 */
export async function siblingQuotes(
  clubId: string,
  memberIds: string[],
  items: { membershipId: string; optionLabel: string; price: number; billingPeriod: string }[],
): Promise<Record<string, Record<string, { label: string; price: number }>>> {
  const out: Record<string, Record<string, { label: string; price: number }>> = {};
  if (memberIds.length === 0 || items.length === 0) return out;
  const f = await loadFamilies(clubId);
  if (!siblingOn(f.cfg)) return out;
  const [members, guardians] = await Promise.all([
    prisma.member.findMany({
      where: { id: { in: memberIds }, clubId },
      select: { id: true, userId: true, responsiblePayerUserId: true, firstName: true, lastName: true },
    }),
    primaryGuardians(clubId, memberIds),
  ]);
  for (const m of members) {
    const key = payerKey(null, m, guardians);
    if (!key) continue;
    const family = f.byPayer.get(key) ?? [];
    for (const it of items) {
      if (it.billingPeriod === "ONE_TIME" || it.price <= 0) continue;
      const q = siblingForPurchase(f.cfg, family, {
        memberId: m.id, memberName: `${m.firstName} ${m.lastName ?? ""}`.trim(), membershipId: it.membershipId,
        listPrice: it.price, billingPeriod: it.billingPeriod, startDate: new Date(),
      });
      if (q.rule && q.label && q.off > 0) {
        (out[m.id] ||= {})[`${it.membershipId}:${it.optionLabel}`] = { label: q.label, price: Math.round((it.price - q.off) * 100) / 100 };
      }
    }
  }
  return out;
}
