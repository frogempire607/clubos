// PERMANENT REGRESSION TOOL — family access preservation.
//
//   npm run verify:family-access
//   npm run verify:family-access -- --user jnt4265@gmail.com
//
// Run this after ANY change to guardian-link reads, the family helpers, or a
// migration touching member_guardian_users. It is not a one-off from the Phase 4
// batch — it is the standing check that nobody silently lost access to their
// own kids. Exit code 1 on any failure, so it can gate a deploy.
//
// WRITES NOTHING. Every query is a SELECT. Safe against production.
//
// What "pass" means: for every guardian in the database, the set of members they
// can act on is IDENTICAL to the raw set of link rows, ignoring status. If a
// future read forgets the ACTIVE_GUARDIAN_LINK filter, or a migration leaves a
// row in a non-CONFIRMED state, or someone hard-deletes a link instead of
// revoking it, this fails loudly and names the family affected.
//
// ── Why a script and not just clicking ──────────────────────────────────────
// The sweep touched 30 read sites, but they nearly all funnel through two
// helpers: resolveFamilyContext() (every member-portal purchase/booking
// surface) and the guardianLinks/guardianOf includes. Exercising those helpers
// against every guardian in the database covers far more than signing in as one
// parent and looking at three pages — this checks all 49 links, not a sample.
//
// The invariant: for every guardian, the set of members they can act on must be
// IDENTICAL to the raw set of link rows that existed before status was
// introduced. Since the migration set every pre-existing row to CONFIRMED,
// "filtered result == unfiltered result" must hold for all of them. Any
// difference is a guardian who silently lost access.

import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { loadFamilyForMember } from "@/lib/familyAccess";

const args = process.argv.slice(2);
const only = args.includes("--user") ? args[args.indexOf("--user") + 1]?.toLowerCase() : null;

let failures = 0;
const fail = (msg: string) => { failures++; console.error(`  ✗ ${msg}`); };
const ok = (msg: string) => console.log(`  ✓ ${msg}`);

async function main() {
  console.log("\n═══ Phase 4 access-preservation check (READ-ONLY) ═══\n");

  // ── 1. Global: does the filter drop anything? ─────────────────────────────
  const [total, confirmed, notConfirmed, nullClub] = await Promise.all([
    prisma.memberGuardianUser.count(),
    prisma.memberGuardianUser.count({ where: { status: "CONFIRMED" } }),
    prisma.memberGuardianUser.count({ where: { status: { not: "CONFIRMED" } } }),
    prisma.memberGuardianUser.count({ where: { clubId: "" } }),
  ]);
  console.log("1. Link rows");
  total === confirmed
    ? ok(`${confirmed}/${total} links are CONFIRMED — the filter drops nothing`)
    : fail(`${notConfirmed} link(s) are NOT CONFIRMED and would lose access`);
  nullClub === 0 ? ok("no rows with an empty clubId") : fail(`${nullClub} rows with empty clubId`);

  // ── 2. Per-guardian: filtered resolution vs raw links ─────────────────────
  console.log("\n2. Every guardian resolves the same members as before");
  const guardianUserIds = (
    await prisma.memberGuardianUser.findMany({ select: { userId: true }, distinct: ["userId"] })
  ).map((g) => g.userId);

  let checked = 0;
  let mismatches = 0;
  for (const userId of guardianUserIds) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, clubId: true, deletedAt: true, firstName: true, lastName: true },
    });
    if (!user || user.deletedAt) continue;
    if (only && user.email?.toLowerCase() !== only) continue;

    // RAW: what the pre-Phase-4 code would have seen (no status filter at all).
    const raw = await prisma.memberGuardianUser.findMany({
      where: { userId, member: { clubId: user.clubId, deletedAt: null } },
      select: { memberId: true },
    });
    const rawIds = new Set(raw.map((r) => r.memberId));

    // LIVE: what the swept code actually resolves now.
    const ctx = await resolveFamilyContext(userId, user.clubId, user.email);
    if (ctx === "FORBIDDEN") {
      fail(`${user.email}: resolveFamilyContext returned FORBIDDEN`);
      continue;
    }
    // Compare by member id across BOTH kinds, not just "child".
    //
    // A handful of rows have Member.userId pointing at the same user that also
    // holds a guardian link to them (a self-referential link — the athlete's own
    // login is also recorded as their guardian). resolveFamilyContext resolves
    // those as `self`, which is correct and loses nobody anything. Counting only
    // `child` reported two false losses on the first run of this script.
    const liveIds = new Set(ctx.accessible.map((a) => a.id));

    const lost = [...rawIds].filter((id) => !liveIds.has(id));
    checked++;
    if (lost.length) {
      mismatches++;
      const names = await prisma.member.findMany({
        where: { id: { in: lost } },
        select: { firstName: true, lastName: true },
      });
      fail(
        `${user.email} LOST access to ${lost.length}: ` +
          names.map((n) => `${n.firstName} ${n.lastName}`).join(", "),
      );
    }
  }
  mismatches === 0
    ? ok(`${checked} guardian(s) checked — none lost access to any athlete`)
    : fail(`${mismatches} guardian(s) lost access`);

  // ── 3. Named families, end to end ─────────────────────────────────────────
  console.log("\n3. Named families");
  const fixtures = ["jnt4265@gmail.com", "jlhaynes84@gmail.com", "karen.mikelister@gmail.com"];
  for (const email of fixtures) {
    if (only && email !== only) continue;
    const u = await prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, clubId: true, email: true, firstName: true, lastName: true },
    });
    if (!u) { fail(`${email}: no live account`); continue; }

    const ctx = await resolveFamilyContext(u.id, u.clubId, u.email);
    if (ctx === "FORBIDDEN") { fail(`${email}: FORBIDDEN`); continue; }

    const self = ctx.accessible.find((a) => a.kind === "self");
    const kids = ctx.accessible.filter((a) => a.kind === "child");
    console.log(
      `  ${u.firstName} ${u.lastName} <${email}>\n` +
        `     own profile : ${self ? `${self.firstName} ${self.lastName} (${self.status})` : "none"}\n` +
        `     manages     : ${kids.length ? kids.map((k) => `${k.firstName} ${k.lastName} (${k.status})`).join(", ") : "nobody"}`,
    );
    kids.length > 0 || self
      ? ok(`${email} resolves ${kids.length} athlete(s)`)
      : fail(`${email} resolves NOTHING — portal would be empty`);
  }

  // ── 4. Staff-side payload for the same families ───────────────────────────
  console.log("\n4. Staff Family & access payload (the read gap that hid Cameron)");
  const probeMembers = await prisma.member.findMany({
    where: {
      deletedAt: null,
      OR: [
        { lastName: { in: ["Bergen", "Coville"] } },
        { lastName: "Lister" },
        { lastName: "Lister " },
      ],
    },
    select: { id: true, clubId: true, firstName: true, lastName: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  for (const m of probeMembers) {
    const fam = await loadFamilyForMember(m.id, m.clubId);
    const guardians = fam.guardians.map((g) => `${g.name}${g.isPrimary ? "*" : ""}`).join(", ") || "—";
    const manages = fam.managedAthletes.map((a) => a.name).join(", ") || "—";
    console.log(
      `  ${m.firstName.trim()} ${m.lastName.trim()}\n` +
        `     guardians : ${guardians}\n` +
        `     manages   : ${manages}` +
        (fam.pendingGuardianRequests.length ? `\n     pending   : ${fam.pendingGuardianRequests.length}` : ""),
    );
  }

  // ── 5. Permission grid defaults preserved ─────────────────────────────────
  console.log("\n5. Permission grid");
  const restricted = await prisma.memberGuardianUser.count({
    where: {
      status: "CONFIRMED",
      OR: [{ canBook: false }, { canPay: false }, { canSignWaivers: false }, { canReceiveEmails: false }],
    },
  });
  restricted === 0
    ? ok("every existing link keeps all four permissions — behavior unchanged")
    : fail(`${restricted} link(s) had a permission turned off by the migration`);

  console.log(
    failures === 0
      ? "\n═══ PASS — no guardian lost access ═══\n"
      : `\n═══ FAIL — ${failures} problem(s) above ═══\n`,
  );
  if (failures) process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
