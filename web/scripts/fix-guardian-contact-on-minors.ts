// Guardian contact sitting in a minor's OWN email/phone columns. DRY-RUN by default.
//
//   npx tsx scripts/fix-guardian-contact-on-minors.ts                        # dry run — read this first
//   npx tsx scripts/fix-guardian-contact-on-minors.ts --clubs <clubId>       # dry run, one club
//   npx tsx scripts/fix-guardian-contact-on-minors.ts --apply --members <id|email>,…
//
// --apply REFUSES to run without an explicit --members allowlist. Julian runs
// this from his own terminal; the sandbox cannot reach the database.
//
// ── Why this exists (session 4, D-1) ───────────────────────────────────────
// CLAUDE.md's contact rule: "minor athlete contact belongs on guardianEmail /
// guardianPhone by default; do not duplicate a guardian email into the child's
// own Member.email just to satisfy an email schema." The importer did exactly
// that — it treats generic email/phone columns as member contact and, for rows
// where explicit guardian columns were also present, wrote the same value to
// both. Measured read-only against production on 2026-08-05:
//
//     live minors whose own members.email == their guardianEmail    27
//     live minors whose own members.phone == their guardianPhone    42
//     live minors with any own email at all                         34
//
// Consequences this repairs:
//   • Siblings share a surname and (wrongly) an email and phone, so they
//     collided in duplicate detection. `/api/members/duplicates` no longer
//     keys on a value that matches the same row's guardian columns, so the
//     false positives are ALREADY gone without this script. This is the
//     second half: fix the stored data so the rest of the app stops reading a
//     guardian's address as a child's.
//   • A minor with an "own" email looks contactable. Invitations, password
//     resets and bulk email would address the child at the guardian's inbox
//     while reporting it as the child's own — which is how a guardian ends up
//     with two copies of everything and no way to tell which child it is for.
//
// ── What it changes ────────────────────────────────────────────────────────
// For a LIVE (deletedAt: null) member who `isMinor`:
//   • members.email → null  when it equals members.guardianEmail (case-insensitive)
//   • members.phone → null  when its digits equal members.guardianPhone's digits
//
// The guardian columns are NOT touched — the contact information is preserved
// there, which is where the rule says it belongs. Nothing else is written.
//
// ── What it deliberately does NOT do ───────────────────────────────────────
//   • It never nulls a value that has no guardian counterpart on the same row.
//     If a child's email is the guardian's but guardianEmail is blank, there is
//     no evidence in the row and a human has to look. Those are REPORTED, never
//     changed (see the "no guardian counterpart" section of the dry-run output).
//   • It never touches a member who owns a portal login (`userId`). If a minor
//     signs in with that address, removing it removes their identity trail; the
//     login itself lives on users.email and is out of scope here.
//   • It never touches adults, soft-deleted rows, or guardian columns.
//   • It writes no MemberMigrationEvent by default — see --log-activity.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const LOG_ACTIVITY = args.includes("--log-activity");
const argAfter = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);

const allow = new Set(
  (argAfter("--members") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);
const clubFilter = (argAfter("--clubs") || "").split(",").map((s) => s.trim()).filter(Boolean);

if (APPLY && allow.size === 0) {
  console.error(
    "--apply requires an explicit --members <id|email>,… allowlist.\n" +
      "Run the dry run first, review the list, then pass the ids you approve.",
  );
  process.exit(1);
}

const digits = (s: string | null) => (s || "").replace(/\D/g, "");
const norm = (s: string | null) => (s || "").trim().toLowerCase();

type Fix = {
  memberId: string;
  clubId: string;
  name: string;
  clearEmail: string | null;
  clearPhone: string | null;
};

async function main() {
  const members = await prisma.member.findMany({
    where: {
      deletedAt: null,
      isMinor: true,
      ...(clubFilter.length ? { clubId: { in: clubFilter } } : {}),
      OR: [{ email: { not: null } }, { phone: { not: null } }],
    },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, userId: true,
      email: true, phone: true, guardianEmail: true, guardianPhone: true,
    },
    orderBy: [{ clubId: "asc" }, { lastName: "asc" }, { firstName: "asc" }],
  });

  const fixes: Fix[] = [];
  const skippedHasLogin: string[] = [];
  const noCounterpart: string[] = [];

  for (const m of members) {
    const name = `${m.firstName} ${m.lastName}`.trim();
    const emailMatches = !!m.email && norm(m.email) === norm(m.guardianEmail);
    const phoneMatches = !!m.phone && digits(m.phone).length > 0 && digits(m.phone) === digits(m.guardianPhone);

    if (!emailMatches && !phoneMatches) {
      // Report-only: an own email with no guardian email on the row is the
      // shape this script cannot judge. Left entirely alone.
      if (m.email && !m.guardianEmail) noCounterpart.push(`${name} <${m.email}> (${m.id}) — no guardianEmail to compare`);
      continue;
    }
    if (m.userId) {
      skippedHasLogin.push(`${name} (${m.id}) — owns a portal login, skipped`);
      continue;
    }
    fixes.push({
      memberId: m.id,
      clubId: m.clubId,
      name,
      clearEmail: emailMatches ? m.email : null,
      clearPhone: phoneMatches ? m.phone : null,
    });
  }

  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — guardian contact on minors ===`);
  console.log(`scanned ${members.length} live minor(s) with an own email or phone\n`);

  if (fixes.length === 0) {
    console.log("Nothing to correct.");
  } else {
    const emailCount = fixes.filter((f) => f.clearEmail).length;
    const phoneCount = fixes.filter((f) => f.clearPhone).length;
    console.log(`${fixes.length} member(s) to correct — ${emailCount} email, ${phoneCount} phone:\n`);
    for (const f of fixes) {
      const inAllow = APPLY ? allow.has(f.memberId.toLowerCase()) || (f.clearEmail ? allow.has(norm(f.clearEmail)) : false) : true;
      const mark = APPLY && !inAllow ? "✗ (not in allowlist)" : "→";
      const parts = [
        f.clearEmail ? `email "${f.clearEmail}" → null` : null,
        f.clearPhone ? `phone "${f.clearPhone}" → null` : null,
      ].filter(Boolean).join(", ");
      console.log(`  ${mark} ${f.name} (${f.memberId})  ${parts}`);
    }
  }

  if (skippedHasLogin.length) {
    console.log(`\n${skippedHasLogin.length} skipped — owns a portal login (out of scope):`);
    for (const s of skippedHasLogin) console.log(`  · ${s}`);
  }
  if (noCounterpart.length) {
    console.log(
      `\n${noCounterpart.length} reported, NOT changed — own email with no guardianEmail on the row.` +
        `\nThere is no evidence in the row that this is the guardian's; a human has to look:`,
    );
    for (const s of noCounterpart) console.log(`  · ${s}`);
  }

  if (!APPLY) {
    console.log(
      "\nDry run only — nothing written." +
        "\nRe-run with --apply --members <ids> after reviewing the list above." +
        "\nThe guardian columns are never modified; the contact information stays on guardianEmail/guardianPhone.\n",
    );
    return;
  }

  let applied = 0;
  for (const f of fixes) {
    const inAllow = allow.has(f.memberId.toLowerCase()) || (f.clearEmail ? allow.has(norm(f.clearEmail)) : false);
    if (!inAllow) continue;
    await prisma.member.update({
      where: { id: f.memberId },
      data: {
        ...(f.clearEmail ? { email: null } : {}),
        ...(f.clearPhone ? { phone: null } : {}),
      },
    });
    if (LOG_ACTIVITY) {
      await prisma.memberMigrationEvent.create({
        data: {
          clubId: f.clubId,
          memberId: f.memberId,
          type: "NOTE",
          message:
            "Cleared the child's own " +
            [f.clearEmail ? "email" : null, f.clearPhone ? "phone" : null].filter(Boolean).join(" and ") +
            " — it duplicated the guardian's contact from the import. The value remains on the guardian fields.",
        },
      });
    }
    applied++;
  }
  console.log(`\nApplied to ${applied} member(s).`);

  // Re-read and confirm.
  const remaining = await prisma.member.findMany({
    where: {
      deletedAt: null, isMinor: true, userId: null,
      ...(clubFilter.length ? { clubId: { in: clubFilter } } : {}),
      OR: [{ email: { not: null } }, { phone: { not: null } }],
    },
    select: { id: true, email: true, phone: true, guardianEmail: true, guardianPhone: true },
  });
  const stillWrong = remaining.filter(
    (m) =>
      (!!m.email && norm(m.email) === norm(m.guardianEmail)) ||
      (!!m.phone && digits(m.phone).length > 0 && digits(m.phone) === digits(m.guardianPhone)),
  );
  console.log(`Verified: ${stillWrong.length} member(s) still carry guardian contact in their own columns (allowlist may exclude some).\n`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
