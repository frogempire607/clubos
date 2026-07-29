// Reports Phase 2.5.9 — historical-imports backfills BF-1 / BF-2 / BF-3.
//
// Fills three columns on existing production rows:
//   BF-1  Member.sourceSystem = 'ATHLETIXOS' (when null).
//   BF-2  Member.normalizedEmail  = lower(trim(email))     when email present.
//         Member.normalizedPhone  = digits-only(phone)     when phone present.
//   BF-3  Transaction.sourceSystem derived from paymentSource:
//           STRIPE          → STRIPE
//           CASH            → CASH
//           CHECK           → BANK
//           EXTERNAL_READER → OTHER
//           MANUAL_ADJUSTMENT → MANUAL_IMPORT
//           COMP            → OTHER
//           null/unknown    → ATHLETIXOS  (native rows without a paymentSource
//                              are pre-2026-07-15 native writes)
//
// DRY-RUN by default. Prints a per-club report of how many rows would be
// touched in each pass. Pass `--apply` to commit; add `--clubs <id[,id]>`
// to scope. Ran the same day the migration is applied (2026-07-29).
//
// Usage:
//   npx tsx scripts/reports-historical-backfill.ts                  (dry-run all)
//   npx tsx scripts/reports-historical-backfill.ts --apply          (apply all)
//   npx tsx scripts/reports-historical-backfill.ts --apply --clubs x,y

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const APPLY = process.argv.includes("--apply");
const clubArg = process.argv.find((a) => a.startsWith("--clubs="));
const clubAllow = clubArg ? clubArg.slice("--clubs=".length).split(",").filter(Boolean) : null;

const TX_SOURCE_MAP: Record<string, string> = {
  STRIPE: "STRIPE",
  CASH: "CASH",
  CHECK: "BANK",
  EXTERNAL_READER: "OTHER",
  MANUAL_ADJUSTMENT: "MANUAL_IMPORT",
  COMP: "OTHER",
};

function normalizeEmail(e: string | null | undefined): string | null {
  if (!e) return null;
  const trimmed = e.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
function normalizePhone(p: string | null | undefined): string | null {
  if (!p) return null;
  const digits = p.replace(/\D+/g, "");
  return digits.length > 0 ? digits : null;
}

async function main() {
  const clubs = await prisma.club.findMany({
    where: clubAllow ? { id: { in: clubAllow } } : {},
    select: { id: true, name: true },
  });
  if (clubs.length === 0) {
    console.error("No clubs matched.");
    return;
  }
  console.log(APPLY ? "===  APPLY MODE  ===" : "===  DRY RUN  ===");
  console.log(`Clubs scoped: ${clubs.length} (${clubs.map((c) => c.name).join(", ") || "—"})`);
  console.log();

  let grandMemberSource = 0;
  let grandMemberEmail = 0;
  let grandMemberPhone = 0;
  let grandTxSource = 0;

  for (const club of clubs) {
    console.log(`── ${club.name} (${club.id}) ──`);

    // BF-1: Member.sourceSystem = ATHLETIXOS.
    const missingSource = await prisma.member.count({
      where: { clubId: club.id, sourceSystem: null },
    });
    console.log(`  BF-1 members without sourceSystem: ${missingSource}`);
    if (APPLY && missingSource > 0) {
      const r = await prisma.member.updateMany({
        where: { clubId: club.id, sourceSystem: null },
        data: { sourceSystem: "ATHLETIXOS" },
      });
      console.log(`       applied: ${r.count}`);
      grandMemberSource += r.count;
    } else {
      grandMemberSource += missingSource;
    }

    // BF-2: normalizedEmail + normalizedPhone. Do this row-by-row because
    // updateMany can't compute per-row transforms.
    const membersNeedingNorm = await prisma.member.findMany({
      where: {
        clubId: club.id,
        OR: [
          { normalizedEmail: null, email: { not: null } },
          { normalizedPhone: null, phone: { not: null } },
        ],
      },
      select: { id: true, email: true, phone: true, normalizedEmail: true, normalizedPhone: true },
    });
    let emailCount = 0;
    let phoneCount = 0;
    for (const m of membersNeedingNorm) {
      const ne = m.normalizedEmail == null ? normalizeEmail(m.email) : null;
      const np = m.normalizedPhone == null ? normalizePhone(m.phone) : null;
      if (ne == null && np == null) continue;
      if (ne != null) emailCount += 1;
      if (np != null) phoneCount += 1;
      if (APPLY) {
        await prisma.member.update({
          where: { id: m.id },
          data: {
            ...(ne != null ? { normalizedEmail: ne } : {}),
            ...(np != null ? { normalizedPhone: np } : {}),
          },
        });
      }
    }
    console.log(`  BF-2 members needing normalizedEmail: ${emailCount}, normalizedPhone: ${phoneCount}`);
    grandMemberEmail += emailCount;
    grandMemberPhone += phoneCount;

    // BF-3: Transaction.sourceSystem derived from paymentSource. Batched
    // updateMany per bucket for perf.
    const txMissing = await prisma.transaction.groupBy({
      by: ["paymentSource"],
      where: { clubId: club.id, sourceSystem: null },
      _count: { _all: true },
    });
    let clubTx = 0;
    for (const bucket of txMissing) {
      const target = TX_SOURCE_MAP[bucket.paymentSource ?? ""] ?? "ATHLETIXOS";
      const count = bucket._count._all;
      console.log(`  BF-3 tx paymentSource=${bucket.paymentSource ?? "null"} (→ ${target}): ${count}`);
      clubTx += count;
      if (APPLY && count > 0) {
        await prisma.transaction.updateMany({
          where: { clubId: club.id, sourceSystem: null, paymentSource: bucket.paymentSource },
          data: { sourceSystem: target },
        });
      }
    }
    grandTxSource += clubTx;

    console.log();
  }

  console.log("=== Totals ===");
  console.log(`BF-1 Member.sourceSystem       : ${grandMemberSource}`);
  console.log(`BF-2 Member.normalizedEmail    : ${grandMemberEmail}`);
  console.log(`BF-2 Member.normalizedPhone    : ${grandMemberPhone}`);
  console.log(`BF-3 Transaction.sourceSystem  : ${grandTxSource}`);
  console.log(APPLY ? "APPLIED." : "Dry-run — rerun with --apply to commit.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
