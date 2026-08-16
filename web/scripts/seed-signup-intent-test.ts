// Seed for browser-testing Phase 7.2/7.3 (signup intent + trial attachment).
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//   DIRECT_URL=$DATABASE_URL npx tsx scripts/seed-signup-intent-test.ts
//
// Shape: a club with an ACTIVE free-trial offer, plus ONE minor already on the
// roster carrying the parent's address in `guardianEmail` — a CSV-imported
// older sibling with no account behind them. That sibling is what the vouched
// sweep must find the moment the parent's account exists, and it is the "we
// found 1 athlete already listed under your email" line on arrival.
//
// LOCAL ONLY — refuses to run against anything but port 55432.

import { PrismaClient } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes(":55432")) {
  console.error("Refusing to run: DATABASE_URL is not the local test database on port 55432.");
  process.exit(1);
}

const prisma = new PrismaClient();

const CLUB = "club_signup_intent";
const SLUG = "frog-empire-signup";
export const PARENT_EMAIL = "dad@local.test";

async function main() {
  const club = await prisma.club.upsert({
    where: { id: CLUB },
    update: {
      freeTrialConfig: { name: "First Week Free", days: 7, membershipIds: [], renewable: true, allowRepeatUse: false, active: true },
    },
    create: {
      id: CLUB,
      name: "Frog Empire Wrestling Academy",
      slug: SLUG,
      timezone: "America/New_York",
      freeTrialConfig: { name: "First Week Free", days: 7, membershipIds: [], renewable: true, allowRepeatUse: false, active: true },
    },
  });

  // Wipe anything a previous run of the browser test created, so the run is
  // repeatable. Order matters — links before members before users.
  const stale = await prisma.member.findMany({
    where: { clubId: club.id },
    select: { id: true },
  });
  await prisma.memberGuardianUser.deleteMany({ where: { memberId: { in: stale.map((s) => s.id) } } });
  await prisma.parentalConsent.deleteMany({ where: { clubId: club.id } });
  await prisma.guardianConsentRequest.deleteMany({ where: { clubId: club.id } });
  await prisma.documentSignature.deleteMany({ where: { memberId: { in: stale.map((s) => s.id) } } });
  await prisma.member.deleteMany({ where: { clubId: club.id } });
  await prisma.guardian.deleteMany({ where: { clubId: club.id } });
  await prisma.legalAcceptance.deleteMany({ where: { clubId: club.id } });
  await prisma.user.deleteMany({ where: { clubId: club.id } });

  // The already-imported older sibling. No login, no guardian link — exactly
  // the 227-member backlog shape, scaled to one.
  await prisma.member.create({
    data: {
      id: "m_older_sibling",
      clubId: club.id,
      firstName: "Marcus",
      lastName: "Dorn",
      isMinor: true,
      status: "PROSPECT",
      migrationStatus: "IMPORTED",
      dateOfBirth: new Date("2011-04-02"),
      guardianName: "Adam Dorn",
      guardianEmail: PARENT_EMAIL,
    },
  });

  console.log(`Seeded club ${SLUG} (${club.id})`);
  console.log(`  free trial: First Week Free, 7 days, ACTIVE`);
  console.log(`  roster: Marcus Dorn (minor, guardianEmail=${PARENT_EMAIL}, no account, no link)`);
  console.log(`  no user exists for ${PARENT_EMAIL} yet — the browser test creates it`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
