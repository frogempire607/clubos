/**
 * Test club seed — safe to run multiple times.
 * Creates test-club + owner/staff/member accounts ONLY if test-club doesn't exist.
 * Does NOT touch any other club's data.
 *
 * Run: npm run db:seed
 */
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.club.findUnique({ where: { slug: "test-club" } });
  if (existing) {
    console.log("ℹ  test-club already exists — nothing to do.");
    console.log("   To reset it, delete the club row in Prisma Studio first.");
    return;
  }

  // ── Create club ────────────────────────────────────────────────────────────
  const club = await prisma.club.create({
    data: {
      name: "Test Club",
      slug: "test-club",
      sport: "Wrestling",
      tagline: "For testing only",
      tier: "enterprise",
      primaryColor: "#534AB7",
    },
  });

  // ── Owner ──────────────────────────────────────────────────────────────────
  await prisma.user.create({
    data: {
      clubId: club.id,
      email: "owner@test.com",
      passwordHash: await bcrypt.hash("TestOwner123!", 10),
      firstName: "Test",
      lastName: "Owner",
      role: "OWNER",
    },
  });

  // ── Staff ──────────────────────────────────────────────────────────────────
  const staffUser = await prisma.user.create({
    data: {
      clubId: club.id,
      email: "staff@test.com",
      passwordHash: await bcrypt.hash("TestStaff123!", 10),
      firstName: "Test",
      lastName: "Staff",
      role: "STAFF",
    },
  });

  await prisma.staffProfile.create({
    data: {
      userId: staffUser.id,
      title: "Coach",
      permissions: {
        members: "view",
        events: "edit",
        messages: "send",
        finances: "none",
        documents: "view",
        staff: "none",
      },
    },
  });

  // ── Member (pre-created from dashboard, not yet portal-linked) ─────────────
  const memberRecord = await prisma.member.create({
    data: {
      clubId: club.id,
      firstName: "Test",
      lastName: "Member",
      email: "member@test.com",
      status: "ACTIVE",
      tags: "Beginner",
    },
  });

  // ── Member User (portal account, linked to memberRecord above) ─────────────
  await prisma.user.create({
    data: {
      clubId: club.id,
      email: "member@test.com",
      passwordHash: await bcrypt.hash("TestMember123!", 10),
      firstName: "Test",
      lastName: "Member",
      role: "MEMBER",
      memberProfile: { connect: { id: memberRecord.id } },
    },
  });

  console.log("✓ test-club seeded successfully\n");
  console.log("  Login at: http://localhost:3000/login");
  console.log("  Club slug: test-club\n");
  console.log("  Owner:    owner@test.com  / TestOwner123!");
  console.log("  Staff:    staff@test.com  / TestStaff123!");
  console.log("  Member:   member@test.com / TestMember123!");
  console.log("\n  Member portal: http://localhost:3000/member");
  console.log("  Dashboard:     http://localhost:3000/dashboard");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
