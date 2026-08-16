// Family-shape corrections (plan §7.4). DRY-RUN by default. Julian runs these
// from his own terminal — the Claude Code sandbox cannot reach the database,
// and the Supabase MCP is read-only.
//
//   npx tsx scripts/fix-family-shapes.ts                          # survey everything
//   npx tsx scripts/fix-family-shapes.ts --only CHILD_EMAIL
//   npx tsx scripts/fix-family-shapes.ts --only CHILD_EMAIL --apply --members <id|email>,…
//   npx tsx scripts/fix-family-shapes.ts --only SELF_GUARDIAN --apply \
//        --members <one id> --parent-email <addr> [--parent-name "First Last"]
//   npx tsx scripts/fix-family-shapes.ts --only DETACHED_MINOR --apply \
//        --members <one id> --parent-name "First Last"
//   npx tsx scripts/fix-family-shapes.ts --only ORPHAN_MINORS --apply --members <id>,…
//
// --apply REFUSES without an explicit --members allowlist. Nothing is ever
// hard-deleted; every write leaves a BillingAuditLog row; the script re-reads
// and re-surveys after applying.
//
// ── THE MODES ────────────────────────────────────────────────────────────────
//
//  SELF_GUARDIAN  Shape A — `Member.userId` is ALSO a guardian link on that same
//                 member, so one User is the athlete, the athlete's login AND
//                 the athlete's guardian. `applyParentalControls` keys oversight
//                 on `member.userId !== bookerUserId`, so controls are inverted
//                 for these members, and a sibling can never attach because
//                 `Member.userId` is globally unique.
//                 Splitting it needs a PER-FAMILY decision about which address
//                 the parent keeps, so this mode takes exactly ONE member per
//                 run and refuses a sweep.
//
//  DETACHED_MINOR Shape E — a minor BY DATE OF BIRTH holding their own portal
//                 login with NO guardian of any kind: no link, no guardianEmail,
//                 no Guardian profile. AJ Dorn's shape minus the guardian link,
//                 which is why SELF_GUARDIAN cannot see it. The live case is a
//                 four-year-old whose login is named after him but whose email
//                 is plainly a parent's — carrying a live Stripe subscription
//                 and a liability waiver recorded as signed by the child.
//                 The login is NOT the child's; it is the parent's account
//                 wearing the child's name. So it is renamed to the parent,
//                 detached from the child, and linked as guardian — never
//                 deleted. One member per run, and --parent-name is required
//                 because the parent's name is not recoverable from the data.
//
//  CHILD_EMAIL    Shape C — a minor whose own `Member.email` equals their
//                 `guardianEmail`. The parent's address is sitting on the child
//                 row. Not broken on its own, but it is the precondition that
//                 turns a signup into shape A. Moves the address to
//                 `guardianEmail` only. Safe to batch; still allowlisted.
//
//  ORPHAN_MINORS  Shape D — a minor with no CONFIRMED guardian link whose
//                 `guardianEmail` matches a live User. Creates the link on the
//                 owner-vouched rule `requestGuardianLink` already enforces
//                 (the owner typed that address into `Member.guardianEmail`).
//                 Where no account exists we leave it alone — that is an invite
//                 to send, not a repair to make.
//
//  AJ_DUPLICATE   Two Member rows for one athlete. This script REFUSES to merge
//                 and prints what to do instead: the confirmation-gated merge at
//                 /dashboard/members/duplicates preserves history, and a
//                 hand-rolled merge here would not.
//
// ── ORDERING IS ENFORCED, NOT DOCUMENTED ─────────────────────────────────────
//
//  SELF_GUARDIAN and DETACHED_MINOR must both be finished before ORPHAN_MINORS
//  runs. A conflated account's `guardianEmail` points at itself, so the orphan
//  sweep would look at it, find a "live User" with a matching address, and
//  re-create the exact self-guardian link the split just removed. A detached
//  minor's login is really the parent's, so linking before it is renamed and
//  detached attaches the child to an account that is about to change hands.
//
//  So ORPHAN_MINORS --apply COUNTS both populations first and exits non-zero if
//  any remain. It is a live-data check, not a flag the caller can forget or lie
//  about.
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();
const args = process.argv.slice(2);

function flag(name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] ?? null : null;
}

const APPLY = args.includes("--apply");
const ONLY = (flag("--only") || "").toUpperCase();
const CLUB_SLUG = flag("--club");
const PARENT_EMAIL = (flag("--parent-email") || "").trim().toLowerCase();
const PARENT_NAME = (flag("--parent-name") || "").trim();

const MODES = ["SELF_GUARDIAN", "DETACHED_MINOR", "CHILD_EMAIL", "ORPHAN_MINORS", "AJ_DUPLICATE"] as const;
type Mode = (typeof MODES)[number];

// The canonical sequence. SELF_GUARDIAN and DETACHED_MINOR lead because
// ORPHAN_MINORS is unsafe until both are done; AJ_DUPLICATE is last because it
// is a hand-off, not a write.
const ORDER: Mode[] = ["SELF_GUARDIAN", "DETACHED_MINOR", "CHILD_EMAIL", "ORPHAN_MINORS", "AJ_DUPLICATE"];

if (ONLY && !MODES.includes(ONLY as Mode)) {
  console.error(`Unknown --only ${ONLY}. Expected one of: ${MODES.join(", ")}`);
  process.exit(1);
}
const selected: Mode[] = ONLY ? [ONLY as Mode] : ORDER;

const membersArg = flag("--members");
const allow = new Set(
  (membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

if (APPLY && allow.size === 0) {
  console.error("--apply requires an explicit --members <id|email>,… allowlist. Run the survey first.");
  process.exit(1);
}
if (APPLY && !ONLY) {
  console.error("--apply requires --only <MODE>. Applying several shapes in one command hides which write did what.");
  process.exit(1);
}

type SelfGuardian = {
  mode: "SELF_GUARDIAN";
  memberId: string;
  name: string;
  clubId: string;
  userId: string;
  userEmail: string;
  userName: string;
  linkIds: string[];
};
type DetachedMinor = {
  mode: "DETACHED_MINOR";
  memberId: string;
  name: string;
  clubId: string;
  age: number;
  userId: string;
  userEmail: string;
  userName: string;
  memberEmail: string | null;
  liveSubscriptions: number;
  selfSignedGuardianDocs: number;
};
type ChildEmail = {
  mode: "CHILD_EMAIL";
  memberId: string;
  name: string;
  clubId: string;
  email: string;
};
type OrphanMinor = {
  mode: "ORPHAN_MINORS";
  memberId: string;
  name: string;
  clubId: string;
  guardianEmail: string;
  guardianUserId: string;
  guardianName: string;
};
type AjDuplicate = {
  mode: "AJ_DUPLICATE";
  memberId: string;
  name: string;
  clubId: string;
  otherId: string;
  otherName: string;
  detail: string;
};
type Action = SelfGuardian | DetachedMinor | ChildEmail | OrphanMinor | AjDuplicate;

/** Age at a given moment. Local copy so the script stays dependency-free. */
function ageAt(dob: Date, at: Date): number {
  let age = at.getFullYear() - dob.getFullYear();
  const m = at.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && at.getDate() < dob.getDate())) age -= 1;
  return age;
}

async function clubFilter(): Promise<{ clubId?: string }> {
  if (!CLUB_SLUG) return {};
  const club = await prisma.club.findUnique({ where: { slug: CLUB_SLUG }, select: { id: true } });
  if (!club) {
    console.error(`No club with slug "${CLUB_SLUG}".`);
    process.exit(1);
  }
  return { clubId: club.id };
}

// ── Detection ────────────────────────────────────────────────────────────────

async function collectSelfGuardian(where: { clubId?: string }): Promise<SelfGuardian[]> {
  const candidates = await prisma.member.findMany({
    where: { ...where, deletedAt: null, userId: { not: null } },
    select: {
      id: true,
      clubId: true,
      firstName: true,
      lastName: true,
      userId: true,
      user: { select: { email: true, firstName: true, lastName: true } },
      guardianLinks: { select: { id: true, userId: true, status: true } },
    },
  });
  const out: SelfGuardian[] = [];
  for (const m of candidates) {
    // Any link status counts: a PENDING or REVOKED self-link is the same
    // conflated identity and will be re-confirmed by the next approval.
    const selfLinks = m.guardianLinks.filter((l) => l.userId === m.userId);
    if (selfLinks.length === 0) continue;
    out.push({
      mode: "SELF_GUARDIAN",
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      userId: m.userId!,
      userEmail: m.user?.email ?? "?",
      userName: `${m.user?.firstName ?? ""} ${m.user?.lastName ?? ""}`.trim(),
      linkIds: selfLinks.map((l) => l.id),
    });
  }
  return out;
}

/**
 * Shape E — a minor BY DATE OF BIRTH who holds their own portal login and has
 * NO guardian of any kind: no link, no guardianEmail, no Guardian profile.
 *
 * This is AJ Dorn's shape minus the guardian link, which is exactly why
 * SELF_GUARDIAN cannot see it — there is no self-link to detect. The live case
 * is a FOUR-YEAR-OLD whose `User` row is named after him but whose email is
 * plainly a parent's, carrying a live Stripe subscription, 18 attendance
 * records, and a liability waiver recorded as signed by the child himself.
 *
 * The login is not the child's. It is the parent's account wearing the child's
 * name, so the repair is to rename it to the parent, detach it from the child,
 * and link it as guardian — never to delete it.
 */
async function collectDetachedMinor(where: { clubId?: string }): Promise<DetachedMinor[]> {
  const candidates = await prisma.member.findMany({
    where: {
      ...where,
      deletedAt: null,
      userId: { not: null },
      dateOfBirth: { not: null },
    },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, userId: true,
      dateOfBirth: true, email: true, guardianEmail: true, guardianId: true,
      user: { select: { email: true, firstName: true, lastName: true, deletedAt: true } },
      guardianLinks: { select: { id: true } },
      subscriptions: { where: { status: "active" }, select: { id: true } },
    },
  });
  const now = new Date();
  const out: DetachedMinor[] = [];
  for (const m of candidates) {
    if (!m.user || m.user.deletedAt) continue;
    const age = ageAt(m.dateOfBirth!, now);
    if (age >= 18) continue;
    // Any guardian at all disqualifies: a link, a named guardian email, or a
    // Guardian profile. Those are ORPHAN_MINORS / CHILD_EMAIL territory.
    if (m.guardianLinks.length > 0) continue;
    if ((m.guardianEmail || "").trim()) continue;
    if (m.guardianId) continue;

    const selfSignedGuardianDocs = await prisma.documentSignature.count({
      where: { memberId: m.id, relationship: "SELF", document: { requiresGuardianSignature: true } },
    });
    out.push({
      mode: "DETACHED_MINOR",
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      age,
      userId: m.userId!,
      userEmail: m.user.email,
      userName: `${m.user.firstName} ${m.user.lastName}`.trim(),
      memberEmail: m.email,
      liveSubscriptions: m.subscriptions.length,
      selfSignedGuardianDocs,
    });
  }
  return out;
}

async function collectChildEmail(where: { clubId?: string }): Promise<ChildEmail[]> {
  const minors = await prisma.member.findMany({
    where: {
      ...where,
      deletedAt: null,
      isMinor: true,
      email: { not: null },
      guardianEmail: { not: null },
    },
    select: { id: true, clubId: true, firstName: true, lastName: true, email: true, guardianEmail: true },
  });
  return minors
    .filter((m) => m.email!.trim().toLowerCase() === m.guardianEmail!.trim().toLowerCase())
    .map((m) => ({
      mode: "CHILD_EMAIL" as const,
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      email: m.email!,
    }));
}

async function collectOrphanMinors(where: { clubId?: string }): Promise<OrphanMinor[]> {
  const minors = await prisma.member.findMany({
    where: {
      ...where,
      deletedAt: null,
      isMinor: true,
      guardianEmail: { not: null },
      guardianLinks: { none: { status: "CONFIRMED" } },
    },
    select: { id: true, clubId: true, firstName: true, lastName: true, guardianEmail: true },
  });
  const out: OrphanMinor[] = [];
  for (const m of minors) {
    const email = m.guardianEmail!.trim().toLowerCase();
    if (!email) continue;
    const guardian = await prisma.user.findUnique({
      where: { clubId_email: { clubId: m.clubId, email } },
      select: { id: true, firstName: true, lastName: true, deletedAt: true },
    });
    // No account behind the address = an invite to send, not a repair to make.
    if (!guardian || guardian.deletedAt) continue;
    out.push({
      mode: "ORPHAN_MINORS",
      memberId: m.id,
      clubId: m.clubId,
      name: `${m.firstName} ${m.lastName ?? ""}`.trim(),
      guardianEmail: email,
      guardianUserId: guardian.id,
      guardianName: `${guardian.firstName} ${guardian.lastName}`.trim(),
    });
  }
  return out;
}

/**
 * Same athlete, two Member rows. Detected on (clubId, first name, last name)
 * among live members — deliberately narrow. DOB is NOT part of the key, because
 * the case this exists for (Adam Dorn imported 2011-09-15 vs Adam (AJ) Dorn
 * self-signed-up 2012-09-15) has two different DOBs, which is exactly why the
 * self-signup failed to match the import in the first place.
 */
async function collectAjDuplicate(where: { clubId?: string }): Promise<AjDuplicate[]> {
  const members = await prisma.member.findMany({
    where: { ...where, deletedAt: null },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, dateOfBirth: true,
      migrationStatus: true, userId: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const byKey = new Map<string, typeof members>();
  for (const m of members) {
    // "Adam (AJ) Dorn" and "Adam Dorn" share a key once parentheticals go.
    const first = m.firstName.replace(/\([^)]*\)/g, " ").trim().toLowerCase().split(/\s+/)[0] ?? "";
    const key = `${m.clubId}|${first}|${(m.lastName ?? "").trim().toLowerCase()}`;
    byKey.set(key, [...(byKey.get(key) ?? []), m]);
  }
  const out: AjDuplicate[] = [];
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    const [keep, ...rest] = group;
    for (const dup of rest) {
      out.push({
        mode: "AJ_DUPLICATE",
        memberId: keep.id,
        clubId: keep.clubId,
        name: `${keep.firstName} ${keep.lastName ?? ""}`.trim(),
        otherId: dup.id,
        otherName: `${dup.firstName} ${dup.lastName ?? ""}`.trim(),
        detail:
          `imported=${keep.migrationStatus ?? "none"}/${dup.migrationStatus ?? "none"} ` +
          `dob=${keep.dateOfBirth?.toISOString().slice(0, 10) ?? "?"}/${dup.dateOfBirth?.toISOString().slice(0, 10) ?? "?"}`,
      });
    }
  }
  return out;
}

async function collect(mode: Mode, where: { clubId?: string }): Promise<Action[]> {
  if (mode === "SELF_GUARDIAN") return collectSelfGuardian(where);
  if (mode === "DETACHED_MINOR") return collectDetachedMinor(where);
  if (mode === "CHILD_EMAIL") return collectChildEmail(where);
  if (mode === "ORPHAN_MINORS") return collectOrphanMinors(where);
  return collectAjDuplicate(where);
}

// ── Allowlist ────────────────────────────────────────────────────────────────

async function allowed(memberId: string, name: string): Promise<boolean> {
  if (allow.has(memberId.toLowerCase())) return true;
  if (allow.has(name.toLowerCase())) return true;
  const m = await prisma.member.findUnique({ where: { id: memberId }, select: { email: true } });
  return !!(m?.email && allow.has(m.email.toLowerCase()));
}

// ── Reporting ────────────────────────────────────────────────────────────────

function describe(a: Action): string {
  switch (a.mode) {
    case "SELF_GUARDIAN":
      return `SELF_GUARDIAN ${a.name} (${a.memberId}): User ${a.userEmail} ("${a.userName}") is the athlete, the athlete's login AND the athlete's guardian — ${a.linkIds.length} self-link(s). Needs --parent-email.`;
    case "DETACHED_MINOR":
      return (
        `DETACHED_MINOR ${a.name} (${a.memberId}), age ${a.age}: holds login ${a.userEmail} ("${a.userName}") ` +
        `with NO guardian of any kind. ${a.liveSubscriptions} live subscription(s), ` +
        `${a.selfSignedGuardianDocs} guardian-required doc(s) recorded as self-signed. Needs --parent-name.`
      );
    case "CHILD_EMAIL":
      return `CHILD_EMAIL    ${a.name} (${a.memberId}): child's own email == guardianEmail (${a.email}) → clear Member.email, keep guardianEmail`;
    case "ORPHAN_MINORS":
      return `ORPHAN_MINORS  ${a.name} (${a.memberId}): guardianEmail ${a.guardianEmail} has a live account (${a.guardianName}) → create CONFIRMED guardian link`;
    case "AJ_DUPLICATE":
      return `AJ_DUPLICATE   ${a.name} (${a.memberId}) ↔ ${a.otherName} (${a.otherId}) [${a.detail}] — NOT repaired here, see below`;
  }
}

// ── Writes ───────────────────────────────────────────────────────────────────

async function applySelfGuardian(a: SelfGuardian) {
  if (!PARENT_EMAIL) {
    console.error(
      `\nSELF_GUARDIAN needs --parent-email: whose address does the PARENT keep going forward?\n` +
        `  The conflated account is ${a.userEmail} ("${a.userName}"), currently ${a.name}'s athlete record,\n` +
        `  their login, and their guardian all at once.\n\n` +
        `  --parent-email ${a.userEmail}      → that account becomes the PARENT's (recommended when the\n` +
        `                                         address is the parent's own inbox, as in the Dorn case).\n` +
        `                                         The child keeps no login. Add --parent-name "First Last"\n` +
        `                                         to take the login off the child's name.\n` +
        `  --parent-email <other address>     → the existing account is genuinely the CHILD's; a separate\n` +
        `                                         parent account takes over the guardian link.`,
    );
    process.exit(1);
  }

  const before = {
    memberUserId: a.userId,
    userEmail: a.userEmail,
    userName: a.userName,
    selfLinks: a.linkIds.length,
  };

  if (PARENT_EMAIL === a.userEmail.toLowerCase()) {
    // (a) The account is the parent's. The child loses the login it should
    // never have held; the guardian link stays and becomes truthful.
    if (!PARENT_NAME) {
      console.error(
        `--parent-name is required when the parent keeps ${a.userEmail}: the login is currently named ` +
          `"${a.userName}" after the child, and leaving it that way is half the confusion.`,
      );
      process.exit(1);
    }
    const [first, ...rest] = PARENT_NAME.split(/\s+/).filter(Boolean);
    await prisma.member.update({ where: { id: a.memberId }, data: { userId: null } });
    await prisma.user.update({
      where: { id: a.userId },
      data: { firstName: first, lastName: rest.join(" ") || "" },
    });
    for (const linkId of a.linkIds) {
      await prisma.memberGuardianUser.update({
        where: { id: linkId },
        data: { status: "CONFIRMED", confirmedAt: new Date(), relationship: "Parent" },
      });
    }
    await prisma.billingAuditLog.create({
      data: {
        clubId: a.clubId,
        memberId: a.memberId,
        actorUserId: null,
        action: "SELF_GUARDIAN_SPLIT",
        before,
        after: { memberUserId: null, userEmail: a.userEmail, userName: PARENT_NAME, guardianLink: "CONFIRMED" },
        note:
          `Owner-approved (§7.4): the conflated account keeps ${a.userEmail} as the PARENT's login, renamed to ` +
          `"${PARENT_NAME}". ${a.name} no longer holds a portal login; the guardian link now points parent → child. ` +
          `Parental controls apply again, and a sibling can attach.`,
      },
    });
    return;
  }

  // (b) The account is genuinely the child's; the parent needs their own.
  const existing = await prisma.user.findUnique({
    where: { clubId_email: { clubId: a.clubId, email: PARENT_EMAIL } },
    select: { id: true, deletedAt: true },
  });
  let parentUserId: string;
  if (existing && !existing.deletedAt) {
    parentUserId = existing.id;
  } else {
    const [first, ...rest] = (PARENT_NAME || "Parent Guardian").split(/\s+/).filter(Boolean);
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const created = await prisma.user.upsert({
      where: { clubId_email: { clubId: a.clubId, email: PARENT_EMAIL } },
      update: { deletedAt: null, resetToken: inviteToken, resetExpires: new Date(Date.now() + 14 * 864e5) },
      create: {
        clubId: a.clubId,
        email: PARENT_EMAIL,
        // Unusable secret — the parent sets their own password from the invite.
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 12),
        firstName: first,
        lastName: rest.join(" ") || "",
        role: "MEMBER",
        resetToken: inviteToken,
        resetExpires: new Date(Date.now() + 14 * 864e5),
      },
      select: { id: true },
    });
    parentUserId = created.id;
    console.log(
      `    created parent account ${PARENT_EMAIL} — send them: /reset-password?token=${inviteToken} (14 days)`,
    );
  }

  // Move the link rather than deleting and re-creating it: the row carries
  // createdAt, which is what `ensurePrimaryGuardian` orders by.
  for (const linkId of a.linkIds) {
    const clash = await prisma.memberGuardianUser.findFirst({
      where: { memberId: a.memberId, userId: parentUserId },
      select: { id: true },
    });
    if (clash) {
      await prisma.memberGuardianUser.delete({ where: { id: linkId } });
      await prisma.memberGuardianUser.update({
        where: { id: clash.id },
        data: { status: "CONFIRMED", confirmedAt: new Date(), isPrimary: true },
      });
    } else {
      await prisma.memberGuardianUser.update({
        where: { id: linkId },
        data: { userId: parentUserId, status: "CONFIRMED", confirmedAt: new Date(), isPrimary: true },
      });
    }
  }
  await prisma.member.update({
    where: { id: a.memberId },
    data: { guardianEmail: PARENT_EMAIL, ...(PARENT_NAME ? { guardianName: PARENT_NAME } : {}) },
  });
  await prisma.billingAuditLog.create({
    data: {
      clubId: a.clubId,
      memberId: a.memberId,
      actorUserId: null,
      action: "SELF_GUARDIAN_SPLIT",
      before,
      after: { memberUserId: a.userId, guardianUserId: parentUserId, guardianEmail: PARENT_EMAIL },
      note:
        `Owner-approved (§7.4): ${a.name} keeps their own login (${a.userEmail}); the guardian link moved to a ` +
        `separate parent account (${PARENT_EMAIL}). The member is no longer their own guardian, so parental ` +
        `controls apply again.`,
    },
  });
}

async function applyDetachedMinor(a: DetachedMinor) {
  if (!PARENT_NAME) {
    console.error(
      `\nDETACHED_MINOR needs --parent-name.\n\n` +
        `  ${a.name} is ${a.age} and holds the login ${a.userEmail}, which is named "${a.userName}"\n` +
        `  after the child. That address is the PARENT's — a ${a.age}-year-old does not own it — so the\n` +
        `  repair renames the account to the parent, detaches it from ${a.name}, and links it as their\n` +
        `  guardian. Nothing is deleted and the login keeps working.\n\n` +
        `  Ask the family whose account it is, then re-run with --parent-name "First Last".`,
    );
    process.exit(1);
  }
  const [first, ...rest] = PARENT_NAME.split(/\s+/).filter(Boolean);
  const parentEmail = (PARENT_EMAIL || a.userEmail).toLowerCase();
  if (parentEmail !== a.userEmail.toLowerCase()) {
    console.error(
      `--parent-email ${parentEmail} does not match the login on this record (${a.userEmail}).\n` +
        `DETACHED_MINOR repairs the account that is already there; pointing it at a different address\n` +
        `is a different operation. Drop --parent-email, or fix the record by hand.`,
    );
    process.exit(1);
  }

  const before = {
    memberUserId: a.userId,
    memberEmail: a.memberEmail,
    memberIsMinor: false,
    userName: a.userName,
    guardianLinks: 0,
  };

  // ONE transaction. The ordering inside matters and is the whole point:
  // the guardian link is created BEFORE the child's userId is cleared, so the
  // parent never loses portal access; and the userId is cleared in the same
  // transaction, so the child is never — even momentarily — their own guardian.
  await prisma.$transaction(async (tx) => {
    const guardian = await tx.guardian.upsert({
      where: { clubId_email: { clubId: a.clubId, email: parentEmail } },
      update: { firstName: first, lastName: rest.join(" ") || "", userId: a.userId },
      create: {
        clubId: a.clubId,
        firstName: first,
        lastName: rest.join(" ") || "",
        email: parentEmail,
        phone: "",
        userId: a.userId,
      },
    });

    await tx.memberGuardianUser.upsert({
      where: { userId_memberId: { userId: a.userId, memberId: a.memberId } },
      update: { status: "CONFIRMED", confirmedAt: new Date(), isPrimary: true },
      create: {
        clubId: a.clubId,
        userId: a.userId,
        memberId: a.memberId,
        relationship: "Parent",
        status: "CONFIRMED",
        source: "BACKFILL",
        confirmedAt: new Date(),
        isPrimary: true,
      },
    });

    await tx.member.update({
      where: { id: a.memberId },
      data: {
        // The child loses the login they should never have held.
        userId: null,
        // That address is the parent's contact, not the child's own.
        email: null,
        // DOB already said so; the flag now agrees with it.
        isMinor: true,
        guardianId: guardian.id,
        guardianName: PARENT_NAME,
        guardianEmail: parentEmail,
        guardianRelationship: "Parent",
      },
    });

    // Take the login off the child's name.
    await tx.user.update({
      where: { id: a.userId },
      data: { firstName: first, lastName: rest.join(" ") || "" },
    });
  });

  await prisma.billingAuditLog.create({
    data: {
      clubId: a.clubId,
      memberId: a.memberId,
      actorUserId: null,
      action: "DETACHED_MINOR_REPAIRED",
      before,
      after: {
        memberUserId: null,
        memberEmail: null,
        memberIsMinor: true,
        userName: PARENT_NAME,
        guardianUserId: a.userId,
        guardianEmail: parentEmail,
      },
      note:
        `Owner-approved (§7.4): ${a.name} (age ${a.age}) held the login ${a.userEmail}, which was named after ` +
        `the child and had no guardian of any kind. The account was renamed to the parent (${PARENT_NAME}), ` +
        `detached from the child, and linked as their CONFIRMED primary guardian. No subscription, payment, ` +
        `attendance record or document was touched; the login and its password are unchanged.`,
    },
  });

  if (a.selfSignedGuardianDocs > 0) {
    console.log(
      `    NOT FIXED HERE: ${a.selfSignedGuardianDocs} guardian-required document(s) are still recorded as\n` +
        `    signed by ${a.name} themselves. Have the parent re-sign them from /member/documents — the\n` +
        `    signature table is keyed (documentId, memberId) and the sign route upserts, so re-signing\n` +
        `    REPLACES the self-signed row rather than leaving it alongside a correction.`,
    );
  }
  if (a.liveSubscriptions > 0) {
    console.log(
      `    ${a.liveSubscriptions} live subscription(s) untouched — Stripe pointers live on the member row, ` +
        `not the login.`,
    );
  }
}

async function applyChildEmail(a: ChildEmail) {
  const m = await prisma.member.findUnique({
    where: { id: a.memberId },
    select: { email: true, guardianEmail: true, userId: true },
  });
  if (!m) return;
  // Re-check under apply: a row that changed since the survey must not be
  // rewritten on stale evidence.
  if (
    !m.email ||
    !m.guardianEmail ||
    m.email.trim().toLowerCase() !== m.guardianEmail.trim().toLowerCase()
  ) {
    console.log(`    skipped ${a.name} — no longer matches (email/guardianEmail changed since the survey)`);
    return;
  }
  if (m.userId) {
    // The address is doing real work as this member's own login identity.
    // Clearing Member.email is still correct (the login lives on User.email),
    // but say so rather than doing it quietly.
    console.log(`    note: ${a.name} also holds a portal login — Member.email cleared, User.email untouched`);
  }
  await prisma.member.update({ where: { id: a.memberId }, data: { email: null } });
  await prisma.billingAuditLog.create({
    data: {
      clubId: a.clubId,
      memberId: a.memberId,
      actorUserId: null,
      action: "CHILD_EMAIL_MOVED_TO_GUARDIAN",
      before: { memberEmail: a.email, guardianEmail: a.email },
      after: { memberEmail: null, guardianEmail: a.email },
      note:
        "Owner-approved (§7.4): a minor's own Member.email held the parent's address. Cleared it so the guardian " +
        "is the single contact of record (the centralized minor-contact rule). No login, document or payment touched.",
    },
  });
}

async function applyOrphanMinor(a: OrphanMinor) {
  const child = await prisma.member.findUnique({
    where: { id: a.memberId },
    select: { isMinor: true, guardianEmail: true, deletedAt: true },
  });
  if (!child || child.deletedAt) return;
  // Re-assert owner-vouching at write time, exactly as requestGuardianLink
  // does: the owner must have typed THIS address into Member.guardianEmail.
  if (
    !child.isMinor ||
    (child.guardianEmail || "").trim().toLowerCase() !== a.guardianEmail
  ) {
    console.log(`    skipped ${a.name} — guardianEmail no longer vouches ${a.guardianEmail}`);
    return;
  }
  await prisma.memberGuardianUser.upsert({
    where: { userId_memberId: { userId: a.guardianUserId, memberId: a.memberId } },
    update: { status: "CONFIRMED", confirmedAt: new Date() },
    create: {
      clubId: a.clubId,
      userId: a.guardianUserId,
      memberId: a.memberId,
      relationship: "Parent",
      status: "CONFIRMED",
      source: "BACKFILL",
      confirmedAt: new Date(),
    },
  });
  // A member with links but no primary can never have its controls edited.
  const primary = await prisma.memberGuardianUser.findFirst({
    where: { memberId: a.memberId, isPrimary: true, status: "CONFIRMED" },
    select: { id: true },
  });
  if (!primary) {
    const earliest = await prisma.memberGuardianUser.findFirst({
      where: { memberId: a.memberId, status: "CONFIRMED" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (earliest) await prisma.memberGuardianUser.update({ where: { id: earliest.id }, data: { isPrimary: true } });
  }
  await prisma.billingAuditLog.create({
    data: {
      clubId: a.clubId,
      memberId: a.memberId,
      actorUserId: null,
      action: "GUARDIAN_LINK_BACKFILLED",
      before: { guardianLink: null },
      after: { guardianUserId: a.guardianUserId, guardianEmail: a.guardianEmail, status: "CONFIRMED" },
      note:
        `Owner-approved (§7.4): the club already named ${a.guardianEmail} as this minor's guardian, and that ` +
        `address has a live account. Created the CONFIRMED link so the child appears in their parent's portal.`,
    },
  });
}

// ── Ordering gate ────────────────────────────────────────────────────────────

/**
 * ORPHAN_MINORS is unsafe while any shape-A member remains: their
 * `guardianEmail` resolves to their OWN account, so the sweep would re-create
 * the self-guardian link the split just removed. Refuse rather than warn.
 */
async function assertSelfGuardiansResolved(where: { clubId?: string }): Promise<number> {
  const conflated = await collectSelfGuardian(where);
  // DETACHED_MINOR blocks the sweep too, and for a sharper reason: the repair
  // WRITES `guardianEmail` with the parent's address — which is the address
  // already on that member's own login. Sweeping first would set guardianEmail
  // to nothing (there is none yet), but sweeping AFTER a half-done repair, or
  // repairing after a sweep created a link to the wrong account, both leave the
  // child pointing at a login that is about to change hands. Do them first.
  const detached = await collectDetachedMinor(where);
  const remaining = conflated.length + detached.length;
  if (remaining === 0) return 0;
  console.error(
    `\nREFUSING to apply ORPHAN_MINORS: ${remaining} member(s) still need an identity repair first.\n\n` +
      conflated.map((r) => `  - SELF_GUARDIAN  ${r.name} (${r.memberId}) — ${r.userEmail}`).join("\n") +
      (conflated.length && detached.length ? "\n" : "") +
      detached
        .map((r) => `  - DETACHED_MINOR ${r.name} (${r.memberId}), age ${r.age} — ${r.userEmail}`)
        .join("\n") +
      `\n\nA conflated account's guardianEmail points at itself, so this sweep would re-link it to itself and\n` +
      `undo the split. A detached minor's login is really the parent's, so linking before it is renamed\n` +
      `and detached attaches the child to an account that is about to change hands. Run these first:\n\n` +
      `  npx tsx scripts/fix-family-shapes.ts --only SELF_GUARDIAN  --apply --members <id> --parent-email <addr>\n` +
      `  npx tsx scripts/fix-family-shapes.ts --only DETACHED_MINOR --apply --members <id> --parent-name "First Last"\n`,
  );
  return remaining;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const where = await clubFilter();

  console.log(`\n=== ${APPLY ? `APPLY — ${ONLY}` : "SURVEY (dry run)"} ===`);

  for (const mode of selected) {
    const actions = await collect(mode, where);
    console.log(`\n── ${mode} — ${actions.length} row(s) ──`);
    for (const a of actions) {
      const mark = APPLY ? ((await allowed(a.memberId, a.name)) ? "→" : "✗ (not in allowlist)") : "  ";
      console.log(`${mark} ${describe(a)}`);
    }

    if (mode === "AJ_DUPLICATE" && actions.length > 0) {
      console.log(
        `\n  These are NOT repaired by this script, on purpose. Merging moves bookings, documents,\n` +
          `  signatures, transactions and guardian links across a unique-key minefield; the merge at\n` +
          `  /dashboard/members/duplicates already does that safely, is confirmation-gated, lets you pick\n` +
          `  the surviving value field by field, and soft-deletes rather than destroying the loser.\n` +
          `  Open that page and merge each pair there.`,
      );
    }

    if (mode === "ORPHAN_MINORS") {
      const blocked = (await collectSelfGuardian(where)).length + (await collectDetachedMinor(where)).length;
      if (blocked > 0) {
        console.log(
          `\n  BLOCKED: ${blocked} member(s) still need an identity repair, so --apply will refuse for this mode.\n` +
            `  Finish SELF_GUARDIAN and DETACHED_MINOR first — otherwise this sweep links children to logins\n` +
            `  that are about to be renamed or detached.`,
        );
      }
    }

    if (!APPLY || mode !== ONLY) continue;

    if (mode === "ORPHAN_MINORS" && (await assertSelfGuardiansResolved(where)) > 0) {
      process.exit(2);
    }
    if (mode === "AJ_DUPLICATE") {
      console.error("\nAJ_DUPLICATE has no --apply path. Use /dashboard/members/duplicates.");
      process.exit(1);
    }

    const targets: Action[] = [];
    for (const a of actions) if (await allowed(a.memberId, a.name)) targets.push(a);

    if (mode === "SELF_GUARDIAN" && targets.length > 1) {
      console.error(
        `\nSELF_GUARDIAN takes ONE member per run — ${targets.length} matched the allowlist. Each split needs its\n` +
          `own decision about which address the parent keeps, and --parent-email applies to a single family.`,
      );
      process.exit(1);
    }
    if (mode === "DETACHED_MINOR" && targets.length > 1) {
      console.error(
        `\nDETACHED_MINOR takes ONE member per run — ${targets.length} matched the allowlist. --parent-name is a\n` +
          `single family's answer, and these records carry live subscriptions; they are reviewed one at a time.`,
      );
      process.exit(1);
    }

    console.log(`\nApplying ${targets.length} ${mode} action(s)…`);
    for (const a of targets) {
      if (a.mode === "SELF_GUARDIAN") await applySelfGuardian(a);
      if (a.mode === "DETACHED_MINOR") await applyDetachedMinor(a);
      if (a.mode === "CHILD_EMAIL") await applyChildEmail(a);
      if (a.mode === "ORPHAN_MINORS") await applyOrphanMinor(a);
      console.log(`  applied ${a.mode} for ${a.name}`);
    }

    const after = await collect(mode, where);
    console.log(`\nVerified: ${after.length} ${mode} row(s) remain (the allowlist may exclude some).`);
  }

  if (!APPLY) {
    console.log(
      `\nSurvey only — nothing written.\n` +
        `Apply one mode at a time, after owner review:\n` +
        `  --only SELF_GUARDIAN  --apply --members <one id> --parent-email <addr> [--parent-name "First Last"]\n` +
        `  --only DETACHED_MINOR --apply --members <one id> --parent-name "First Last"\n` +
        `  --only CHILD_EMAIL   --apply --members <ids…>\n` +
        `  --only ORPHAN_MINORS --apply --members <ids…>     (refuses until SELF_GUARDIAN is clear)\n`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
