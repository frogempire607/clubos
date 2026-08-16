// Integration tests for scripts/fix-family-shapes.ts (plan §7.4), against the
// local throwaway Postgres. Same discipline as scripts/audience-filters-tests.ts.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//   DIRECT_URL=$DATABASE_URL npx tsx scripts/family-shapes-repair-tests.ts
//
// These drive the REAL CLI as a subprocess and assert on its exit code and on
// what actually landed in the database — not on a re-implementation of its
// logic. The thing most worth proving is the ordering refusal:
//
//   A shape-A member's `guardianEmail` points at their OWN account. So if
//   ORPHAN_MINORS runs while one is still unresolved, the sweep finds a "live
//   User" at that address and re-creates the exact self-guardian link that
//   SELF_GUARDIAN just removed. The repair silently undoes itself.
//
// The script refuses that by COUNTING remaining shape-A rows at apply time,
// which is why these tests can assert a non-zero exit rather than a comment.

import { PrismaClient } from "@prisma/client";
import { execFileSync } from "child_process";
import bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL ?? "";
if (!url.includes(":55432")) {
  console.error("Refusing to run: DATABASE_URL is not the local test database on port 55432.");
  process.exit(1);
}

const prisma = new PrismaClient();
const CLUB = "club_shapes_test";
const SLUG = "frog-empire-shapes";

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

/** Run the CLI. Returns exit code + combined output; never throws. */
function run(...argv: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/fix-family-shapes.ts", "--club", SLUG, ...argv], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

async function seed() {
  const club = await prisma.club.upsert({
    where: { id: CLUB },
    update: {},
    create: { id: CLUB, name: "Shapes Test Club", slug: SLUG },
  });

  const members = await prisma.member.findMany({ where: { clubId: club.id }, select: { id: true } });
  const ids = members.map((m) => m.id);
  await prisma.memberGuardianUser.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.documentSignature.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.memberSubscription.deleteMany({ where: { memberId: { in: ids } } });
  await prisma.billingAuditLog.deleteMany({ where: { clubId: club.id } });
  await prisma.member.deleteMany({ where: { clubId: club.id } });
  await prisma.guardian.deleteMany({ where: { clubId: club.id } });
  await prisma.user.deleteMany({ where: { clubId: club.id } });

  const hash = await bcrypt.hash("localtest123", 10);

  // ── Shape A: AJ Dorn. ONE User that is the athlete, the athlete's login and
  // the athlete's guardian, with the dad's address on every field.
  const ajUser = await prisma.user.create({
    data: {
      id: "u_aj_conflated",
      clubId: club.id,
      email: "dorn@shapes.test",
      passwordHash: hash,
      // The tell: the dad's login is named after his son.
      firstName: "Adam (AJ)",
      lastName: "Dorn",
      role: "MEMBER",
    },
  });
  const aj = await prisma.member.create({
    data: {
      id: "m_aj_conflated",
      clubId: club.id,
      userId: ajUser.id,
      firstName: "Adam (AJ)",
      lastName: "Dorn",
      isMinor: true,
      status: "PROSPECT",
      dateOfBirth: new Date("2012-09-15"),
      email: "dorn@shapes.test",
      guardianName: "Adam j Dorn, Sr",
      guardianEmail: "dorn@shapes.test",
    },
  });
  await prisma.memberGuardianUser.create({
    data: {
      clubId: club.id,
      userId: ajUser.id, // ← the member's OWN login, as their guardian
      memberId: aj.id,
      status: "CONFIRMED",
      source: "CONSENT_TOKEN",
      confirmedAt: new Date(),
      isPrimary: true,
    },
  });

  // The duplicate of AJ — the 2026-07-05 CSV import, different DOB.
  await prisma.member.create({
    data: {
      id: "m_aj_imported",
      clubId: club.id,
      firstName: "Adam",
      lastName: "Dorn",
      isMinor: true,
      status: "PROSPECT",
      migrationStatus: "INVITED",
      dateOfBirth: new Date("2011-09-15"),
      guardianName: "Adam Dorn",
      guardianEmail: "dorn@shapes.test",
    },
  });

  // ── Shape C: the parent's address sitting on the child's own row.
  await prisma.member.create({
    data: {
      id: "m_shapec",
      clubId: club.id,
      firstName: "Aylen",
      lastName: "Grubusic",
      isMinor: true,
      status: "ACTIVE",
      email: "jgrubusicc@shapes.test",
      guardianName: "Jorge Grubusic",
      guardianEmail: "jgrubusicc@shapes.test",
    },
  });

  // ── Shape D: an orphan minor whose guardian DOES have an account.
  const parent = await prisma.user.create({
    data: {
      id: "u_real_parent",
      clubId: club.id,
      email: "patrick@shapes.test",
      passwordHash: hash,
      firstName: "Patrick",
      lastName: "Dwyer",
      role: "MEMBER",
    },
  });
  await prisma.member.create({
    data: {
      id: "m_orphan_linkable",
      clubId: club.id,
      firstName: "Clint",
      lastName: "Dwyer",
      isMinor: true,
      status: "ACTIVE",
      guardianName: "Patrick Dwyer",
      guardianEmail: parent.email,
    },
  });

  // ── Shape D, but with NO account behind the address: an invite to send, not
  // a repair to make. Must never be touched.
  await prisma.member.create({
    data: {
      id: "m_orphan_no_account",
      clubId: club.id,
      firstName: "Andre",
      lastName: "Serra",
      isMinor: true,
      status: "ACTIVE",
      guardianName: "Luis Serra",
      guardianEmail: "luis@nowhere.test",
    },
  });

  // ── Shape E: Zachary Lawell. A FOUR-YEAR-OLD by DOB holding his own portal
  // login, flagged as an adult, with no guardian of any kind — and a live
  // subscription plus a liability waiver recorded as signed by the child.
  // SELF_GUARDIAN cannot see him: there is no self-link, because there is no
  // link at all.
  const parentInbox = await prisma.user.create({
    data: {
      id: "u_lawell_parent_inbox",
      clubId: club.id,
      email: "cclin@shapes.test",
      passwordHash: hash,
      // The tell, again: a parent's inbox wearing the child's name.
      firstName: "Zachary",
      lastName: "Lawell",
      role: "MEMBER",
    },
  });
  const zach = await prisma.member.create({
    data: {
      id: "m_detached_minor",
      clubId: club.id,
      userId: parentInbox.id,
      firstName: "Zachary",
      lastName: "Lawell",
      isMinor: false, // flagged adult — the defect
      status: "ACTIVE",
      dateOfBirth: new Date("2021-12-06"),
      email: "cclin@shapes.test", // the parent's address on the child row
      guardianName: null,
      guardianEmail: null,
    },
  });
  const plan = await prisma.membership.upsert({
    where: { id: "mem_tadpoles" },
    update: {},
    create: {
      id: "mem_tadpoles",
      clubId: club.id,
      name: "Tadpoles",
      options: [{ label: "Monthly", price: 60, billingPeriod: "MONTHLY" }],
    },
  });
  await prisma.memberSubscription.create({
    data: {
      memberId: zach.id,
      membershipId: plan.id,
      status: "active",
      billingType: "RECURRING",
      price: 60,
      optionLabel: "Monthly",
      stripeSubscriptionId: "sub_fake_zach",
    },
  });
  const waiver = await prisma.document.upsert({
    where: { id: "doc_waiver" },
    update: {},
    create: {
      id: "doc_waiver",
      clubId: club.id,
      title: "Liability Waiver",
      type: "WAIVER",
      requiresGuardianSignature: true,
    },
  });
  // A SECOND detached minor, so the one-member-per-run guard is genuinely
  // exercised rather than passing by accident on a single-row fixture.
  const inbox2 = await prisma.user.create({
    data: {
      id: "u_reed_parent_inbox",
      clubId: club.id,
      email: "dreed@shapes.test",
      passwordHash: hash,
      firstName: "Mila",
      lastName: "Reed",
      role: "MEMBER",
    },
  });
  await prisma.member.create({
    data: {
      id: "m_detached_minor_2",
      clubId: club.id,
      userId: inbox2.id,
      firstName: "Mila",
      lastName: "Reed",
      isMinor: false,
      status: "ACTIVE",
      dateOfBirth: new Date("2015-03-11"),
      email: "dreed@shapes.test",
    },
  });

  await prisma.documentSignature.create({
    data: {
      documentId: waiver.id,
      memberId: zach.id,
      signerUserId: parentInbox.id,
      signerName: "Zachary Lawell",
      // The legally worthless record: a four-year-old signing for himself.
      relationship: "SELF",
      signedAt: new Date(),
    },
  });
}

async function selfGuardianCount(): Promise<number> {
  const rows = await prisma.member.findMany({
    where: { clubId: CLUB, deletedAt: null, userId: { not: null } },
    select: { userId: true, guardianLinks: { select: { userId: true } } },
  });
  return rows.filter((m) => m.guardianLinks.some((l) => l.userId === m.userId)).length;
}

async function main() {
  await seed();

  // ── Survey ─────────────────────────────────────────────────────────────────
  console.log("\nSurvey (dry run) finds every shape and writes nothing");
  const survey = run();
  check("survey exits 0", survey.code === 0, survey.out.slice(-400));
  check("finds the self-guardian", /SELF_GUARDIAN Adam \(AJ\) Dorn/.test(survey.out));
  check("finds the child-email row", /CHILD_EMAIL.*Aylen/.test(survey.out));
  check("finds the linkable orphan", /ORPHAN_MINORS.*Clint/.test(survey.out));
  check(
    "does NOT propose the orphan with no account behind the address",
    !/ORPHAN_MINORS.*Andre/.test(survey.out),
  );
  check("finds the duplicate pair", /AJ_DUPLICATE/.test(survey.out) && /Adam/.test(survey.out));
  check("says nothing was written", /nothing written/i.test(survey.out));
  check("the survey changed no rows", (await selfGuardianCount()) === 1);

  // ── The guards ─────────────────────────────────────────────────────────────
  console.log("\n--apply refuses to be vague");
  const noAllow = run("--only", "CHILD_EMAIL", "--apply");
  check("--apply without an allowlist is refused", noAllow.code !== 0);
  check("…and says to run the survey first", /allowlist/i.test(noAllow.out));

  const noMode = run("--apply", "--members", "m_shapec");
  check("--apply without --only is refused", noMode.code !== 0);
  check("…because one command applying several shapes hides which write did what", /--only/.test(noMode.out));

  // ── THE ORDERING REFUSAL ───────────────────────────────────────────────────
  console.log("\nORPHAN_MINORS refuses to run before SELF_GUARDIAN is finished");
  const blockedSurvey = run("--only", "ORPHAN_MINORS");
  check("the dry run warns it will refuse", /BLOCKED/.test(blockedSurvey.out), blockedSurvey.out.slice(-300));

  const outOfOrder = run("--only", "ORPHAN_MINORS", "--apply", "--members", "m_orphan_linkable");
  check("applying out of order exits non-zero", outOfOrder.code === 2, `exit ${outOfOrder.code}`);
  check("…and says why", /REFUSING to apply ORPHAN_MINORS/.test(outOfOrder.out));
  check("…naming the member that blocks it", /Adam \(AJ\) Dorn/.test(outOfOrder.out));
  check("…and printing the command to run first", /--only SELF_GUARDIAN\s+--apply/.test(outOfOrder.out));
  const linkedAnyway = await prisma.memberGuardianUser.count({ where: { memberId: "m_orphan_linkable" } });
  check("…and wrote NOTHING despite being asked to", linkedAnyway === 0, `${linkedAnyway} links created`);

  // ── SELF_GUARDIAN needs a per-family decision ──────────────────────────────
  console.log("\nSELF_GUARDIAN demands the decision it cannot make for you");
  const noParent = run("--only", "SELF_GUARDIAN", "--apply", "--members", "m_aj_conflated");
  check("refuses without --parent-email", noParent.code !== 0);
  check("…and explains both options", /becomes the PARENT's/.test(noParent.out) && /genuinely the CHILD's/.test(noParent.out));

  const noName = run(
    "--only", "SELF_GUARDIAN", "--apply", "--members", "m_aj_conflated",
    "--parent-email", "dorn@shapes.test",
  );
  check("refuses to leave the login named after the child", noName.code !== 0);
  check("…saying so plainly", /named\s+"Adam \(AJ\) Dorn" after the child/.test(noName.out), noName.out.slice(-300));

  // ── The split ──────────────────────────────────────────────────────────────
  console.log("\nSELF_GUARDIAN splits the conflated account");
  const split = run(
    "--only", "SELF_GUARDIAN", "--apply", "--members", "m_aj_conflated",
    "--parent-email", "dorn@shapes.test", "--parent-name", "Adam Dorn Sr",
  );
  check("the split succeeds", split.code === 0, split.out.slice(-400));

  const ajAfter = await prisma.member.findUnique({
    where: { id: "m_aj_conflated" },
    select: { userId: true, guardianLinks: { select: { userId: true, status: true } } },
  });
  check("the child no longer holds a portal login", ajAfter?.userId === null);
  check("the guardian link survives", (ajAfter?.guardianLinks ?? []).length === 1);
  check("…and is CONFIRMED", ajAfter?.guardianLinks?.[0]?.status === "CONFIRMED");
  const userAfter = await prisma.user.findUnique({ where: { id: "u_aj_conflated" }, select: { firstName: true, lastName: true } });
  check(
    "the login is renamed off the child's name",
    `${userAfter?.firstName} ${userAfter?.lastName}` === "Adam Dorn Sr",
    `${userAfter?.firstName} ${userAfter?.lastName}`,
  );
  check("no self-guardian remains", (await selfGuardianCount()) === 0);
  const audit = await prisma.billingAuditLog.findMany({ where: { memberId: "m_aj_conflated" }, select: { action: true } });
  check("an audit row was written", audit.some((a) => a.action === "SELF_GUARDIAN_SPLIT"));

  // ── Now the sweep is allowed ───────────────────────────────────────────────
  // BOTH identity repairs must be done first — that is the enforced order.
  run("--only", "DETACHED_MINOR", "--apply", "--members", "m_detached_minor", "--parent-name", "Christina Lin");
  run("--only", "DETACHED_MINOR", "--apply", "--members", "m_detached_minor_2", "--parent-name", "Dana Reed");
  console.log("\nWith both identity repairs done, ORPHAN_MINORS may run");
  const nowOk = run("--only", "ORPHAN_MINORS", "--apply", "--members", "m_orphan_linkable");
  check("the sweep now succeeds", nowOk.code === 0, nowOk.out.slice(-400));
  const clintLinks = await prisma.memberGuardianUser.findMany({
    where: { memberId: "m_orphan_linkable" },
    select: { userId: true, status: true, isPrimary: true },
  });
  check("the linkable orphan is linked", clintLinks.length === 1);
  check("…to the real parent account", clintLinks[0]?.userId === "u_real_parent");
  check("…as CONFIRMED and primary", clintLinks[0]?.status === "CONFIRMED" && clintLinks[0]?.isPrimary === true);
  const andreLinks = await prisma.memberGuardianUser.count({ where: { memberId: "m_orphan_no_account" } });
  check("the orphan with no account behind the address is untouched", andreLinks === 0);

  // ── CHILD_EMAIL ────────────────────────────────────────────────────────────
  console.log("\nCHILD_EMAIL moves the address off the child row");
  const childEmail = run("--only", "CHILD_EMAIL", "--apply", "--members", "m_shapec");
  check("the move succeeds", childEmail.code === 0, childEmail.out.slice(-300));
  const aylen = await prisma.member.findUnique({
    where: { id: "m_shapec" },
    select: { email: true, guardianEmail: true, status: true },
  });
  check("the child's own email is cleared", aylen?.email === null);
  check("the guardian keeps the address", aylen?.guardianEmail === "jgrubusicc@shapes.test");
  check("nothing else about the member moved", aylen?.status === "ACTIVE");

  // ── AJ_DUPLICATE is a hand-off, not a repair ───────────────────────────────
  console.log("\nAJ_DUPLICATE refuses to merge");
  const dup = run("--only", "AJ_DUPLICATE", "--apply", "--members", "m_aj_conflated");
  check("it has no --apply path", dup.code !== 0);
  check("…and points at the merge UI that preserves history", /dashboard\/members\/duplicates/.test(dup.out));
  const stillTwo = await prisma.member.count({ where: { clubId: CLUB, deletedAt: null, lastName: "Dorn" } });
  check("both Dorn rows are still present", stillTwo === 2, String(stillTwo));

  // ── The other split: the account really is the child's ─────────────────────
  // Not every shape-A member is AJ. Where the athlete genuinely owns the email
  // (a teen with a school address) the fix is the mirror image: the child KEEPS
  // their login and a separate parent account takes over the guardian link.
  console.log("\nSELF_GUARDIAN, when the account genuinely belongs to the child");
  await seed();
  const splitB = run(
    "--only", "SELF_GUARDIAN", "--apply", "--members", "m_aj_conflated",
    "--parent-email", "dad.dorn@shapes.test", "--parent-name", "Adam Dorn Sr",
  );
  check("the split succeeds", splitB.code === 0, splitB.out.slice(-400));
  check("it prints an invite link for the new parent account", /reset-password\?token=/.test(splitB.out));

  const childKept = await prisma.member.findUnique({
    where: { id: "m_aj_conflated" },
    select: { userId: true, guardianEmail: true, guardianName: true, guardianLinks: { select: { userId: true, status: true } } },
  });
  check("the child KEEPS their own login here", childKept?.userId === "u_aj_conflated");
  check("the guardian link moved to a different account", childKept?.guardianLinks?.[0]?.userId !== "u_aj_conflated");
  check("…which is the new parent account", !!childKept?.guardianLinks?.[0]?.userId);
  check("the child's guardianEmail now points at the parent", childKept?.guardianEmail === "dad.dorn@shapes.test");
  check("…and the guardian name is corrected", childKept?.guardianName === "Adam Dorn Sr");
  check("no self-guardian remains", (await selfGuardianCount()) === 0);
  const parentAcct = await prisma.user.findFirst({
    where: { clubId: CLUB, email: "dad.dorn@shapes.test" },
    select: { firstName: true, lastName: true, passwordHash: true, resetToken: true },
  });
  check("the parent account exists", !!parentAcct);
  check("…named after the parent", `${parentAcct?.firstName} ${parentAcct?.lastName}` === "Adam Dorn Sr");
  check("…and cannot be logged into until they set a password", !!parentAcct?.resetToken);

  // ── DETACHED_MINOR — the Zachary Lawell shape ──────────────────────────────
  console.log("\nDETACHED_MINOR — a four-year-old holding his own login");
  await seed();

  const dmSurvey = run("--only", "DETACHED_MINOR");
  check("the survey finds him", /DETACHED_MINOR Zachary Lawell/.test(dmSurvey.out), dmSurvey.out.slice(-400));
  check("…and reports his age", /age 4/.test(dmSurvey.out));
  check("…and the live subscription", /1 live subscription/.test(dmSurvey.out));
  check("…and the self-signed guardian-required doc", /1 guardian-required doc\(s\) recorded as self-signed/.test(dmSurvey.out));
  check(
    "SELF_GUARDIAN does NOT see him (there is no self-link to detect)",
    !/Zachary/.test(run("--only", "SELF_GUARDIAN").out),
  );

  const dmNoName = run("--only", "DETACHED_MINOR", "--apply", "--members", "m_detached_minor");
  check("refuses without --parent-name", dmNoName.code !== 0);
  check("…explaining the login is really the parent's", /That address is the PARENT's/.test(dmNoName.out));

  const dmOk = run(
    "--only", "DETACHED_MINOR", "--apply", "--members", "m_detached_minor",
    "--parent-name", "Christina Lin",
  );
  check("the repair succeeds", dmOk.code === 0, dmOk.out.slice(-500));

  const zachAfter = await prisma.member.findUnique({
    where: { id: "m_detached_minor" },
    select: {
      userId: true, email: true, isMinor: true, guardianEmail: true, guardianName: true, guardianId: true,
      guardianLinks: { select: { userId: true, status: true, isPrimary: true } },
      subscriptions: { select: { status: true, stripeSubscriptionId: true } },
    },
  });
  check("the child no longer holds a login", zachAfter?.userId === null);
  check("the parent's address is off the child row", zachAfter?.email === null);
  check("the flag now agrees with the DOB", zachAfter?.isMinor === true);
  check("a guardian is on record", zachAfter?.guardianEmail === "cclin@shapes.test");
  check("…named", zachAfter?.guardianName === "Christina Lin");
  check("…with a Guardian profile", !!zachAfter?.guardianId);
  check("the guardian link exists and is CONFIRMED + primary",
    zachAfter?.guardianLinks?.[0]?.status === "CONFIRMED" && zachAfter?.guardianLinks?.[0]?.isPrimary === true);
  check("…pointing at the account that was the child's", zachAfter?.guardianLinks?.[0]?.userId === "u_lawell_parent_inbox");

  const loginAfter = await prisma.user.findUnique({
    where: { id: "u_lawell_parent_inbox" },
    select: { firstName: true, lastName: true, email: true, deletedAt: true, passwordHash: true },
  });
  check("the login is renamed off the child's name",
    `${loginAfter?.firstName} ${loginAfter?.lastName}` === "Christina Lin",
    `${loginAfter?.firstName} ${loginAfter?.lastName}`);
  check("the login is NOT deleted", !loginAfter?.deletedAt);
  check("…and its password is unchanged", !!loginAfter?.passwordHash);
  check("the live subscription is untouched",
    zachAfter?.subscriptions?.[0]?.status === "active" &&
      zachAfter?.subscriptions?.[0]?.stripeSubscriptionId === "sub_fake_zach");

  // The waiver is deliberately NOT repaired by the script — it must be re-signed.
  const sigAfter = await prisma.documentSignature.findFirst({
    where: { memberId: "m_detached_minor" },
    select: { relationship: true },
  });
  check("the self-signed waiver is left for the parent to re-sign", sigAfter?.relationship === "SELF");
  check("…and the script says so", /NOT FIXED HERE/.test(dmOk.out));

  const dmAudit = await prisma.billingAuditLog.findMany({
    where: { memberId: "m_detached_minor" }, select: { action: true },
  });
  check("an audit row was written", dmAudit.some((a) => a.action === "DETACHED_MINOR_REPAIRED"));
  check("he no longer appears in the survey", !/Zachary/.test(run("--only", "DETACHED_MINOR").out));

  // ── DETACHED_MINOR blocks the orphan sweep too ─────────────────────────────
  console.log("\nORPHAN_MINORS also refuses while a detached minor remains");
  await seed();
  const blockedByDetached = run("--only", "ORPHAN_MINORS", "--apply", "--members", "m_orphan_linkable");
  check("applying is refused", blockedByDetached.code === 2, `exit ${blockedByDetached.code}`);
  check("…naming the detached minor", /DETACHED_MINOR Zachary Lawell/.test(blockedByDetached.out));
  check("…and the self-guardian", /SELF_GUARDIAN\s+Adam \(AJ\) Dorn/.test(blockedByDetached.out));
  check("…and printing both commands", /--only DETACHED_MINOR --apply/.test(blockedByDetached.out));

  const dmSingle = run(
    "--only", "DETACHED_MINOR", "--apply", "--members", "m_detached_minor,m_detached_minor_2",
    "--parent-name", "Christina Lin",
  );
  check("DETACHED_MINOR refuses TWO members in one run", dmSingle.code !== 0, `exit ${dmSingle.code}`);
  check("…because --parent-name is one family's answer", /ONE member per run/.test(dmSingle.out));
  const untouchedPair = await prisma.member.count({
    where: { id: { in: ["m_detached_minor", "m_detached_minor_2"] }, userId: { not: null } },
  });
  check("…and wrote nothing for either", untouchedPair === 2, `${untouchedPair}/2 still hold logins`);

  // ── Allowlist ──────────────────────────────────────────────────────────────
  console.log("\nThe allowlist is honoured");
  await seed(); // restore the shapes
  const other = run("--only", "CHILD_EMAIL", "--apply", "--members", "m_orphan_linkable");
  check("a member outside the allowlist is skipped", other.code === 0);
  const untouched = await prisma.member.findUnique({ where: { id: "m_shapec" }, select: { email: true } });
  check("…and their row is unchanged", untouched?.email === "jgrubusicc@shapes.test");

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
