// Local-only fixture seed for BROWSER TESTING the bulk price change screen.
// Never run against production — refuses anything that is not localhost.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//     npx tsx scripts/seed-price-change-browser-test.ts
//
// Reproduces the shapes that actually exist on Frog Empire's MS/HS plan, which
// are the ones the screen has to survive:
//
//   - optionLabel drift: rows labeled "MS/HS" (the PLAN name, written by the
//     migration/approve path) sitting alongside rows labeled "Monthly", on the
//     same plan at the same price. Selecting on the label would miss them.
//   - per-member overrides ($5 and $0) that must never be pre-ticked.
//   - offline upfront rows with NO currentPeriodEnd, NO endDate, and a
//     billingAnchorDate already in the past — the case where the credit
//     genuinely cannot be computed.
//   - one upfront row WITH a future period end, so the computable branch is
//     exercised too.
//
// Nothing here has a Stripe id: the local harness has no Stripe account, and a
// fake `sub_...` would make apply attempt a real API call. Stripe-side apply is
// verified by the route's read-back logic and its unit tests, not here.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
if (!/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error("REFUSING: DATABASE_URL is not localhost. This seed is local-only.");
  process.exit(1);
}

const prisma = new PrismaClient();
const day = 86_400_000;
const ago = (n: number) => new Date(Date.now() - n * day);
const ahead = (n: number) => new Date(Date.now() + n * day);

const MSHS_OPTIONS = JSON.stringify([
  { label: "Monthly", price: 190, billingPeriod: "MONTHLY" },
  { label: "Upfront", price: 530, billingPeriod: "QUARTERLY" },
  { label: "1 Year", price: 2000, billingPeriod: "ANNUAL" },
]);

async function main() {
  const clubId = "club_local";
  await prisma.club.upsert({
    where: { id: clubId },
    update: { passProcessingFees: true },
    create: {
      id: clubId, name: "Frog Empire Wrestling", slug: "frog-empire", tier: "growth",
      // Matches production: the club passes the 2.9% through, so the Stripe
      // unit_amount is price + fee and the member email must say so.
      passProcessingFees: true,
      primaryColor: "#B31b1b",
    },
  });

  const hash = await bcrypt.hash("localtest123", 10);
  await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "owner@local.test" } },
    update: { passwordHash: hash, role: "OWNER" },
    create: {
      clubId, email: "owner@local.test", passwordHash: hash,
      firstName: "Dana", lastName: "Rivera", role: "OWNER",
    },
  });

  // A STAFF user with billing:full — used to prove the owner-only gate holds
  // against exactly the person Julian named (Sal has billing:full and must not
  // be able to reprice the club's whole book of business).
  await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "sal@local.test" } },
    update: { passwordHash: hash, role: "STAFF" },
    create: {
      clubId, email: "sal@local.test", passwordHash: hash,
      firstName: "Sal", lastName: "Ortiz", role: "STAFF",
      staffProfile: {
        create: {
          permissions: { members: "full", billing: "full", finances: "full", events: "full" },
        },
      },
    },
  });

  const plan = await prisma.membership.upsert({
    where: { id: "mship_mshs" },
    update: { options: MSHS_OPTIONS },
    create: {
      id: "mship_mshs", clubId, name: "MS/HS",
      description: "Middle and high school", options: MSHS_OPTIONS, active: true,
    },
  });

  type Spec = {
    id: string; first: string; price: number; optionLabel: string;
    billingPeriod: string; billingType: string;
    currentPeriodEnd?: Date | null; endDate?: Date | null; billingAnchorDate?: Date | null;
  };

  const specs: Spec[] = [
    // ── Monthly: the bulk. Label drift + overrides. ───────────────────────
    { id: "sub_ann",  first: "Ann",  price: 190, optionLabel: "Monthly", billingPeriod: "MONTHLY", billingType: "RECURRING" },
    { id: "sub_ben",  first: "Ben",  price: 190, optionLabel: "MS/HS",   billingPeriod: "MONTHLY", billingType: "MANUAL" },
    { id: "sub_cara", first: "Cara", price: 190, optionLabel: "MS/HS",   billingPeriod: "MONTHLY", billingType: "MANUAL" },
    { id: "sub_dev",  first: "Dev",  price: 190, optionLabel: "Monthly", billingPeriod: "MONTHLY", billingType: "RECURRING" },
    // Overrides — listed, never pre-ticked.
    { id: "sub_eli",  first: "Eli",  price: 5,   optionLabel: "Monthly", billingPeriod: "MONTHLY", billingType: "RECURRING" },
    { id: "sub_fern", first: "Fern", price: 0,   optionLabel: "MS/HS",   billingPeriod: "MONTHLY", billingType: "MANUAL" },
    // Already at the target price — must report "already at this price".
    { id: "sub_gus",  first: "Gus",  price: 175, optionLabel: "Monthly", billingPeriod: "MONTHLY", billingType: "RECURRING" },

    // ── Quarterly upfront: the credit cases. ──────────────────────────────
    // Computable — a real future period end.
    { id: "sub_hana", first: "Hana", price: 530, optionLabel: "Upfront", billingPeriod: "QUARTERLY", billingType: "MANUAL",
      currentPeriodEnd: ahead(45) },
    // The production case: nothing usable. Anchor already past.
    { id: "sub_ivan", first: "Ivan", price: 530, optionLabel: "MS/HS",   billingPeriod: "QUARTERLY", billingType: "MANUAL",
      billingAnchorDate: ago(27) },
  ];

  for (const s of specs) {
    const memberId = `mem_${s.id}`;
    await prisma.member.upsert({
      where: { id: memberId },
      update: {},
      create: {
        id: memberId, clubId, firstName: s.first, lastName: "Testerson",
        email: `${s.first.toLowerCase()}@local.test`, status: "ACTIVE",
        membershipId: plan.id, joinedAt: ago(120),
      },
    });
    await prisma.memberSubscription.upsert({
      where: { id: s.id },
      update: {
        price: s.price, optionLabel: s.optionLabel, billingPeriod: s.billingPeriod,
        billingType: s.billingType, status: "active",
        currentPeriodEnd: s.currentPeriodEnd ?? null,
        endDate: s.endDate ?? null,
        billingAnchorDate: s.billingAnchorDate ?? null,
      },
      create: {
        id: s.id, memberId, membershipId: plan.id,
        optionLabel: s.optionLabel, price: s.price, billingPeriod: s.billingPeriod,
        billingType: s.billingType, status: "active", autoRenew: true,
        startDate: ago(120),
        currentPeriodEnd: s.currentPeriodEnd ?? null,
        endDate: s.endDate ?? null,
        billingAnchorDate: s.billingAnchorDate ?? null,
      },
    });
    // A CREATED lifecycle event per subscription — mirrors what BF-B
    // guarantees in production, so the reliability gate starts at COMPLETE and
    // a regression that lets PRICE_CHANGE satisfy coverage is visible.
    const existing = await prisma.memberSubscriptionEvent.count({
      where: { memberSubscriptionId: s.id, kind: "CREATED" },
    });
    if (existing === 0) {
      await prisma.memberSubscriptionEvent.create({
        data: {
          clubId, memberSubscriptionId: s.id, memberId, kind: "CREATED",
          at: ago(120), toPlan: "MS/HS", toAmount: String(s.price), source: "SYSTEM",
        },
      });
    }
  }

  console.log(`Seeded ${specs.length} subscriptions on MS/HS.`);
  console.log("  owner@local.test / localtest123   (OWNER)");
  console.log("  sal@local.test   / localtest123   (STAFF, billing:full — must be refused)");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
