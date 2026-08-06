// Local-only fixture seed for BROWSER TESTING. Never run against production.
//
// The sandbox cannot reach the real database, so sessions 1 and 2 shipped
// UI that had only ever been server-rendered in a test harness. This seeds a
// throwaway local Postgres with the member shapes that actually matter, so the
// screens can be clicked.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//     npx tsx scripts/seed-local-browser-test.ts
//
// Refuses to run against anything that is not localhost.

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

async function main() {
  const clubId = "club_local";
  await prisma.club.upsert({
    where: { id: clubId },
    update: {},
    create: { id: clubId, name: "Frog Empire Wrestling", slug: "frog-empire", tier: "growth" },
  });

  const hash = await bcrypt.hash("localtest123", 10);
  const owner = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "owner@local.test" } },
    update: { passwordHash: hash },
    create: { clubId, email: "owner@local.test", passwordHash: hash, firstName: "Dana", lastName: "Rivera", role: "OWNER" },
  });

  // A guardian who holds the family account — the Lister shape.
  const guardian = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "michael@local.test" } },
    update: {},
    create: {
      clubId,
      email: "michael@local.test",
      passwordHash: hash,
      firstName: "Michael",
      lastName: "Lister",
      role: "MEMBER",
      lastLoginAt: ago(2),
    },
  });

  const membership = await prisma.membership.upsert({
    where: { id: "mem_comp" },
    update: {},
    create: {
      id: "mem_comp",
      clubId,
      name: "Competition Team",
      options: [{ label: "Monthly", price: 175, billingPeriod: "MONTHLY" }],
    },
  });

  const batch = await prisma.importBatch.upsert({
    where: { id: "batch_local" },
    update: {},
    create: {
      id: "batch_local",
      clubId,
      kind: "MEMBERS",
      status: "COMPLETED",
      sourceLabel: "Acme Gym Software",
      fileName: "roster.csv",
      fileHash: "deadbeef",
      rowCount: 40,
    },
  });

  await prisma.member.deleteMany({ where: { clubId } });

  type Spec = Parameters<typeof prisma.member.create>[0]["data"];
  const specs: Spec[] = [];

  // ── The states the roster has to render ────────────────────────────────
  // 1. Active paying member, own login
  specs.push({
    id: "m_active", clubId, firstName: "Sasha", lastName: "Okonkwo", status: "ACTIVE",
    userId: owner.id === "" ? undefined : undefined, email: "sasha@local.test", joinedAt: ago(400),
  });
  // 2. Imported, unreviewed — step 1, waiting on you
  specs.push({
    id: "m_import_unreviewed", clubId, firstName: "Cameron", lastName: "Lister", status: "PROSPECT",
    isMinor: true, dateOfBirth: new Date("2012-03-01"), guardianName: "Michael Lister",
    guardianEmail: "michael@local.test", migrationStatus: "IMPORTED", importedAt: ago(30),
    importBatchId: batch.id, legacyMemberId: "607329885", legacyMembershipName: "Competition Team",
    legacyMembershipPrice: 175, joinedAt: ago(30),
  });
  // 3. Imported + reviewed, never invited — step 2
  specs.push({
    id: "m_reviewed", clubId, firstName: "Priya", lastName: "Raman", status: "PROSPECT",
    email: "priya@local.test", migrationStatus: "IMPORTED", importedAt: ago(28), importBatchId: batch.id,
    reviewedAt: ago(5), reviewedByUserId: owner.id, legacyMembershipName: "Competition Team", joinedAt: ago(28),
  });
  // 4. Invited, no response — waiting on member
  specs.push({
    id: "m_invited", clubId, firstName: "Diego", lastName: "Marquez", status: "PROSPECT",
    email: "diego@local.test", migrationStatus: "INVITED", importedAt: ago(28), importBatchId: batch.id,
    reviewedAt: ago(6), activationEmailSentAt: ago(4), activationEmailSendCount: 1, joinedAt: ago(28),
  });
  // 5. Blocked — bounced
  specs.push({
    id: "m_blocked", clubId, firstName: "Tomas", lastName: "Bergstrom", status: "PROSPECT",
    email: "bounce@local.test", migrationStatus: "INVITED", importedAt: ago(28), importBatchId: batch.id,
    reviewedAt: ago(6), activationEmailSentAt: ago(3), activationEmailSendCount: 3,
    blockedReason: "EMAIL_BOUNCED", joinedAt: ago(28),
  });
  // 6. Activated, awaiting owner's yes — step 6, billing-gated action
  specs.push({
    id: "m_awaiting", clubId, firstName: "Nia", lastName: "Fitzgerald", status: "PROSPECT",
    email: "nia@local.test", migrationStatus: "ACTIVATED", importedAt: ago(25), importBatchId: batch.id,
    reviewedAt: ago(7), activationEmailSentAt: ago(6), activatedAt: ago(1),
    approvalStatus: "PENDING_APPROVAL", joinedAt: ago(25),
  });
  // 7. Snoozed
  specs.push({
    id: "m_snoozed", clubId, firstName: "Rowan", lastName: "Patel", status: "PROSPECT",
    email: "rowan@local.test", migrationStatus: "IMPORTED", importedAt: ago(20), importBatchId: batch.id,
    snoozedUntil: new Date(Date.now() + 5 * day), joinedAt: ago(20),
  });
  // 8. PROSPECT under the J-10 split — trialled, never joined
  specs.push({
    id: "m_prospect", clubId, firstName: "Wei", lastName: "Zhang", status: "PROSPECT",
    email: "wei@local.test", trialEndsAt: ago(10), joinedAt: ago(15),
  });
  // 9. LEAD under the J-10 split — nobody has contacted them
  specs.push({
    id: "m_lead", clubId, firstName: "Jordan", lastName: "Blake", status: "PROSPECT", joinedAt: ago(12),
  });
  // 10. Lapsed
  specs.push({
    id: "m_inactive", clubId, firstName: "Elena", lastName: "Vasquez", status: "INACTIVE",
    email: "elena@local.test", joinedAt: ago(700),
  });

  // ── The 281 vs 293 shapes (see PROGRESS.md) ────────────────────────────
  // Soft-deleted: excluded by `deletedAt: null` in memberWhere.
  for (let i = 0; i < 7; i++) {
    specs.push({
      id: `m_deleted_${i}`, clubId, firstName: `Deleted${i}`, lastName: "Person",
      status: "INACTIVE", deletedAt: ago(60), joinedAt: ago(500),
    });
  }
  // Historical-only: 2.5.9 says these are "never in active rosters, billing,
  // messaging; only in all-time reporting" — but nothing was filtering them.
  for (let i = 0; i < 5; i++) {
    specs.push({
      id: `m_historical_${i}`, clubId, firstName: `Historical${i}`, lastName: "Record",
      status: "INACTIVE", isHistoricalOnly: true, sourceSystem: "ACME",
      importBatchId: batch.id, importedAt: ago(90), joinedAt: ago(900),
    });
  }

  for (const data of specs) await prisma.member.create({ data });

  // Cameron's guardian link — the family the profile switcher renders.
  await prisma.memberGuardianUser.create({
    data: {
      clubId, userId: guardian.id, memberId: "m_import_unreviewed",
      relationship: "PARENT", status: "CONFIRMED", isPrimary: true, source: "OWNER_VOUCHED",
      confirmedAt: ago(30), canBook: true, canPay: true, canSignWaivers: true, canReceiveEmails: true,
    },
  });
  // A sibling so the switcher has more than two people.
  await prisma.member.create({
    data: {
      id: "m_sibling", clubId, firstName: "Rory", lastName: "Lister", status: "ACTIVE",
      isMinor: true, dateOfBirth: new Date("2014-06-11"), guardianEmail: "michael@local.test",
      guardianName: "Michael Lister", joinedAt: ago(300),
    },
  });
  await prisma.memberGuardianUser.create({
    data: {
      clubId, userId: guardian.id, memberId: "m_sibling", relationship: "PARENT",
      status: "CONFIRMED", isPrimary: false, source: "OWNER_VOUCHED", confirmedAt: ago(300),
      canBook: true, canPay: false, canSignWaivers: true, canReceiveEmails: true,
    },
  });
  // A PENDING link — grants nothing, must render as pending.
  const coParent = await prisma.user.upsert({
    where: { clubId_email: { clubId, email: "sam@local.test" } },
    update: {},
    create: { clubId, email: "sam@local.test", passwordHash: hash, firstName: "Sam", lastName: "Lister", role: "MEMBER" },
  });
  await prisma.memberGuardianUser.create({
    data: {
      clubId, userId: coParent.id, memberId: "m_import_unreviewed", relationship: "PARENT",
      status: "PENDING", isPrimary: false, source: "STAFF_LINKED", createdByUserId: owner.id,
      canBook: false, canPay: false, canSignWaivers: false, canReceiveEmails: false,
    },
  });

  await prisma.memberSubscription.create({
    data: {
      memberId: "m_active", membershipId: membership.id, optionLabel: "Monthly",
      price: 175, billingPeriod: "MONTHLY", status: "active", startedAt: ago(400),
    },
  });
  await prisma.memberSubscription.create({
    data: {
      memberId: "m_inactive", membershipId: membership.id, optionLabel: "Monthly",
      price: 150, billingPeriod: "MONTHLY", status: "canceled", canceledAt: ago(90),
    },
  });

  const total = await prisma.member.count({ where: { clubId } });
  const visible = await prisma.member.count({ where: { clubId, deletedAt: null, isHistoricalOnly: false } });
  console.log(`\nSeeded. members table rows: ${total} · roster-visible: ${visible}`);
  console.log(`  soft-deleted: ${await prisma.member.count({ where: { clubId, deletedAt: { not: null } } })}`);
  console.log(`  historical-only: ${await prisma.member.count({ where: { clubId, isHistoricalOnly: true } })}`);
  console.log(`\nLog in at http://127.0.0.1:3000/login — owner@local.test / localtest123 / club slug frog-empire\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
