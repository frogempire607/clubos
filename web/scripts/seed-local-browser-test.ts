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

  // ── Duplicate-detection fixtures (Session D, D-1 / D-2) ────────────────
  // Session 3's fixture contained no duplicate pair at all, which is why "the
  // merge button does nothing" was never reproduced. Three shapes now exist.
  //
  // 1. TWO SIBLINGS carrying their guardian's contact in their OWN columns —
  //    the exact production shape (27 of 34 live minors). Before the D-1 fix
  //    these collide on email: AND on phone:+lastName and get flagged as the
  //    same person. They must NOT appear in duplicates.
  for (const [id, first, dob] of [
    ["m_bleed_a", "Iris", "2013-02-04"],
    ["m_bleed_b", "Otto", "2015-09-19"],
  ] as [string, string, string][]) {
    await prisma.member.create({
      data: {
        id, clubId, firstName: first, lastName: "Nakamura", status: "ACTIVE", isMinor: true,
        dateOfBirth: new Date(dob), joinedAt: ago(200),
        // The bleed: guardian contact copied onto the child's own row.
        email: "kenji.nakamura@local.test", phone: "(555) 010-0142",
        guardianName: "Kenji Nakamura", guardianEmail: "kenji.nakamura@local.test", guardianPhone: "(555) 010-0142",
      },
    });
  }

  // 1b. The CAMERON SHAPE (D-1 follow-up). The child's own email holds his
  //     father's REAL address, while his guardianEmail column holds a stale
  //     phantom nobody uses. The column-only rule never fired, so the child
  //     clustered with his father on `email:`. The father is a real adult member
  //     with a login, so this is a parent<->child collision, not sibling<->sibling.
  const dadUser = await prisma.user.create({
    data: {
      clubId, email: "hal.varga@local.test", passwordHash: hash,
      firstName: "Hal", lastName: "Varga", role: "MEMBER",
    },
  });
  await prisma.member.create({
    data: {
      id: "m_dad", clubId, firstName: "Hal", lastName: "Varga", status: "ACTIVE",
      email: "hal.varga@local.test", userId: dadUser.id, joinedAt: ago(500),
    },
  });
  await prisma.member.create({
    data: {
      id: "m_kid_stale_guardian", clubId, firstName: "Ivo", lastName: "Varga",
      status: "ACTIVE", isMinor: true, dateOfBirth: new Date("2011-08-22"),
      // His OWN email is his father's real address …
      email: "hal.varga@local.test",
      // … while the guardianEmail column is a stale address nobody reads.
      guardianName: "Hal Varga", guardianEmail: "old-hal@dead-domain.test",
      joinedAt: ago(320),
    },
  });
  await prisma.memberGuardianUser.create({
    data: {
      clubId, userId: dadUser.id, memberId: "m_kid_stale_guardian",
      relationship: "PARENT", status: "CONFIRMED", isPrimary: true,
      source: "OWNER_VOUCHED", confirmedAt: ago(320),
      canBook: true, canPay: true, canSignWaivers: true, canReceiveEmails: true,
    },
  });

  // 2. A GENUINE duplicate — same person entered twice. Same name + same DOB,
  //    which is the key the D-1 fix deliberately leaves intact. Neither has a
  //    login, so this pair is mergeable and Merge must actually work.
  for (const [id, days] of [["m_dupe_keep", 240], ["m_dupe_drop", 30]] as [string, number][]) {
    await prisma.member.create({
      data: {
        id, clubId, firstName: "Marcus", lastName: "Delacroix", status: "PROSPECT",
        dateOfBirth: new Date("1996-11-23"), joinedAt: ago(days),
        email: id === "m_dupe_keep" ? "marcus.d@local.test" : null,
        phone: id === "m_dupe_drop" ? "555-0188" : null,
      },
    });
  }

  // 3. A duplicate pair where BOTH rows have their own login — the 409 the
  //    merge API returns by design. This is the case whose error message had
  //    nowhere visible to render, so the button read as dead.
  for (const [id, email] of [
    ["m_dupe_login_a", "twin.a@local.test"],
    ["m_dupe_login_b", "twin.b@local.test"],
  ] as [string, string][]) {
    const u = await prisma.user.create({
      data: { clubId, email, passwordHash: hash, firstName: "Wren", lastName: "Halloway", role: "MEMBER" },
    });
    await prisma.member.create({
      data: {
        id, clubId, firstName: "Wren", lastName: "Halloway", status: "ACTIVE",
        dateOfBirth: new Date("1990-04-02"), joinedAt: ago(150), userId: u.id,
      },
    });
  }

  // ── Documents, so the Waivers & documents tab has all three states ──────
  // Session 3's fixture had no documents at all, which is why a Documents tab
  // that rendered literally nothing looked the same as one that was empty.
  const waiver = await prisma.document.create({
    data: {
      clubId, title: "Liability waiver", type: "WAIVER", required: true,
      requiredAt: ["ONBOARDING"], requiresGuardianSignature: true, signatureValidForDays: 365,
      body: "<p>Standard liability waiver.</p>",
    },
  });
  const codeOfConduct = await prisma.document.create({
    data: {
      clubId, title: "Athlete code of conduct", type: "POLICY", required: true,
      requiredAt: ["ONBOARDING"], body: "<p>Code of conduct.</p>",
    },
  });
  await prisma.document.create({
    data: { clubId, title: "Newsletter (optional)", type: "INFO", required: false, requiredAt: [], body: "<p>Info.</p>" },
  });
  // Signed, but 400 days ago against a 365-day window → EXPIRED, and therefore
  // still missing. This is the case that blocks a check-in while the profile
  // says "signed", and it needs to be visible.
  await prisma.documentSignature.create({
    data: {
      documentId: waiver.id, memberId: "m_active", signerUserId: guardian.id,
      signerName: "Michael Lister", relationship: "GUARDIAN", signedAt: ago(400),
    },
  });
  // Signed and current.
  await prisma.documentSignature.create({
    data: {
      documentId: codeOfConduct.id, memberId: "m_active", signerUserId: guardian.id,
      signerName: "Michael Lister", relationship: "GUARDIAN", signedAt: ago(20),
    },
  });
  // Cameron has signed neither → 2 missing, red dot on the Documents tab.

  // ── Migration activity, so the timeline has attributed rows ─────────────
  for (const [memberId, rows] of Object.entries({
    m_import_unreviewed: [
      ["IMPORT", "Imported from the previous system", 60],
      ["NOTE", "Corrected legacy ID 607329885 after the import", 40],
    ],
    m_invited: [
      ["IMPORT", "Imported from the previous system", 55],
      ["NOTE", "Information reviewed", 30],
      ["ACTIVATION_SENT", "Invitation sent to diego@local.test", 12],
    ],
    m_blocked: [
      ["IMPORT", "Imported from the previous system", 55],
      ["ACTIVATION_SENT", "Invitation sent — bounced", 21],
      ["ACTIVATION_SENT", "Invitation resent — bounced", 14],
    ],
  } as Record<string, [string, string, number][]>)) {
    for (const [type, message, daysAgo] of rows) {
      await prisma.memberMigrationEvent.create({
        data: { clubId, memberId, type, message, actorUserId: owner.id, createdAt: ago(daysAgo) },
      });
    }
  }

  // A staff note, so the Notes tab renders content rather than only an editor.
  await prisma.member.update({
    where: { id: "m_active" },
    data: { notes: "Prefers the 6pm session. Mum handles all billing questions." },
  });

  // ── Money owed, so the Balance column has all three of its states ───────
  // A PENDING offline Transaction is "the amount due, never revenue" per the
  // offline-payment rules. The VOID and SUCCEEDED rows below exist to prove
  // the column excludes them — a written-off charge must not reappear as debt.
  await prisma.transaction.create({
    data: {
      clubId, memberId: "m_active", amount: 175, type: "MEMBERSHIP", category: "memberships",
      status: "PENDING", paymentSource: "CHECK", reconciliationStatus: "OFFLINE", manual: true,
      description: "Competition Team — check due", createdAt: ago(65),
    },
  });
  await prisma.transaction.create({
    data: {
      clubId, memberId: "m_active", amount: 40, type: "CLASS", category: "classes",
      status: "PENDING", paymentSource: "CASH", reconciliationStatus: "VOID", manual: true,
      description: "Written off — must NOT count toward balance", createdAt: ago(30),
    },
  });
  await prisma.transaction.create({
    data: {
      clubId, memberId: "m_active", amount: 175, type: "MEMBERSHIP", category: "memberships",
      status: "SUCCEEDED", paymentSource: "STRIPE", reconciliationStatus: "VERIFIED",
      description: "Settled — must NOT count toward balance", createdAt: ago(95),
    },
  });

  // ── Invitation deliveries, so Blocked can tell a bounce from an ignore ──
  // Tomas bounced twice (address wrong → fix it); Diego was sent three and
  // never opened one (address fine → phone the parent). The counter alone
  // could not distinguish these, and they need opposite actions.
  for (const [memberId, email, rows] of [
    ["m_blocked", "bounce@local.test", [[21, true], [14, true]]],
    ["m_invited", "diego@local.test", [[30, false], [20, false], [12, false]]],
  ] as [string, string, [number, boolean][]][]) {
    for (const [daysAgo, bounced] of rows) {
      await prisma.memberInvitationDelivery.create({
        data: {
          clubId, memberId, sentToEmail: email, recipientKind: "SELF",
          sentAt: ago(daysAgo), sentByUserId: owner.id, trigger: "STAFF", provider: "RESEND",
          deliveredAt: bounced ? null : ago(daysAgo),
          bouncedAt: bounced ? ago(daysAgo) : null,
          bounceReason: bounced ? "mailbox does not exist" : null,
        },
      });
    }
  }

  const total = await prisma.member.count({ where: { clubId } });
  const visible = await prisma.member.count({ where: { clubId, deletedAt: null, isHistoricalOnly: false } });
  console.log(`\nSeeded. members table rows: ${total} · roster-visible: ${visible}`);
  console.log(`  soft-deleted: ${await prisma.member.count({ where: { clubId, deletedAt: { not: null } } })}`);
  console.log(`  historical-only: ${await prisma.member.count({ where: { clubId, isHistoricalOnly: true } })}`);
  console.log(`\nLog in at http://127.0.0.1:3000/login — owner@local.test / localtest123 / club slug frog-empire\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
