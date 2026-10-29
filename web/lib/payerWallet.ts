// The payer's wallet — 2026-10-29.
//
// Julian: "when I add a card under one sibling or for one guardian it should
// be an option to be used for every child under their umbrella" — and the
// case that forced it: Jason Reynolds (a coach) pays for eight athletes, and
// his card was saved once, on Owen Burhans.
//
// Stripe customers have always been per ATHLETE (Member.stripeSetupCustomerId),
// so a card saved on Owen lived on Owen's customer and nobody else could use
// it. No schema change fixes that: a Stripe customer can hold any number of
// subscriptions, every subscription we create carries memberId /
// memberSubscriptionId metadata, and the webhook resolves money by
// subscription id then metadata — never by customer. So two athletes can
// safely point at ONE customer. The wallet is simply "the Stripe customers
// already on file for the other athletes this same person pays for".
//
// The umbrella (who pays for an athlete), in order:
//   1. Member.responsiblePayerUserId — "Paid by", set by staff (a parent, or a
//      coach who isn't family at all);
//   2. a minor: the primary CONFIRMED guardian, else their own login;
//   3. an adult: their own login, else the primary guardian.

import { prisma } from "@/lib/prisma";

export type UmbrellaInput = {
  responsiblePayerUserId: string | null;
  userId: string | null;
  isMinor: boolean;
  primaryGuardianUserId: string | null;
};

/** PURE. Who pays for this athlete, or null when nobody can be named. */
export function umbrellaPayer(m: UmbrellaInput): string | null {
  if (m.responsiblePayerUserId) return m.responsiblePayerUserId;
  if (m.isMinor) return m.primaryGuardianUserId ?? m.userId ?? null;
  return m.userId ?? m.primaryGuardianUserId ?? null;
}

/** PURE. The customer an athlete's saved cards live on. */
export const customerOf = (m: { stripeSetupCustomerId: string | null; stripeCustomerId: string | null }) =>
  m.stripeSetupCustomerId ?? m.stripeCustomerId ?? null;

export type WalletSource = { customerId: string; members: { id: string; name: string }[] };

/** PURE. Group the payer's other athletes by the customer their cards live on; the target's own customer is not a "source". */
export function walletSources(
  targetCustomerId: string | null,
  others: { id: string; name: string; customerId: string | null }[],
): { sources: WalletSource[]; sharedWith: { id: string; name: string }[] } {
  const by = new Map<string, WalletSource>();
  const sharedWith: { id: string; name: string }[] = [];
  for (const o of others) {
    if (!o.customerId) continue;
    if (targetCustomerId && o.customerId === targetCustomerId) { sharedWith.push({ id: o.id, name: o.name }); continue; }
    const s = by.get(o.customerId) ?? { customerId: o.customerId, members: [] };
    s.members.push({ id: o.id, name: o.name });
    by.set(o.customerId, s);
  }
  // Most-shared customer first: that's the wallet a new card should join.
  const sources = Array.from(by.values()).sort((a, b) => b.members.length - a.members.length);
  return { sources, sharedWith };
}

async function primaryGuardiansOf(clubId: string, memberIds: string[]): Promise<Map<string, string>> {
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

const MEMBER_SELECT = {
  id: true, firstName: true, lastName: true, isMinor: true, userId: true, responsiblePayerUserId: true,
  stripeSetupCustomerId: true, stripeCustomerId: true,
} as const;

export type FamilyWallet = {
  payerUserId: string | null;
  payerName: string | null;
  /** Other customers holding this payer's cards (each with the athletes on it). */
  sources: WalletSource[];
  /** Athletes already sharing THIS athlete's customer. */
  sharedWith: { id: string; name: string }[];
};

/** The payer's wallet as seen from one athlete. */
export async function familyWallet(clubId: string, memberId: string): Promise<FamilyWallet | null> {
  const target = await prisma.member.findFirst({ where: { id: memberId, clubId, deletedAt: null }, select: MEMBER_SELECT });
  if (!target) return null;
  const g = await primaryGuardiansOf(clubId, [target.id]);
  const payer = umbrellaPayer({ ...target, primaryGuardianUserId: g.get(target.id) ?? null });
  if (!payer) return { payerUserId: null, payerName: null, sources: [], sharedWith: [] };

  const candidates = await prisma.member.findMany({
    where: {
      clubId, deletedAt: null, id: { not: target.id },
      OR: [
        { responsiblePayerUserId: payer },
        { userId: payer },
        { guardianLinks: { some: { userId: payer, status: "CONFIRMED" } } },
      ],
    },
    select: MEMBER_SELECT,
  });
  const cg = await primaryGuardiansOf(clubId, candidates.map((c) => c.id));
  const mine = candidates.filter((c) => umbrellaPayer({ ...c, primaryGuardianUserId: cg.get(c.id) ?? null }) === payer);
  const u = await prisma.user.findFirst({ where: { id: payer, clubId }, select: { firstName: true, lastName: true } });
  const { sources, sharedWith } = walletSources(
    customerOf(target),
    mine.map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName}`.trim(), customerId: customerOf(c) })),
  );
  return { payerUserId: payer, payerName: u ? `${u.firstName} ${u.lastName}`.trim() : null, sources, sharedWith };
}
