// Seed the Hall-shaped family for browser-testing Phase 7.1 (family view).
//
//   DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/clubos \
//   DIRECT_URL=$DATABASE_URL npx tsx scripts/seed-hall-family-test.ts
//
// Shape mirrors production: one guardian login, TWO minor athletes with
// CONFIRMED guardian links and active subscriptions on the same plan, and an
// upcoming class both are eligible for. This is the case where booking the
// second child appeared to erase the first.
//
// LOCAL ONLY — refuses to run against anything but port 55432.

import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes(":55432")) {
  console.error("Refusing to run: DATABASE_URL is not the local test database on port 55432.");
  process.exit(1);
}

const prisma = new PrismaClient();

const CLUB = "club_hall_test";
const GUARDIAN_EMAIL = "shannan@local.test";
const PASSWORD = "localtest123";

async function main() {
  const club = await prisma.club.upsert({
    where: { id: CLUB },
    update: { timezone: "America/New_York" },
    create: {
      id: CLUB,
      name: "Frog Empire Wrestling Academy",
      slug: "frog-empire-hall",
      timezone: "America/New_York",
    },
  });

  const guardian = await prisma.user.upsert({
    where: { clubId_email: { clubId: club.id, email: GUARDIAN_EMAIL } },
    update: { passwordHash: await bcrypt.hash(PASSWORD, 10), deletedAt: null },
    create: {
      id: "u_shannan",
      clubId: club.id,
      email: GUARDIAN_EMAIL,
      passwordHash: await bcrypt.hash(PASSWORD, 10),
      firstName: "Shannan",
      lastName: "Hall",
      role: "MEMBER",
    },
  });

  const plan = await prisma.membership.upsert({
    where: { id: "mem_mshs" },
    update: {},
    create: {
      id: "mem_mshs",
      clubId: club.id,
      name: "MS/HS Wrestling",
      options: [{ label: "1 Year", price: 1500, billingPeriod: "YEARLY" }],
    },
  });

  // Two minors, same guardian — the whole point of the test.
  const kids = [
    { id: "m_titus", firstName: "Titus", price: 1500, label: "1 Year" },
    { id: "m_max", firstName: "Max", price: 175, label: "Monthly Full" },
  ];

  for (const kid of kids) {
    await prisma.member.upsert({
      where: { id: kid.id },
      update: { deletedAt: null, status: "ACTIVE" },
      create: {
        id: kid.id,
        clubId: club.id,
        firstName: kid.firstName,
        lastName: "Hall",
        isMinor: true,
        status: "ACTIVE",
        guardianName: "Shannan Hall",
        guardianEmail: GUARDIAN_EMAIL,
        membershipId: plan.id,
      },
    });

    // The authorization edge. Without a CONFIRMED row the portal shows nothing.
    await prisma.memberGuardianUser.upsert({
      where: { userId_memberId: { userId: guardian.id, memberId: kid.id } },
      update: { status: "CONFIRMED" },
      create: {
        clubId: club.id,
        userId: guardian.id,
        memberId: kid.id,
        status: "CONFIRMED",
        relationship: "Parent",
        isPrimary: kid.id === "m_titus",
        source: "STAFF_LINKED",
      },
    });

    await prisma.memberSubscription.upsert({
      where: { id: `sub_${kid.id}` },
      update: { status: "active" },
      create: {
        id: `sub_${kid.id}`,
        memberId: kid.id,
        membershipId: plan.id,
        optionLabel: kid.label,
        price: kid.price,
        billingPeriod: "YEARLY",
        billingType: "MANUAL",
        status: "active",
        startedAt: new Date(),
      },
    });
  }

  // A class both kids' plan covers, tomorrow at 7pm. Class stamps are the
  // owner's wall clock pinned to UTC (see lib/datetime.ts).
  const cls = await prisma.recurringClass.upsert({
    where: { id: "rc_mshs" },
    update: {},
    create: {
      id: "rc_mshs",
      clubId: club.id,
      name: "MS/HS Preseason",
      daysOfWeek: [1, 2, 3, 4, 5],
      recurrenceStartDate: new Date(),
      startTime: "19:00",
      endTime: "20:30",
      capacity: 40,
      active: true,
      visibility: "MEMBERS_ONLY",
      pricingOptions: [{ type: "membership", membershipId: plan.id }],
      assignedStaffIds: [],
    },
  });

  const tomorrow = new Date();
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const day = tomorrow.toISOString().slice(0, 10);
  await prisma.classSession.upsert({
    where: { id: "cs_hall_tomorrow" },
    update: {
      startsAt: new Date(`${day}T19:00:00Z`),
      endsAt: new Date(`${day}T20:30:00Z`),
      date: new Date(`${day}T00:00:00Z`),
      canceled: false,
    },
    create: {
      id: "cs_hall_tomorrow",
      classId: cls.id,
      clubId: club.id,
      date: new Date(`${day}T00:00:00Z`),
      startsAt: new Date(`${day}T19:00:00Z`),
      endsAt: new Date(`${day}T20:30:00Z`),
    },
  });

  // Start from a clean slate so the test observes real booking transitions.
  await prisma.attendanceRecord.deleteMany({
    where: { classSessionId: "cs_hall_tomorrow", memberId: { in: kids.map((k) => k.id) } },
  });

  console.log(`Seeded. Club slug: ${club.slug}`);
  console.log(`Guardian: ${GUARDIAN_EMAIL} / ${PASSWORD}`);
  console.log(`Children: Titus (m_titus), Max (m_max) — both ACTIVE on ${plan.name}`);
  console.log(`Class session cs_hall_tomorrow at ${day} 19:00 (club wall clock)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
