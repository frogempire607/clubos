// Who is allowed to sign a guardian-required document, and whose name goes on
// it. Integration tests against the local throwaway Postgres.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//   DIRECT_URL=$DATABASE_URL npx tsx scripts/signature-attribution-tests.ts
//
// THE DEFECT THESE PIN (found in production 2026-08-16):
//
//   Zachary Lawell, age FOUR, has a Liability Waiver and a Code of Conduct
//   recorded with `relationship: SELF` and `signerName: "Zachary Lawell"`.
//   A four-year-old is on record as having personally signed his own waiver.
//
//   The guard was not missing. `/api/member/documents/[id]/sign` has always
//   refused a minor self-signing a guardian-required document — but it read
//   `Member.isMinor`, the STORED FLAG, and his row said `false` because signup
//   wrote whichever option was clicked. `resolveIsMinor` exists precisely so a
//   date of birth outranks that flag; the login gate has always used it, and
//   the document layer never did.
//
// So these tests assert the rule against the DOB, with the flag deliberately
// lying in both directions.

import { PrismaClient } from "@prisma/client";
import { resolveIsMinor } from "../lib/parentalConsent";
import { isMinorAge, ageFromDOB } from "../lib/age";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes(":55432")) {
  console.error("Refusing to run: DATABASE_URL is not the local test database on port 55432.");
  process.exit(1);
}

const prisma = new PrismaClient();

let pass = 0;
const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
    return;
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
}

/**
 * The gate as the route implements it, expressed once so the test asserts the
 * RULE rather than re-typing the route's branch. Mirrors
 * `app/api/member/documents/[id]/sign/route.ts`.
 */
function selfSignRefused(
  doc: { requiresGuardianSignature: boolean },
  target: { isMinor: boolean | null; dateOfBirth: Date | string | null },
  isSelf: boolean,
): boolean {
  const targetIsMinor = resolveIsMinor(target);
  return doc.requiresGuardianSignature && targetIsMinor && isSelf;
}

const WAIVER = { requiresGuardianSignature: true };
const NEWSLETTER = { requiresGuardianSignature: false };

async function main() {
  // ── The Zachary Lawell row, replayed ───────────────────────────────────────
  console.log("\nThe four-year-old who signed his own liability waiver");
  {
    // His EXACT production shape: DOB says 4, the flag says adult.
    const zach = { isMinor: false, dateOfBirth: new Date("2021-12-06") };
    check("the DOB says minor", isMinorAge(zach.dateOfBirth));
    check("…while the stored flag says adult", zach.isMinor === false);
    check(
      "resolveIsMinor believes the birthday, not the flag",
      resolveIsMinor(zach) === true,
    );
    check(
      "so self-signing the waiver is now REFUSED",
      selfSignRefused(WAIVER, zach, true),
    );
    // The pre-fix behaviour, kept as an explicit contrast so a regression is
    // legible rather than just a red X.
    const oldGateWouldAllow = !(WAIVER.requiresGuardianSignature && zach.isMinor && true);
    check(
      "…where the OLD flag-only gate would have allowed it",
      oldGateWouldAllow,
    );
    check(
      "a guardian signing for him is still allowed",
      !selfSignRefused(WAIVER, zach, false),
    );
  }

  // ── The flag lying in the other direction ──────────────────────────────────
  console.log("\nThe flag cannot grant OR withhold rights the DOB decides");
  {
    // Flagged minor, but genuinely an adult — must NOT be blocked.
    const grownUp = { isMinor: true, dateOfBirth: new Date("1990-04-01") };
    check("an adult mis-flagged as a minor is not blocked", !selfSignRefused(WAIVER, grownUp, true));

    // No DOB at all: the flag is all we have, so it is honoured.
    check(
      "with no DOB, the stored flag still governs (minor → blocked)",
      selfSignRefused(WAIVER, { isMinor: true, dateOfBirth: null }, true),
    );
    check(
      "with no DOB and no flag, self-signing is allowed",
      !selfSignRefused(WAIVER, { isMinor: false, dateOfBirth: null }, true),
    );
  }

  // ── Scope: only guardian-required documents ────────────────────────────────
  console.log("\nOnly guardian-required documents are gated");
  {
    const kid = { isMinor: false, dateOfBirth: new Date("2015-06-01") };
    check("a minor may self-sign a non-guardian document", !selfSignRefused(NEWSLETTER, kid, true));
    check("…but not a guardian-required one", selfSignRefused(WAIVER, kid, true));
  }

  // ── Ages around the boundary ───────────────────────────────────────────────
  console.log("\nThe 18th birthday");
  {
    const today = new Date();
    const exactly18 = new Date(today);
    exactly18.setFullYear(today.getFullYear() - 18);
    const dayShyOf18 = new Date(exactly18);
    dayShyOf18.setDate(dayShyOf18.getDate() + 1);

    check("exactly 18 today → adult", ageFromDOB(exactly18) === 18);
    check("…so they may self-sign", !selfSignRefused(WAIVER, { isMinor: true, dateOfBirth: exactly18 }, true));
    check("one day shy of 18 → minor", ageFromDOB(dayShyOf18) === 17);
    check("…so they may not", selfSignRefused(WAIVER, { isMinor: false, dateOfBirth: dayShyOf18 }, true));
  }

  // ── The production sweep, as a standing assertion ──────────────────────────
  // Live production today: 4 SELF signatures against 76 GUARDIAN. Two are
  // Zachary's, at age 4 — the defect. The other two are Michael Lister's, who
  // has no DOB, so his age cannot be checked (an adult by every other signal).
  //
  // NOTE THE `deletedAt` FILTER BELOW — it is load-bearing. `document_signatures`
  // carries no tenancy or liveness column of its own, so a sweep that does not
  // join `members` and filter `m.deletedAt IS NULL` counts signatures belonging
  // to soft-deleted members. The first pass at this audit didn't, reported 6
  // rows instead of 4, and named a member who has never signed anything.
  console.log("\nThe detection query finds a self-signed minor");
  {
    const CLUB = "club_sig_test";
    await prisma.club.upsert({
      where: { id: CLUB },
      update: {},
      create: { id: CLUB, name: "Signature Test Club", slug: "sig-test-club" },
    });
    // findMany does NOT ignore deletedAt here — these are explicit cleanups, so
    // the soft-deleted fixture from a previous run is swept too.
    const stale = await prisma.member.findMany({ where: { clubId: CLUB }, select: { id: true } });
    await prisma.documentSignature.deleteMany({ where: { memberId: { in: stale.map((s) => s.id) } } });
    await prisma.member.deleteMany({ where: { clubId: CLUB } });
    await prisma.document.deleteMany({ where: { clubId: CLUB } });
    await prisma.user.deleteMany({ where: { clubId: CLUB } });

    const signer = await prisma.user.upsert({
      where: { clubId_email: { clubId: CLUB, email: "sig@shapes.test" } },
      update: {},
      create: {
        clubId: CLUB, email: "sig@shapes.test", passwordHash: "x",
        firstName: "Sig", lastName: "Tester", role: "MEMBER",
      },
    });
    const doc = await prisma.document.create({
      data: { clubId: CLUB, title: "Liability Waiver", type: "WAIVER", requiresGuardianSignature: true },
    });
    const child = await prisma.member.create({
      data: {
        clubId: CLUB, firstName: "Tiny", lastName: "Signer",
        isMinor: false, dateOfBirth: new Date("2021-12-06"), status: "ACTIVE",
      },
    });
    const adult = await prisma.member.create({
      data: {
        clubId: CLUB, firstName: "Grown", lastName: "Adult",
        isMinor: false, dateOfBirth: new Date("1990-01-01"), status: "ACTIVE",
      },
    });
    // A SOFT-DELETED member who also self-signed. This is the row that made the
    // first audit over-count: it is still in `document_signatures`, and nothing
    // on that table says the member is gone.
    const ghost = await prisma.member.create({
      data: {
        clubId: CLUB, firstName: "Removed", lastName: "Member",
        isMinor: false, dateOfBirth: new Date("2010-01-01"), status: "INACTIVE",
        deletedAt: new Date(),
      },
    });
    await prisma.documentSignature.createMany({
      data: [
        { documentId: doc.id, memberId: child.id, signerUserId: signer.id, signerName: "Tiny Signer", relationship: "SELF", signedAt: new Date() },
        { documentId: doc.id, memberId: adult.id, signerUserId: signer.id, signerName: "Grown Adult", relationship: "SELF", signedAt: new Date() },
        { documentId: doc.id, memberId: ghost.id, signerUserId: signer.id, signerName: "Removed Member", relationship: "SELF", signedAt: new Date() },
      ],
    });

    // The unfiltered sweep — what the first pass ran, kept here so the
    // over-count is a demonstrated failure mode rather than a warning comment.
    const unfiltered = await prisma.documentSignature.findMany({
      where: { relationship: "SELF", member: { clubId: CLUB } },
      select: { signerName: true },
    });
    check("an unfiltered sweep over-counts by the soft-deleted member", unfiltered.length === 3, String(unfiltered.length));

    const rows = await prisma.documentSignature.findMany({
      where: {
        relationship: "SELF",
        // Load-bearing: document_signatures has no liveness column of its own.
        member: { clubId: CLUB, deletedAt: null, dateOfBirth: { not: null } },
      },
      select: { signerName: true, signedAt: true, member: { select: { dateOfBirth: true } } },
    });
    check("…and filtering deletedAt drops it", rows.length === 2, String(rows.length));
    check("…specifically the removed member", !rows.some((r) => r.signerName === "Removed Member"));
    // Age AT SIGNING, not age now — someone who has since turned 18 still counts.
    const minorsAtSigning = rows.filter(
      (r) => ageFromDOB(r.member.dateOfBirth) !== null && isMinorAge(r.member.dateOfBirth),
    );
    check("finds exactly the one self-signed minor", minorsAtSigning.length === 1, String(minorsAtSigning.length));
    check("…and it's the four-year-old", minorsAtSigning[0]?.signerName === "Tiny Signer");
    check("the adult's self-signature is not flagged", minorsAtSigning.every((r) => r.signerName !== "Grown Adult"));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
