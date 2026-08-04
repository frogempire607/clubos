// Family-link corrections (Phase 4B — the Lister/Cameron incident). DRY-RUN by default.
//
//   npx tsx scripts/fix-family-links.ts                            # dry run — report only
//   npx tsx scripts/fix-family-links.ts --audit                    # dry run + full attachment audit
//   npx tsx scripts/fix-family-links.ts --apply --members <id>,… [--actor <userId>]
//
// --apply REFUSES to run without an explicit --members allowlist. Nothing is
// hard-deleted. Names are NEVER auto-corrected — the club confirms spelling
// with the family; this script only reports suspected typos.
//
// ── What went wrong (the shape this script fixes) ────────────────────────────
// Every automatic guardian-link path in the app matches Member.guardianEmail
// against a live User.email. When an athlete's record carries the parent's real
// address in Member.email but a DIFFERENT address in Member.guardianEmail,
// nothing links — and migration activation then MINTS A SECOND ACCOUNT for that
// second address. The family ends up split across two logins, and the staff
// remedy (the Relationships card) writes MemberRelationship, which grants no
// access at all.
//
// ── Actions ──────────────────────────────────────────────────────────────────
//  LINK_GUARDIAN     athlete's own Member.email resolves to a live User that is
//                    not yet a confirmed guardian → create the
//                    MemberGuardianUser link (source STAFF_LINKED).
//  REPOINT_GUARDIAN_EMAIL
//                    Member.guardianEmail points at an address with no live
//                    account while the athlete's own email points at a real
//                    parent login → set guardianEmail to the address the parent
//                    actually uses, so future auto-links work.
//  MERGE_DUPLICATE_LOGIN
//                    a second User exists that holds nothing but guardian links
//                    and signatures for this family → move its attachments to
//                    the canonical login, then SOFT-delete it.
//
// MERGE_DUPLICATE_LOGIN refuses unless the duplicate is genuinely inert:
// no own member row, never logged in, and no attachment outside the
// known-movable set. Anything else and it reports instead of acting.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const AUDIT = args.includes("--audit");
const membersArg = args.includes("--members") ? args[args.indexOf("--members") + 1] : null;
// Optional owner/staff User id recorded as the actor on every audit row written
// by --apply. Supply it so the signature repoint names a human, not a script.
const ACTOR = args.includes("--actor") ? args[args.indexOf("--actor") + 1] : null;
const allow = new Set(
  (membersArg || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
);

if (APPLY && allow.size === 0) {
  console.error("--apply requires an explicit --members <id|email>,… allowlist. Run the dry run first.");
  process.exit(1);
}

const norm = (s: string | null | undefined) => (s || "").trim().toLowerCase();

type Action =
  | {
      kind: "LINK_GUARDIAN";
      memberId: string;
      athlete: string;
      clubId: string;
      userId: string;
      userLabel: string;
      relationship: string | null;
    }
  | {
      kind: "REPOINT_GUARDIAN_EMAIL";
      memberId: string;
      athlete: string;
      from: string | null;
      to: string;
    }
  | {
      kind: "MERGE_DUPLICATE_LOGIN";
      duplicateUserId: string;
      duplicateLabel: string;
      canonicalUserId: string;
      canonicalLabel: string;
      guardianLinkIds: string[];
      signatureIds: string[];
      blockers: string[];
    };

// Every column in the DB that points at a User. Anything the duplicate login is
// attached to that is NOT in MOVABLE below is a blocker — we refuse to retire an
// account whose history we cannot account for.
const MOVABLE = new Set(["member_guardian_users.userId", "document_signatures.signerUserId"]);

async function attachmentsOf(userId: string): Promise<{ ref: string; count: number }[]> {
  // Reflect over information_schema so a future table that references users can
  // never silently escape this audit.
  const rows = await prisma.$queryRaw<{ ref: string; count: bigint }[]>(Prisma.sql`
    SELECT ref, count FROM (
      SELECT c.table_name || '.' || c.column_name AS ref,
        (xpath('/row/c/text()', query_to_xml(
           format('SELECT count(*) AS c FROM %I.%I WHERE %I = %L',
                  c.table_schema, c.table_name, c.column_name, ${userId}),
           false, true, '')))[1]::text::bigint AS count
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name = c.table_name AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.data_type = 'text'
        AND (c.column_name ILIKE '%userid%' OR c.column_name ILIKE '%byid%'
             OR c.column_name IN ('senderId','recipientId','payeeUserId','coachId'))
    ) s WHERE count > 0 ORDER BY ref
  `);
  return rows.map((r) => ({ ref: r.ref, count: Number(r.count) }));
}

async function collect(): Promise<Action[]> {
  const actions: Action[] = [];

  // ── Athletes whose OWN email is a live login that isn't their guardian ──────
  const minors = await prisma.member.findMany({
    where: { deletedAt: null, isMinor: true, email: { not: null } },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true,
      guardianEmail: true, guardianRelationship: true, userId: true,
      guardianLinks: { select: { id: true, userId: true, status: true } },
    },
  });

  for (const m of minors) {
    const candidate = await prisma.user.findFirst({
      where: { clubId: m.clubId, email: norm(m.email), deletedAt: null },
      select: { id: true, email: true, firstName: true, lastName: true },
    });
    // The athlete's own email being their own login is normal, not a defect.
    if (!candidate || candidate.id === m.userId) continue;

    const athlete = `${m.firstName} ${m.lastName}`.trim();
    const userLabel = `${candidate.firstName} ${candidate.lastName}`.trim() + ` <${candidate.email}>`;
    const alreadyLinked = m.guardianLinks.some(
      (g) => g.userId === candidate.id && g.status === "CONFIRMED",
    );

    if (!alreadyLinked) {
      actions.push({
        kind: "LINK_GUARDIAN",
        memberId: m.id, athlete, clubId: m.clubId,
        userId: candidate.id, userLabel,
        relationship: m.guardianRelationship || "GUARDIAN",
      });

      // Only repoint guardianEmail when the address on file resolves to nothing
      // live. If it DOES resolve, that is a real second guardian — leave it.
      if (norm(m.guardianEmail) !== norm(candidate.email)) {
        const onFile = m.guardianEmail
          ? await prisma.user.findFirst({
              where: { clubId: m.clubId, email: norm(m.guardianEmail), deletedAt: null },
              select: { id: true, lastLoginAt: true },
            })
          : null;
        if (!onFile || !onFile.lastLoginAt) {
          actions.push({
            kind: "REPOINT_GUARDIAN_EMAIL",
            memberId: m.id, athlete,
            from: m.guardianEmail, to: norm(candidate.email),
          });
        }
      }
    }

    // ── A dormant duplicate login holding this athlete's guardian link ────────
    for (const link of m.guardianLinks) {
      if (link.userId === candidate.id) continue;
      const dup = await prisma.user.findFirst({
        where: { id: link.userId, deletedAt: null },
        select: {
          id: true, email: true, firstName: true, lastName: true, lastLoginAt: true,
          memberProfile: { select: { id: true } },
        },
      });
      if (!dup) continue;

      const blockers: string[] = [];
      if (dup.memberProfile) blockers.push("has its own member row");
      if (dup.lastLoginAt) blockers.push(`has logged in (${dup.lastLoginAt.toISOString()})`);
      for (const a of await attachmentsOf(dup.id)) {
        if (!MOVABLE.has(a.ref)) blockers.push(`attached to ${a.ref} ×${a.count}`);
      }

      const links = await prisma.memberGuardianUser.findMany({
        where: { userId: dup.id }, select: { id: true },
      });
      const sigs = await prisma.documentSignature.findMany({
        where: { signerUserId: dup.id }, select: { id: true },
      });

      actions.push({
        kind: "MERGE_DUPLICATE_LOGIN",
        duplicateUserId: dup.id,
        duplicateLabel: `${dup.firstName} ${dup.lastName}`.trim() + ` <${dup.email}>`,
        canonicalUserId: candidate.id,
        canonicalLabel: userLabel,
        guardianLinkIds: links.map((l) => l.id),
        signatureIds: sigs.map((s) => s.id),
        blockers,
      });
    }
  }

  return actions;
}

// Suspected old-software typos. REPORTED ONLY — never corrected. The club
// confirms spelling with the family before anything is touched.
async function reportTypos() {
  const members = await prisma.member.findMany({
    where: { deletedAt: null },
    select: { id: true, firstName: true, lastName: true, guardianName: true, guardianEmail: true },
  });

  const flags: string[] = [];
  for (const m of members) {
    const first = m.firstName ?? "";
    const last = m.lastName ?? "";
    if (first !== first.trim() || last !== last.trim()) {
      flags.push(`  ${m.id}  whitespace in name: "${first}" / "${last}"`);
    }
    if (m.guardianName && m.guardianName !== m.guardianName.trim()) {
      flags.push(`  ${m.id}  whitespace in guardianName: "${m.guardianName}"`);
    }
    if (m.guardianName) {
      const parts = m.guardianName.trim().split(/\s+/);
      const guardianLast = norm(parts[parts.length - 1]);
      const athleteLast = norm(last);
      // Near-miss surnames: likely a mistyped guardian name, not a real
      // different surname. Distance 0 = match, >2 = probably a genuinely
      // different family name.
      const d = levenshtein(guardianLast, athleteLast);
      if (d >= 1 && d <= 2) {
        flags.push(`  ${m.id}  guardianName "${m.guardianName}" vs athlete surname "${last}" (edit distance ${d})`);
      }
    }
  }

  console.log(`\n── Suspected old-software typos (${flags.length}) — REPORT ONLY, nothing corrected ──`);
  console.log("Confirm each spelling with the family before changing it.\n");
  flags.forEach((f) => console.log(f));
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

function allowed(a: Action): boolean {
  if (a.kind === "MERGE_DUPLICATE_LOGIN") {
    return allow.has(a.duplicateUserId.toLowerCase()) || allow.has(a.canonicalUserId.toLowerCase());
  }
  return allow.has(a.memberId.toLowerCase());
}

async function main() {
  const actions = await collect();

  console.log(`\n${APPLY ? "APPLY" : "DRY RUN"} — ${actions.length} action(s) found\n`);
  for (const a of actions) {
    switch (a.kind) {
      case "LINK_GUARDIAN":
        console.log(`LINK_GUARDIAN            ${a.athlete} (${a.memberId})`);
        console.log(`                         → grant guardian access to ${a.userLabel}`);
        break;
      case "REPOINT_GUARDIAN_EMAIL":
        console.log(`REPOINT_GUARDIAN_EMAIL   ${a.athlete} (${a.memberId})`);
        console.log(`                         guardianEmail "${a.from}" → "${a.to}"`);
        console.log(`                         (address on file has no live account that has ever signed in)`);
        break;
      case "MERGE_DUPLICATE_LOGIN":
        console.log(`MERGE_DUPLICATE_LOGIN    ${a.duplicateLabel} (${a.duplicateUserId})`);
        console.log(`                         → canonical ${a.canonicalLabel} (${a.canonicalUserId})`);
        console.log(`                         moves ${a.guardianLinkIds.length} guardian link(s), ${a.signatureIds.length} signature(s), then soft-deletes`);
        if (a.blockers.length) {
          console.log(`                         BLOCKED: ${a.blockers.join("; ")}`);
        }
        break;
    }
    if (APPLY && !allowed(a)) console.log(`                         SKIPPED — not in --members allowlist`);
    console.log("");
  }

  await reportTypos();

  if (AUDIT) {
    const ids = new Set(actions.flatMap((a) => (a.kind === "MERGE_DUPLICATE_LOGIN" ? [a.duplicateUserId] : [])));
    for (const id of ids) {
      console.log(`\n── Full attachment audit for user ${id} ──`);
      const rows = await attachmentsOf(id);
      if (!rows.length) console.log("  (nothing attached)");
      rows.forEach((r) => console.log(`  ${MOVABLE.has(r.ref) ? "movable " : "BLOCKER "} ${r.ref} ×${r.count}`));
    }
  }

  if (!APPLY) {
    console.log("\nDry run complete. Nothing was written.");
    console.log("Re-run with --apply --members <id>,… to act on specific rows.\n");
    return;
  }

  for (const a of actions) {
    if (!allowed(a)) continue;

    if (a.kind === "LINK_GUARDIAN") {
      await prisma.memberGuardianUser.upsert({
        where: { userId_memberId: { userId: a.userId, memberId: a.memberId } },
        update: { status: "CONFIRMED", revokedAt: null, confirmedAt: new Date() },
        create: {
          clubId: a.clubId,
          userId: a.userId,
          memberId: a.memberId,
          relationship: a.relationship,
          status: "CONFIRMED",
          source: "STAFF_LINKED",
          confirmedAt: new Date(),
        },
      });
      console.log(`✓ LINK_GUARDIAN ${a.athlete} → ${a.userLabel}`);
    }

    if (a.kind === "REPOINT_GUARDIAN_EMAIL") {
      await prisma.member.update({
        where: { id: a.memberId },
        data: { guardianEmail: a.to },
      });
      console.log(`✓ REPOINT_GUARDIAN_EMAIL ${a.athlete}: "${a.from}" → "${a.to}"`);
    }

    if (a.kind === "MERGE_DUPLICATE_LOGIN") {
      if (a.blockers.length) {
        console.log(`✗ MERGE_DUPLICATE_LOGIN ${a.duplicateLabel} REFUSED — ${a.blockers.join("; ")}`);
        continue;
      }
      await prisma.$transaction(async (tx) => {
        // Guardian links: upsert onto the canonical user, then drop the
        // duplicate's row (the link is a grant, not history — the history is
        // the signature, which is preserved below).
        const links = await tx.memberGuardianUser.findMany({ where: { userId: a.duplicateUserId } });
        for (const l of links) {
          await tx.memberGuardianUser.upsert({
            where: { userId_memberId: { userId: a.canonicalUserId, memberId: l.memberId } },
            update: { status: "CONFIRMED", revokedAt: null, confirmedAt: new Date() },
            create: {
              clubId: l.clubId,
              userId: a.canonicalUserId,
              memberId: l.memberId,
              relationship: l.relationship,
              status: "CONFIRMED",
              source: "STAFF_LINKED",
              confirmedAt: new Date(),
            },
          });
          await tx.memberGuardianUser.delete({ where: { id: l.id } });
        }

        // Signatures: repoint signerUserId ONLY. signerName, relationship,
        // signedAt, ipAddress, userAgent and the drawn signature image are left
        // byte-identical — the same human signed, we are only correcting which
        // account row the audit points at. Never rewrite a signature's content.
        //
        // Owner-approved 2026-08-02. Because this edits an audited record, each
        // repoint is itself logged (old id, new id, actor, timestamp, reason)
        // as a MemberMigrationEvent on the athlete the signature belongs to,
        // so the change is discoverable from the member's own history.
        const sigs = await tx.documentSignature.findMany({
          where: { signerUserId: a.duplicateUserId },
          select: {
            id: true, documentId: true, signerName: true, signedAt: true,
            member: { select: { id: true, clubId: true } },
          },
        });
        for (const s of sigs) {
          await tx.documentSignature.update({
            where: { id: s.id },
            data: { signerUserId: a.canonicalUserId },
          });
          await tx.memberMigrationEvent.create({
            data: {
              clubId: s.member.clubId,
              memberId: s.member.id,
              type: "NOTE",
              actorUserId: ACTOR,
              message:
                `Signature ${s.id} (document ${s.documentId}, signed ${s.signedAt.toISOString()}` +
                ` as "${s.signerName}") repointed: signerUserId ${a.duplicateUserId} → ${a.canonicalUserId}.` +
                ` Reason: duplicate login retired — same human, wrong account row.` +
                ` signerName, relationship, signedAt, ipAddress, userAgent and signature image unchanged.` +
                ` Run via scripts/fix-family-links.ts at ${new Date().toISOString()}` +
                `${ACTOR ? ` by user ${ACTOR}` : " (no --actor supplied)"}.`,
            },
          });
          console.log(`  ↳ signature ${s.id}: signerUserId ${a.duplicateUserId} → ${a.canonicalUserId} (logged)`);
        }

        await tx.user.update({
          where: { id: a.duplicateUserId },
          data: { deletedAt: new Date() },
        });
      });
      console.log(`✓ MERGE_DUPLICATE_LOGIN ${a.duplicateLabel} → ${a.canonicalLabel} (soft-deleted)`);
    }
  }

  console.log("\nRe-reading what changed…");
  for (const a of actions) {
    if (!allowed(a)) continue;
    if (a.kind === "LINK_GUARDIAN") {
      const row = await prisma.memberGuardianUser.findUnique({
        where: { userId_memberId: { userId: a.userId, memberId: a.memberId } },
        select: { status: true, source: true },
      });
      console.log(`  ${a.athlete}: link ${row ? `${row.status}/${row.source}` : "MISSING"}`);
    }
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
