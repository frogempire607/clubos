// Reproduces the two live bugs from 2026-08-14 in the local throwaway DB:
//
//   1. TIMEZONE — a 7:00 PM class stored wall-clock-UTC (19:00Z) that the
//      booking cutoff compares against a true instant.
//   2. SIBLINGS — one guardian, two children, both on the accepted plan,
//      trying to book the same session.
//
// Mirrors production: club timezone America/New_York, class startTime 19:00.
//   npx tsx scripts/seed-sibling-timezone-test.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CLUB = "club_local";

function assertLocalDb() {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("55432")) {
    throw new Error("Refusing to run outside the local throwaway Postgres (port 55432).");
  }
}

/** A wall-clock-UTC stamp: "HH:MM today" pinned to UTC, the ClassSession convention. */
function wallClockToday(hh: number, mm: number, dayOffset = 0): Date {
  const d = new Date();
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + dayOffset, hh, mm, 0, 0));
  return day;
}

async function main() {
  assertLocalDb();

  // Production has America/New_York. Without it the graced fallback (now-12h)
  // hides the display bug behind a very wide window.
  await prisma.club.update({ where: { id: CLUB }, data: { timezone: "America/New_York" } });

  const mshs = await prisma.membership.findFirst({ where: { clubId: CLUB, name: "MS/HS" } });
  if (!mshs) throw new Error("MS/HS membership missing — run seed-local-browser-test.ts first");

  // Both siblings hold the accepted plan, so booking takes the free
  // membership-covered path and the test isolates the sibling logic from Stripe.
  for (const memberId of ["m_sibling", "m_import_unreviewed"]) {
    const existing = await prisma.memberSubscription.findFirst({
      where: { memberId, membershipId: mshs.id, status: "active" },
    });
    if (!existing) {
      await prisma.memberSubscription.create({
        data: {
          memberId,
          membershipId: mshs.id,
          status: "active",
          price: 190,
          optionLabel: "Monthly",
          billingPeriod: "MONTHLY",
          billingType: "MANUAL",
          startDate: new Date(),
        },
      });
    }
    await prisma.member.update({ where: { id: memberId }, data: { status: "ACTIVE" } });
  }

  const cls = await prisma.recurringClass.upsert({
    where: { id: "rc_mshs_preseason" },
    update: {
      startTime: "19:00",
      endTime: "20:30",
      visibility: "MEMBERS_ONLY",
      pricingOptions: [{ type: "membership", membershipId: mshs.id }] as never,
    },
    create: {
      id: "rc_mshs_preseason",
      clubId: CLUB,
      name: "MS/HS Preseason",
      daysOfWeek: [1, 2, 3, 4, 5] as never,
      recurrenceStartDate: new Date(Date.now() - 30 * 86_400_000),
      startTime: "19:00",
      endTime: "20:30",
      visibility: "MEMBERS_ONLY",
      capacity: 40,
      pricingOptions: [{ type: "membership", membershipId: mshs.id }] as never,
    },
  });

  // Sessions today and tomorrow, both stored as wall clock pinned to UTC —
  // exactly what lib/classSessions.ts writes (setUTCHours).
  for (const [i, id] of [[0, "cs_mshs_today"], [1, "cs_mshs_tomorrow"]] as const) {
    await prisma.classSession.upsert({
      where: { id },
      update: { startsAt: wallClockToday(19, 0, i), endsAt: wallClockToday(20, 30, i), canceled: false },
      create: {
        id,
        clubId: CLUB,
        classId: cls.id,
        date: wallClockToday(0, 0, i),
        startsAt: wallClockToday(19, 0, i),
        endsAt: wallClockToday(20, 30, i),
        canceled: false,
      },
    });
    // Clear prior attendance so the run is repeatable.
    await prisma.attendanceRecord.deleteMany({ where: { classSessionId: id } });
  }

  // A deterministic repro of bug 1 regardless of what time the test runs:
  // a session ONE HOUR IN THE FUTURE in club-local time. Its wall-clock-UTC
  // stamp is already behind real UTC now, so a cutoff that compares the two
  // directly calls a class that hasn't started "already started".
  const nowLocalParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const localHour = Number(nowLocalParts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  // +3h so the class is unambiguously in the future in club-local terms even
  // if the browser run lands several minutes after the seed.
  const soonHour = (localHour + 3) % 24;
  await prisma.classSession.upsert({
    where: { id: "cs_mshs_soon" },
    update: { startsAt: wallClockToday(soonHour, 0), endsAt: wallClockToday(soonHour + 1, 0), canceled: false },
    create: {
      id: "cs_mshs_soon",
      clubId: CLUB,
      classId: cls.id,
      date: wallClockToday(0, 0),
      startsAt: wallClockToday(soonHour, 0),
      endsAt: wallClockToday(soonHour + 1, 0),
      canceled: false,
    },
  });
  await prisma.attendanceRecord.deleteMany({ where: { classSessionId: "cs_mshs_soon" } });

  const now = new Date();
  console.log("club timezone: America/New_York");
  console.log(
    `deterministic session: starts ${soonHour}:00 club-local (one hour out), stored ${wallClockToday(soonHour, 0).toISOString()}`,
  );
  console.log("  raw cutoff calls it started:", wallClockToday(soonHour, 0) < now);
  console.log("class stored startsAt (today):", wallClockToday(19, 0).toISOString(), "= displays 7:00 PM");
  console.log("real now (UTC):", now.toISOString());
  console.log("club-local now:", now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  console.log("raw cutoff `startsAt < new Date()` says started:", wallClockToday(19, 0) < now);
  console.log("\nGuardian michael@local.test / localtest123 — children Rory + Cameron Lister");
}

main().finally(() => prisma.$disconnect());
