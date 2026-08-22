/**
 * Local-only: pad the seeded club up to ~294 emailable members so the bulk
 * send path can be measured at the size Frog Empire actually is.
 *
 * A slice of them are minors with a guardian email, because that is what makes
 * rows exceed members in HOUSEHOLD mode (293 members produced 294 rows in
 * production, and the >100 ROWS threshold is what decides queue vs inline).
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
 *     npx tsx scripts/seed-bulk-send-scale.ts [count]
 */
import { PrismaClient, type Prisma } from "@prisma/client";

const url = process.env.DATABASE_URL ?? "";
if (!/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error("REFUSING: DATABASE_URL is not localhost.");
  process.exit(1);
}
const prisma = new PrismaClient();
const TARGET = Number(process.argv[2] ?? 294);

async function main() {
  const clubId = "club_local";
  const existing = await prisma.member.count({ where: { clubId, deletedAt: null } });
  const need = Math.max(0, TARGET - existing);
  console.log(`existing roster: ${existing} · creating ${need}`);

  const rows: Prisma.MemberCreateManyInput[] = Array.from({ length: need }, (_, i) => {
    const n = i + 1;
    const minor = n % 7 === 0; // ~1 in 7 is a minor with a guardian address
    return {
      clubId,
      firstName: `Scale${n}`,
      lastName: `Test`,
      email: minor ? null : `scale${n}@local.test`,
      guardianEmail: minor ? `guardian${n}@local.test` : null,
      guardianName: minor ? `Guardian ${n}` : null,
      isMinor: minor,
      status: "ACTIVE" as const,
    };
  });

  const BATCH = 200;
  for (let i = 0; i < rows.length; i += BATCH) {
    await prisma.member.createMany({ data: rows.slice(i, i + BATCH), skipDuplicates: true });
  }
  const total = await prisma.member.count({ where: { clubId, deletedAt: null } });
  const emailable = await prisma.member.count({
    where: { clubId, deletedAt: null, OR: [{ email: { not: null } }, { guardianEmail: { not: null } }] },
  });
  console.log(`roster now: ${total} · with a deliverable address: ${emailable}`);
}
main().finally(() => prisma.$disconnect());
