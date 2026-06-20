/**
 * Hard-reset a club's MEMBER data — PHYSICALLY deletes members, guardians, and
 * their member/guardian logins (role MEMBER), so you can start a member import
 * from a truly clean slate with no soft-deleted ghost rows.
 *
 * PRESERVED: the owner, all staff, and every club configuration row
 * (memberships, events, classes, documents, locations, staff profiles, etc.).
 *
 * Safe by design:
 *   - DRY RUN by default — prints counts and changes nothing.
 *   - Scoped to ONE club (by slug).
 *   - Runs the deletes in a single transaction (all-or-nothing).
 *   - Refuses to run if active subscriptions exist (Stripe keeps billing even
 *     after a DB delete) unless you pass --force.
 *
 * Usage (from web/):
 *   npx tsx scripts/hard-reset-members.ts                      # dry run, club "frogempire607"
 *   npx tsx scripts/hard-reset-members.ts frogempire607        # dry run, explicit slug
 *   npx tsx scripts/hard-reset-members.ts frogempire607 --confirm
 *   npx tsx scripts/hard-reset-members.ts frogempire607 --confirm --force   # ignore active-sub guard
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// tsx doesn't auto-load .env the way Next/Prisma CLI do, so load it ourselves.
function loadEnv() {
  if (process.env.DATABASE_URL) return;
  for (const file of [".env.local", ".env"]) {
    try {
      const txt = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const line of txt.split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && process.env[m[1]] === undefined) {
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          process.env[m[1]] = v;
        }
      }
    } catch {
      /* file not present — fine */
    }
  }
}
loadEnv();

// eslint-disable-next-line @typescript-eslint/no-var-requires
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const slug = args.find((a) => !a.startsWith("--")) || "frogempire607";
  const confirm = args.includes("--confirm");
  const force = args.includes("--force");

  const club = await prisma.club.findUnique({
    where: { slug },
    select: { id: true, name: true, slug: true },
  });
  if (!club) {
    console.error(`\n❌ No club found with slug "${slug}". Nothing changed.\n`);
    process.exit(1);
  }
  const clubId = club.id;

  const [members, guardians, memberUsers, ownerUsers, staffUsers, activeSubs] = await Promise.all([
    prisma.member.count({ where: { clubId } }),
    prisma.guardian.count({ where: { clubId } }),
    prisma.user.count({ where: { clubId, role: "MEMBER" } }),
    prisma.user.count({ where: { clubId, role: "OWNER" } }),
    prisma.user.count({ where: { clubId, role: "STAFF" } }),
    prisma.memberSubscription.count({ where: { status: "active", member: { clubId } } }),
  ]);

  console.log(`\nClub: ${club.name} (${club.slug})   id=${clubId}`);
  console.log("────────────────────────────────────────────────");
  console.log(`  Members to delete ................. ${members}`);
  console.log(`  Guardians to delete .............. ${guardians}`);
  console.log(`  Member/guardian logins to delete . ${memberUsers}`);
  console.log(`  Active subscriptions ............. ${activeSubs}`);
  console.log("  PRESERVED:");
  console.log(`    Owner logins ................... ${ownerUsers}`);
  console.log(`    Staff logins ................... ${staffUsers}`);
  console.log(`    All club config (memberships, events, classes, documents, …) untouched`);
  console.log("────────────────────────────────────────────────");

  if (activeSubs > 0 && !force) {
    console.error(
      `\n⚠️  ${activeSubs} ACTIVE subscription(s) exist for this club.\n` +
        `    A database delete does NOT cancel Stripe billing — those customers would keep\n` +
        `    getting charged. Cancel them in Stripe first, or re-run with --force to proceed anyway.\n`,
    );
    process.exit(1);
  }

  if (!confirm) {
    console.log(`\nDRY RUN — nothing was deleted. When the numbers look right, re-run with --confirm:`);
    console.log(`    npx tsx scripts/hard-reset-members.ts ${slug} --confirm\n`);
    await prisma.$disconnect();
    return;
  }

  console.log("\nDeleting (single transaction)…");
  // Order: members first (cascades document signatures, subscriptions, bookings,
  // attendance, guardian links, migration events, relationships; nulls event
  // registrations), then guardian profiles, then their MEMBER-role logins.
  await prisma.$transaction([
    prisma.$executeRaw`DELETE FROM members WHERE "clubId" = ${clubId}`,
    prisma.$executeRaw`DELETE FROM guardians WHERE "clubId" = ${clubId}`,
    prisma.$executeRaw`DELETE FROM users WHERE "clubId" = ${clubId} AND role = 'MEMBER'`,
  ]);

  const [m2, g2, u2, o2, s2] = await Promise.all([
    prisma.member.count({ where: { clubId } }),
    prisma.guardian.count({ where: { clubId } }),
    prisma.user.count({ where: { clubId, role: "MEMBER" } }),
    prisma.user.count({ where: { clubId, role: "OWNER" } }),
    prisma.user.count({ where: { clubId, role: "STAFF" } }),
  ]);
  console.log(
    `\n✅ Done. Now → members: ${m2}, guardians: ${g2}, member logins: ${u2}.  ` +
      `Preserved → owners: ${o2}, staff: ${s2}.\n`,
  );
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error("\n❌ Failed (nothing was committed):", e);
  await prisma.$disconnect();
  process.exit(1);
});
