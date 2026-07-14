/**
 * Correct placeholder "Continued membership" records — members who were
 * approved with NOTHING configured, which manufactured a fake $0 membership
 * and flipped them ACTIVE + COMPLETED.
 *
 * What it does per allowlisted member (and nothing else):
 *   - Cancels their placeholder subscription rows (status → canceled, note
 *     appended). Rows are never deleted; payments/history/attendance/notes/
 *     documents/guardian links/saved cards are untouched.
 *   - Clears the fake Member.membershipId assignment.
 *   - Sets status → PROSPECT (never had a valid membership).
 *   - Rolls migrationStatus back to the correct completed-ACCOUNT state:
 *     ACTIVATED if they finished activation, else INVITED if an invite went
 *     out, else IMPORTED. approvalStatus/migrationCompletedAt cleared.
 *   - Writes a BillingAuditLog row + a MemberMigrationEvent NOTE.
 *   - Creates NO Stripe objects, charges NOBODY, sends NO email.
 *
 * SAFETY RAILS:
 *   - An explicit --members allowlist is REQUIRED (ids or emails) — even for
 *     a dry run. There is deliberately no "all" mode.
 *   - Only subscriptions matching the placeholder signature are touched:
 *     MANUAL + active + $0 + no Stripe ids + the free/grandfathered note.
 *     A member whose subs don't match is skipped loudly, never coerced.
 *   - Dry-run by default; --apply to execute; verification re-read at the end.
 *   - Optional --retire-plans additionally soft-deletes club plan rows named
 *     "Continued membership" that end up with zero references (report shown
 *     in both modes).
 *
 * Usage (from web/):
 *   npx tsx scripts/fix-placeholder-memberships.ts --members a@x.com,b@x.com            # dry run
 *   npx tsx scripts/fix-placeholder-memberships.ts --members <...> --apply
 *   npx tsx scripts/fix-placeholder-memberships.ts --members <...> --apply --retire-plans
 */
import { prisma } from "../lib/prisma";

const APPLY = process.argv.includes("--apply");
const RETIRE_PLANS = process.argv.includes("--retire-plans");
const membersArgIdx = process.argv.indexOf("--members");
const ALLOWLIST = membersArgIdx >= 0
  ? (process.argv[membersArgIdx + 1] || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  : [];

if (!ALLOWLIST.length) {
  console.error(
    "\nREFUSED: an explicit --members allowlist is required (member ids or emails, comma-separated).\n" +
      "This script has no 'all' mode by design.\n",
  );
  process.exit(1);
}

const PLACEHOLDER_NOTE = "Free / grandfathered membership";

function rollbackStatus(m: { activatedAt: Date | null; activationEmailSentAt: Date | null }): string {
  if (m.activatedAt) return "ACTIVATED"; // completed their account/profile
  if (m.activationEmailSentAt) return "INVITED";
  return "IMPORTED";
}

async function main() {
  console.log(`\n=== Fix placeholder memberships (${APPLY ? "APPLY" : "DRY RUN"}) ===`);
  console.log(`Allowlist: ${ALLOWLIST.join(", ")}\n`);

  const members = await prisma.member.findMany({
    where: { deletedAt: null },
    select: {
      id: true, clubId: true, firstName: true, lastName: true, email: true, guardianEmail: true,
      status: true, membershipId: true, migrationStatus: true, approvalStatus: true,
      activatedAt: true, activationEmailSentAt: true, migrationCompletedAt: true,
      stripeSetupPaymentMethodId: true,
      subscriptions: {
        select: {
          id: true, optionLabel: true, price: true, billingPeriod: true, billingType: true,
          status: true, notes: true, stripeSubscriptionId: true, stripeCheckoutSessionId: true,
          membershipId: true,
        },
      },
    },
  });
  const targets = members.filter((m) =>
    ALLOWLIST.some(
      (x) => x === m.id.toLowerCase() || x === m.email?.toLowerCase() || x === m.guardianEmail?.toLowerCase(),
    ),
  );
  const missing = ALLOWLIST.filter(
    (x) => !targets.some((m) => x === m.id.toLowerCase() || x === m.email?.toLowerCase() || x === m.guardianEmail?.toLowerCase()),
  );
  if (missing.length) console.log(`NOT FOUND (skipped): ${missing.join(", ")}\n`);

  let corrected = 0;
  const skipped: string[] = [];
  const correctedMemberIds: string[] = [];

  for (const m of targets) {
    const who = `${m.firstName} ${m.lastName}`.trim();

    // Placeholder signature — anything else means this member is NOT a
    // placeholder case and must not be coerced by this script.
    const placeholderSubs = m.subscriptions.filter(
      (s) =>
        s.billingType === "MANUAL" &&
        s.status === "active" &&
        Number(s.price) === 0 &&
        !s.stripeSubscriptionId &&
        (s.notes ?? "").startsWith(PLACEHOLDER_NOTE),
    );
    const otherLiveSubs = m.subscriptions.filter(
      (s) => ["active", "pending", "past_due"].includes(s.status) && !placeholderSubs.includes(s),
    );
    if (placeholderSubs.length === 0) {
      skipped.push(`${who} — no subscription matches the placeholder signature ($0 MANUAL active "${PLACEHOLDER_NOTE}…")`);
      continue;
    }
    if (otherLiveSubs.length > 0) {
      skipped.push(`${who} — has OTHER live subscriptions (${otherLiveSubs.map((s) => s.optionLabel).join(", ")}); resolve manually`);
      continue;
    }
    if (m.subscriptions.some((s) => s.stripeSubscriptionId)) {
      skipped.push(`${who} — has a Stripe-linked subscription in history; resolve manually`);
      continue;
    }

    const newMigrationStatus = rollbackStatus(m);
    console.log(`✓ ${who}`);
    console.log(`    cancel ${placeholderSubs.length} placeholder sub(s): ${placeholderSubs.map((s) => s.id).join(", ")}`);
    console.log(`    member: status ${m.status} → PROSPECT · membershipId → (none) · migrationStatus ${m.migrationStatus} → ${newMigrationStatus} · approvalStatus → (none)`);
    console.log(`    kept: account/profile, saved card (${m.stripeSetupPaymentMethodId ? "yes" : "none"}), guardians, history, events, attendance, notes, documents`);

    if (!APPLY) { corrected++; continue; }

    for (const s of placeholderSubs) {
      await prisma.memberSubscription.update({
        where: { id: s.id },
        data: {
          status: "canceled",
          canceledAt: new Date(),
          autoRenew: false,
          notes: `${s.notes ?? ""} [Retired ${new Date().toISOString().slice(0, 10)}: placeholder created by an empty-config approval — no membership was ever purchased. Corrected to Prospect.]`.trim(),
        },
      });
    }
    await prisma.member.update({
      where: { id: m.id },
      data: {
        status: "PROSPECT",
        membershipId: null,
        migrationStatus: newMigrationStatus,
        approvalStatus: null,
        migrationCompletedAt: null,
      },
    });
    await prisma.billingAuditLog.create({
      data: {
        clubId: m.clubId,
        memberId: m.id,
        action: "PLACEHOLDER_MEMBERSHIP_CORRECTED",
        before: {
          status: m.status, migrationStatus: m.migrationStatus, approvalStatus: m.approvalStatus,
          membershipId: m.membershipId, placeholderSubs: placeholderSubs.map((s) => s.id),
        },
        after: {
          status: "PROSPECT", migrationStatus: newMigrationStatus, approvalStatus: null,
          membershipId: null, subsCanceled: placeholderSubs.length,
        },
        note: "fix-placeholder-memberships.ts --apply (owner-approved allowlist). No Stripe objects created, nobody charged, no email sent.",
      },
    }).catch((e) => console.error("    audit write failed:", e));
    await prisma.memberMigrationEvent.create({
      data: {
        clubId: m.clubId,
        memberId: m.id,
        type: "NOTE",
        message: "Placeholder $0 membership retired — corrected to Prospect (account, card, and history preserved).",
      },
    }).catch(() => {});
    correctedMemberIds.push(m.id);
    corrected++;
  }

  // ── Fake plan rows report (dry-run in both modes; retire only on flags) ──
  const fakePlans = await prisma.membership.findMany({
    where: { name: "Continued membership", deletedAt: null },
    select: { id: true, clubId: true, createdAt: true },
  });
  console.log(`\n=== "Continued membership" plan rows (${fakePlans.length}) ===`);
  const retirable: string[] = [];
  for (const p of fakePlans) {
    const [liveSubs, anySubs, pointing, migrationPointing] = await Promise.all([
      prisma.memberSubscription.count({ where: { membershipId: p.id, status: { in: ["active", "pending", "past_due"] } } }),
      prisma.memberSubscription.count({ where: { membershipId: p.id } }),
      prisma.member.count({ where: { membershipId: p.id, deletedAt: null } }),
      prisma.member.count({ where: { migrationMembershipId: p.id, deletedAt: null } }),
    ]);
    const safe = liveSubs === 0 && pointing === 0 && migrationPointing === 0;
    console.log(
      `  ${p.id} (created ${p.createdAt.toISOString().slice(0, 10)}) — live subs: ${liveSubs}, total subs: ${anySubs}, members pointing: ${pointing}, migration pointing: ${migrationPointing} → ${safe ? "SAFE TO RETIRE" : "keep (still referenced)"}`,
    );
    if (safe) retirable.push(p.id);
  }
  if (RETIRE_PLANS && APPLY && retirable.length) {
    await prisma.membership.updateMany({
      where: { id: { in: retirable } },
      data: { deletedAt: new Date() },
    });
    console.log(`  Retired (soft-deleted) ${retirable.length} unreferenced plan row(s). Historical sub rows still reference them by id.`);
  } else if (retirable.length) {
    console.log(`  ${retirable.length} retirable now${APPLY ? "" : " (after apply)"} — run with --apply --retire-plans to soft-delete them.`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Corrected: ${corrected}${APPLY ? "" : " (dry run — nothing written)"}`);
  if (skipped.length) {
    console.log(`Skipped (${skipped.length}):`);
    skipped.forEach((x) => console.log("  " + x));
  }

  // Verification re-read.
  if (APPLY && correctedMemberIds.length) {
    console.log(`\n=== Verification (re-read) ===`);
    const verify = await prisma.member.findMany({
      where: { id: { in: correctedMemberIds } },
      select: {
        firstName: true, lastName: true, status: true, membershipId: true,
        migrationStatus: true, approvalStatus: true, stripeSetupPaymentMethodId: true,
        subscriptions: { where: { status: "active" }, select: { id: true } },
      },
    });
    for (const v of verify) {
      const ok = v.status === "PROSPECT" && !v.membershipId && !v.approvalStatus && v.subscriptions.length === 0;
      console.log(
        `  ${ok ? "OK " : "!! "}${v.firstName} ${v.lastName} — ${v.status}, membership=${v.membershipId ?? "none"}, mig=${v.migrationStatus}, activeSubs=${v.subscriptions.length}, card=${v.stripeSetupPaymentMethodId ? "kept" : "none"}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
