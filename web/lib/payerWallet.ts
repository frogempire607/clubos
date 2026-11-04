// Cards belong to PEOPLE, not athletes — 2026-11-03.
//
// History. 2026-10-29: Jason Reynolds (a coach) pays for eight athletes and
// his card was saved once, on Owen Burhans; Stripe customers had always been
// per ATHLETE, so nobody else could use it. The first fix grouped cards by
// "who pays for the athlete" — and when Thaeden McGuinness (whose MOM's card
// was on file) was added to "Paid by Jason", her card showed up on every one
// of Jason's athletes. Julian: "if other parents join I don't want them to mix
// cards up."
//
// So now a saved card (a Stripe customer) has an OWNER — a person:
//   · stamped on the Stripe customer as metadata.aoxOwnerUserId whenever we
//     create a customer, save a card to someone's wallet, or use a card;
//   · for older, unstamped customers, inferred from the athlete it's on
//     (legacyCardOwner): a minor's card is their family guardian's (never a
//     coach-labelled link), else whoever pays; an adult's is their own.
// An athlete is offered only the cards of the people who pay for them
// (payersFor): "Paid by" (memberships), their family guardians, and their own
// login. Jason's card shows on Jason's team; Thaeden's mom's card shows only
// on her own kids.
//
// Two athletes may share ONE customer safely: every subscription we create
// carries memberId metadata and money resolves by subscription id → metadata,
// never by customer.

import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";
import { isCoachRelationship } from "@/lib/membershipSiblingDiscount";

export const OWNER_META = "aoxOwnerUserId";

export type LinkInput = { userId: string; relationship: string | null };
export type AthleteInput = { isMinor: boolean; userId: string | null; responsiblePayerUserId: string | null };

/** PURE. The customer an athlete's on-file card lives on. */
export const customerOf = (m: { stripeSetupCustomerId: string | null; stripeCustomerId: string | null }) =>
  m.stripeSetupCustomerId ?? m.stripeCustomerId ?? null;

/** PURE. Whose card an UNSTAMPED customer on this athlete most likely is. `links` primary first. */
export function legacyCardOwner(m: AthleteInput, links: LinkInput[]): string | null {
  const primaryFamily = links.find((l) => !isCoachRelationship(l.relationship))?.userId ?? null;
  if (m.isMinor) return primaryFamily ?? m.responsiblePayerUserId ?? links[0]?.userId ?? m.userId ?? null;
  return m.userId ?? primaryFamily ?? m.responsiblePayerUserId ?? null;
}

export type PayerRole = "MEMBERSHIPS" | "GUARDIAN" | "SELF";
export type Payer = { userId: string; roles: PayerRole[] };

/** PURE. The people whose cards may be used for this athlete: Paid by, family guardians, own login. */
export function payersFor(m: AthleteInput, links: LinkInput[]): Payer[] {
  const out = new Map<string, PayerRole[]>();
  const add = (id: string | null, role: PayerRole) => {
    if (!id) return;
    const r = out.get(id) ?? [];
    if (!r.includes(role)) r.push(role);
    out.set(id, r);
  };
  add(m.responsiblePayerUserId, "MEMBERSHIPS");
  for (const l of links) if (!isCoachRelationship(l.relationship)) add(l.userId, "GUARDIAN");
  add(m.userId, "SELF");
  return Array.from(out.entries()).map(([userId, roles]) => ({ userId, roles }));
}

/** PURE. One owner for a customer: the stamp, else the owner most of the athletes on it agree on. */
export function ownerOfCustomer(stamped: string | null, legacyOwners: (string | null)[]): string | null {
  if (stamped) return stamped;
  const tally = new Map<string, number>();
  for (const o of legacyOwners) if (o) tally.set(o, (tally.get(o) ?? 0) + 1);
  let best: string | null = null; let n = 0;
  for (const [o, c] of Array.from(tally.entries())) if (c > n) { best = o; n = c; }
  return best;
}

export type WalletCustomer = { customerId: string; athletes: { id: string; name: string }[] };
export type Wallet = { ownerUserId: string; ownerName: string; roles: PayerRole[]; customers: WalletCustomer[] };
export type Wallets = {
  /** This athlete's on-file customer (events, privates, store…), and whose it is. */
  onFile: { customerId: string; ownerUserId: string | null } | null;
  /** One per person who pays for this athlete, in payersFor order. */
  wallets: Wallet[];
};

const MEMBER_SELECT = {
  id: true, firstName: true, lastName: true, isMinor: true, userId: true, responsiblePayerUserId: true,
  stripeSetupCustomerId: true, stripeCustomerId: true,
} as const;

async function linksOf(clubId: string, memberIds: string[]): Promise<Map<string, LinkInput[]>> {
  const out = new Map<string, LinkInput[]>();
  if (memberIds.length === 0) return out;
  const rows = await prisma.memberGuardianUser.findMany({
    where: { clubId, memberId: { in: memberIds }, status: "CONFIRMED" },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { memberId: true, userId: true, relationship: true },
  });
  for (const r of rows) {
    const l = out.get(r.memberId) ?? [];
    l.push({ userId: r.userId, relationship: r.relationship });
    out.set(r.memberId, l);
  }
  return out;
}

/** The stamped owner of a Stripe customer, or null (unstamped / unreadable). */
async function stampedOwner(customerId: string, stripeAccount: string): Promise<string | null> {
  try {
    const c = await stripe.customers.retrieve(customerId, { stripeAccount });
    if (!c || ("deleted" in c && c.deleted)) return null;
    const v = (c as { metadata?: Record<string, string> }).metadata?.[OWNER_META];
    return v || null;
  } catch {
    return null;
  }
}

/** Stamp a customer with its owner if it isn't stamped yet. Never overwrites a different owner. Best-effort. */
export async function stampOwner(customerId: string, ownerUserId: string, stripeAccount: string): Promise<void> {
  try {
    const cur = await stampedOwner(customerId, stripeAccount);
    if (cur) return;
    await stripe.customers.update(customerId, { metadata: { [OWNER_META]: ownerUserId } }, { stripeAccount });
  } catch (e) {
    console.error("payerWallet: owner stamp failed", customerId, e);
  }
}

/** Everyone who pays for this athlete, each with the Stripe customers that hold THEIR cards. */
export async function walletsFor(clubId: string, memberId: string, stripeAccount: string): Promise<Wallets | null> {
  const target = await prisma.member.findFirst({ where: { id: memberId, clubId, deletedAt: null }, select: MEMBER_SELECT });
  if (!target) return null;
  const tLinks = (await linksOf(clubId, [target.id])).get(target.id) ?? [];
  const payers = payersFor(target, tLinks);
  const payerIds = payers.map((p) => p.userId);
  const ownCustomer = customerOf(target);

  // Every athlete those people pay for or look after — where their cards live.
  const related = payerIds.length
    ? await prisma.member.findMany({
        where: {
          clubId, deletedAt: null, id: { not: target.id },
          OR: [
            { responsiblePayerUserId: { in: payerIds } },
            { userId: { in: payerIds } },
            { guardianLinks: { some: { userId: { in: payerIds }, status: "CONFIRMED" } } },
          ],
        },
        select: MEMBER_SELECT,
        take: 200,
      })
    : [];
  const all = [target, ...related];
  const links = await linksOf(clubId, related.map((r) => r.id));
  links.set(target.id, tLinks);

  const byCustomer = new Map<string, { athletes: { id: string; name: string }[]; legacy: (string | null)[] }>();
  for (const m of all) {
    const c = customerOf(m);
    if (!c) continue;
    const e = byCustomer.get(c) ?? { athletes: [], legacy: [] };
    e.athletes.push({ id: m.id, name: `${m.firstName} ${m.lastName}`.trim() });
    e.legacy.push(legacyCardOwner(m, links.get(m.id) ?? []));
    byCustomer.set(c, e);
  }
  const ownerByCustomer = new Map<string, string | null>();
  for (const [c, e] of Array.from(byCustomer.entries())) {
    ownerByCustomer.set(c, ownerOfCustomer(await stampedOwner(c, stripeAccount), e.legacy));
  }

  const users = payerIds.length
    ? await prisma.user.findMany({ where: { id: { in: payerIds }, clubId }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
  const wallets: Wallet[] = payers
    .filter((p) => nameOf.has(p.userId))
    .map((p) => ({
      ownerUserId: p.userId,
      ownerName: nameOf.get(p.userId)!,
      roles: p.roles,
      customers: Array.from(byCustomer.entries())
        .filter(([c]) => ownerByCustomer.get(c) === p.userId)
        .map(([customerId, e]) => ({ customerId, athletes: e.athletes.filter((a) => a.id !== target.id) }))
        // The customer most athletes already share first: where a new card goes.
        .sort((a, b) => b.athletes.length - a.athletes.length),
    }));
  return {
    onFile: ownCustomer ? { customerId: ownCustomer, ownerUserId: ownerByCustomer.get(ownCustomer) ?? null } : null,
    wallets,
  };
}
