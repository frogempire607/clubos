// Fixtures for the deliberate-free (comp) control in the billing centre.
//
//   Fern  — $0 RECURRING, already marked deliberateFree → reads Active
//   Gus   — $0 RECURRING, NOT marked                    → reads Inactive
//   Hana  — $0 MANUAL (cash)                            → counts either way
//   Ivan  — $175 RECURRING with a payment               → control must refuse
//
// Local throwaway Postgres only.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const clubId = "club_local";
const ago = (d: number) => new Date(Date.now() - d * 86400_000);

async function main() {
  if (!process.env.DATABASE_URL?.includes("55432")) {
    throw new Error("Refusing to run outside the local throwaway Postgres (port 55432).");
  }

  const plan = await prisma.membership.findFirst({ where: { clubId }, select: { id: true, name: true } });
  if (!plan) throw new Error("No membership plan seeded — run seed-local-browser-test.ts first.");

  const people: Array<{
    id: string; first: string; price: number; billingType: string; deliberateFree: boolean; paid: boolean;
  }> = [
    { id: "m_comp_fern", first: "Fern", price: 0, billingType: "RECURRING", deliberateFree: true, paid: false },
    { id: "m_comp_gus", first: "Gus", price: 0, billingType: "RECURRING", deliberateFree: false, paid: false },
    { id: "m_comp_hana", first: "Hana", price: 0, billingType: "MANUAL", deliberateFree: false, paid: false },
    { id: "m_comp_ivan", first: "Ivan", price: 175, billingType: "RECURRING", deliberateFree: false, paid: true },
  ];

  for (const p of people) {
    await prisma.memberSubscription.deleteMany({ where: { memberId: p.id } });
    await prisma.transaction.deleteMany({ where: { memberId: p.id } });
    await prisma.member.deleteMany({ where: { id: p.id } });

    await prisma.member.create({
      data: {
        id: p.id, clubId, firstName: p.first, lastName: "Comptest",
        status: "ACTIVE", email: `${p.first.toLowerCase()}.comp@local.test`,
        joinedAt: ago(120), membershipId: plan.id,
      },
    });
    await prisma.memberSubscription.create({
      data: {
        id: `${p.id}_sub`, memberId: p.id, membershipId: plan.id,
        optionLabel: "MS/HS", price: p.price, billingPeriod: "MONTHLY",
        billingType: p.billingType, status: "active", startDate: ago(120),
        deliberateFree: p.deliberateFree,
        stripeSubscriptionId: p.billingType === "RECURRING" && p.price > 0 ? `sub_fake_${p.id}` : null,
      },
    });
    if (p.paid) {
      await prisma.transaction.create({
        data: {
          clubId, memberId: p.id, amount: p.price, type: "MEMBERSHIP",
          status: "SUCCEEDED", reconciliationStatus: "VERIFIED",
          description: "Monthly membership", createdAt: ago(20),
        },
      });
    }
    console.log(`${p.first}: $${p.price} ${p.billingType} deliberateFree=${p.deliberateFree} paid=${p.paid} → /dashboard/members/${p.id}/billing`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
