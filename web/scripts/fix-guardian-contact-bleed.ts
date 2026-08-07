// Guardian-contact bleed correction (Session D, D-1). DRY-RUN by default.
//
//   npx tsx scripts/fix-guardian-contact-bleed.ts                        # dry run — read this first
//   npx tsx scripts/fix-guardian-contact-bleed.ts --clubs <clubId>       # dry run, one club
//   npx tsx scripts/fix-guardian-contact-bleed.ts --apply --members <id|email>,…
//   npx tsx scripts/fix-guardian-contact-bleed.ts --apply --clubs <clubId> --all-in-club
//
// --apply REFUSES to run without either an explicit --members allowlist or the
// deliberate --clubs <id> --all-in-club pair. The dry run prints every row it
// would touch, with both values, so the list can be eyeballed before anything
// is written.
//
// ── What this corrects, and why it is not the detector's job ────────────────
//
// The member importer copied guardian contact into MINORS' OWN email/phone
// columns. That violates the contact rule in CLAUDE.md — "minor athlete contact
// belongs on guardianEmail/guardianPhone by default; do not duplicate a
// guardian email into the child's own Member.email" — and it had a visible
// consequence: siblings share a guardian, so they shared a duplicate-detection
// key and the roster flagged them as the same person.
//
// The DETECTOR has already been made defensive independently
// (lib/memberDuplicates.ts skips a contact key that equals the same row's
// guardian contact). That fix stands on its own and must, because the next
// import can reintroduce this shape. This script is the separate data cleanup,
// deliberately NOT folded into the detector.
//
// ── What it does, exactly ───────────────────────────────────────────────────
//
// For a LIVE MINOR whose own `email` equals their own `guardianEmail`
// (case-insensitive), null the member's `email`. Same for `phone` vs
// `guardianPhone`, compared on digits only. Nothing else is written.
//
// Safety properties:
//   • MINORS ONLY. An adult member legitimately sharing an address with a
//     guardian record is not touched.
//   • The guardian columns are never modified — the contact is preserved, it
//     just stops being duplicated onto the child.
//   • A member whose own contact DIFFERS from their guardian's is never
//     touched, whatever it is.
//   • Never touches a member who has their OWN portal login (`userId`): that
//     address may be a real credential, and `users.email` is a different
//     column that this script has no business reasoning about.
//   • Soft-deleted members are skipped.
//   • Every write is logged to MemberMigrationEvent with the old value, so the
//     change is attributable and reversible by hand.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL_IN_CLUB = args.includes("--all-in-club");
const argAfter = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const clubsArg = argAfter("--clubs");
const membersArg = argAfter("--members");
const clubIds = (clubsArg || "").split(",").map((s) => s.trim()).filter(Boolean);
const allow = new Set((membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

if (APPLY && allow.size === 0 && !(clubIds.length === 1 && ALL_IN_CLUB)) {
  console.error(
    "--apply requires --members <id|email>,… OR exactly one --clubs <id> together with --all-in-club.\n" +
      "Run the dry run first and read the list.",
  );
  process.exit(1);
}

const digits = (s: string | null) => (s ? s.replace(/\D/g, "") : "");
const norm = (s: string | null) => (s ? s.trim().toLowerCase() : "");

type Fix = {
  memberId: string;
  name: string;
  clubId: string;
  clearEmail: string | null;
  clearPhone: string | null;
};

async function collect(): Promise<Fix[]> {
  const rows = await prisma.member.findMany({
    where: {
      deletedAt: null,
      isMinor: true,
      userId: null, // never touch a member who signs in with this address
      ...(clubIds.length ? { clubId: { in: clubIds } } : {}),
      OR: [{ email: { not: null } }, { phone: { not: null } }],
    },
    select: {
      id: true, clubId: true, firstName: true, lastName: true,
      email: true, phone: true, guardianEmail: true, guardianPhone: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const fixes: Fix[] = [];
  for (const m of rows) {
    const emailBleeds = !!m.email && norm(m.email) === norm(m.guardianEmail);
    const phoneBleeds =
      !!m.phone && digits(m.phone).length >= 7 && digits(m.phone) === digits(m.guardianPhone);
    if (!emailBleeds && !phoneBleeds) continue;
    fixes.push({
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName}`,
      clearEmail: emailBleeds ? m.email : null,
      clearPhone: phoneBleeds ? m.phone : null,
    });
  }
  return fixes;
}

function selected(f: Fix): boolean {
  if (ALL_IN_CLUB) return true;
  return allow.has(f.memberId.toLowerCase()) || (!!f.clearEmail && allow.has(norm(f.clearEmail)));
}

async function main() {
  const fixes = await collect();

  console.log(`\nGuardian-contact bleed — ${APPLY ? "APPLY" : "DRY RUN"}`);
  console.log(clubIds.length ? `Clubs: ${clubIds.join(", ")}` : "Clubs: all");
  console.log(`Live minors with guardian contact duplicated onto their own row: ${fixes.length}\n`);

  if (fixes.length === 0) {
    console.log("Nothing to correct.\n");
    return;
  }

  const emailCount = fixes.filter((f) => f.clearEmail).length;
  const phoneCount = fixes.filter((f) => f.clearPhone).length;
  console.log(`  own email == guardian email : ${emailCount}`);
  console.log(`  own phone == guardian phone : ${phoneCount}\n`);

  for (const f of fixes) {
    const parts: string[] = [];
    if (f.clearEmail) parts.push(`email "${f.clearEmail}" -> null`);
    if (f.clearPhone) parts.push(`phone "${f.clearPhone}" -> null`);
    const mark = APPLY ? (selected(f) ? "APPLY " : "skip  ") : "would ";
    console.log(`  ${mark} ${f.name.padEnd(28)} ${f.memberId.padEnd(28)} ${parts.join(" · ")}`);
  }

  if (!APPLY) {
    console.log(
      `\nDry run only — nothing written. To act, re-run with --apply plus either` +
        `\n  --members <id|email>,…` +
        `\n  --clubs <clubId> --all-in-club\n`,
    );
    return;
  }

  let applied = 0;
  for (const f of fixes) {
    if (!selected(f)) continue;
    const data: { email?: null; phone?: null } = {};
    if (f.clearEmail) data.email = null;
    if (f.clearPhone) data.phone = null;

    await prisma.$transaction([
      prisma.member.update({ where: { id: f.memberId }, data }),
      prisma.memberMigrationEvent.create({
        data: {
          clubId: f.clubId,
          memberId: f.memberId,
          type: "NOTE",
          message:
            "Contact correction: removed guardian contact duplicated onto this minor's own record " +
            `(${[f.clearEmail ? `email ${f.clearEmail}` : null, f.clearPhone ? `phone ${f.clearPhone}` : null]
              .filter(Boolean)
              .join(", ")}). The guardian's own fields are unchanged.`,
        },
      }),
    ]);
    applied++;
  }

  // Re-read what was written rather than trusting the update call.
  const verifyIds = fixes.filter(selected).map((f) => f.memberId);
  const after = await prisma.member.findMany({
    where: { id: { in: verifyIds } },
    select: { id: true, email: true, phone: true, guardianEmail: true, guardianPhone: true },
  });
  const stillBleeding = after.filter(
    (m) =>
      (!!m.email && norm(m.email) === norm(m.guardianEmail)) ||
      (!!m.phone && digits(m.phone).length >= 7 && digits(m.phone) === digits(m.guardianPhone)),
  );

  console.log(`\nApplied to ${applied} member(s). Re-read ${after.length}; still bleeding: ${stillBleeding.length}`);
  if (stillBleeding.length) console.log("  ", stillBleeding.map((m) => m.id).join(", "));
  console.log();
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
