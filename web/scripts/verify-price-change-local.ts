// Local-only post-apply verification for the bulk price change.
// Reads the throwaway browser-test database and asserts what actually landed.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/clubos \
//     npx tsx scripts/verify-price-change-local.ts

import { PrismaClient } from "@prisma/client";
import { subscriptionHistoryIsComplete, LIFECYCLE_EVENT_KINDS } from "../lib/subscriptionEvents";

const url = process.env.DATABASE_URL ?? "";
if (!/(127\.0\.0\.1|localhost)/.test(url)) {
  console.error("REFUSING: DATABASE_URL is not localhost.");
  process.exit(1);
}

const prisma = new PrismaClient();
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`  FAIL ${name}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ""}`); }
};

async function main() {
  const clubId = "club_local";

  console.log("\nPrices after apply:");
  const subs = await prisma.memberSubscription.findMany({
    where: { membershipId: "mship_mshs" },
    select: { id: true, price: true, optionLabel: true, billingPeriod: true },
    orderBy: { id: "asc" },
  });
  const priceOf = (id: string) => Number(subs.find((s) => s.id === id)?.price ?? -1);
  for (const id of ["sub_ann", "sub_ben", "sub_cara", "sub_dev"]) {
    check(`${id} moved to 175`, priceOf(id) === 175, priceOf(id));
  }
  check("sub_eli override ($5) untouched", priceOf("sub_eli") === 5, priceOf("sub_eli"));
  check("sub_fern override ($0) untouched", priceOf("sub_fern") === 0, priceOf("sub_fern"));
  check("sub_gus (already 175) untouched", priceOf("sub_gus") === 175, priceOf("sub_gus"));
  check("sub_hana QUARTERLY untouched — different option", priceOf("sub_hana") === 530, priceOf("sub_hana"));
  check("sub_ivan QUARTERLY untouched — different option", priceOf("sub_ivan") === 530, priceOf("sub_ivan"));

  console.log("\nThe plan's own price list:");
  const plan = await prisma.membership.findUnique({ where: { id: "mship_mshs" }, select: { options: true } });
  const opts = JSON.parse(String(plan?.options ?? "[]"));
  check("options still say 190 — apply never touches the price list",
    opts.find((o: any) => o.label === "Monthly")?.price === 190,
    opts.find((o: any) => o.label === "Monthly")?.price);

  console.log("\nPRICE_CHANGE events:");
  const pc = await prisma.memberSubscriptionEvent.findMany({
    where: { clubId, kind: "PRICE_CHANGE" },
    select: { memberSubscriptionId: true, fromAmount: true, toAmount: true, source: true, actorUserId: true, detail: true },
  });
  check("one PRICE_CHANGE row per updated subscription", pc.length === 4, pc.length);
  check("from/to amounts recorded",
    pc.every((e) => Number(e.fromAmount) === 190 && Number(e.toAmount) === 175));
  check("source is OWNER_ACTION", pc.every((e) => e.source === "OWNER_ACTION"));
  check("actor recorded", pc.every((e) => !!e.actorUserId));
  check("detail names the proration behavior",
    pc.every((e) => (e.detail as any)?.prorationBehavior === null || (e.detail as any)?.prorationBehavior === "none"));

  // ── Churn contamination guard ──────────────────────────────────────────
  //
  // This is the assertion the whole `kind` filter exists for. The fixture DB
  // deliberately contains subscriptions with NO lifecycle history, which is
  // what an un-backfilled club looks like. Writing a PRICE_CHANGE row against
  // one of them must NOT make the club's history look complete.
  console.log("\nChurn contamination guard:");
  check("PRICE_CHANGE is not a lifecycle kind", !LIFECYCLE_EVENT_KINDS.includes("PRICE_CHANGE" as never));

  const countCovered = (kinds?: string[]) =>
    prisma.memberSubscriptionEvent
      .groupBy({ by: ["memberSubscriptionId"], where: { clubId, ...(kinds ? { kind: { in: kinds } } : {}) } })
      .then((r) => r.length);

  const total = await prisma.memberSubscription.count({ where: { member: { clubId } } });
  const lifecycleBefore = await countCovered(LIFECYCLE_EVENT_KINDS);
  const priceChangeRows = await countCovered(["PRICE_CHANGE"]);
  check("PRICE_CHANGE rows were written", priceChangeRows === 4, priceChangeRows);
  check("history is honestly INCOMPLETE — some subs have no lifecycle events",
    lifecycleBefore < total, { lifecycleBefore, total });
  check("subscriptionHistoryIsComplete reports false, as it should",
    (await subscriptionHistoryIsComplete(clubId)) === false);

  // Find a subscription with NO events at all and give it only a PRICE_CHANGE.
  const covered = new Set(
    (await prisma.memberSubscriptionEvent.groupBy({ by: ["memberSubscriptionId"], where: { clubId } }))
      .map((r) => r.memberSubscriptionId),
  );
  const orphan = (await prisma.memberSubscription.findMany({
    where: { member: { clubId } }, select: { id: true, memberId: true },
  })).find((s) => !covered.has(s.id));

  if (!orphan) {
    check("a subscription with no events exists to test against", false);
  } else {
    await prisma.memberSubscriptionEvent.create({
      data: {
        clubId, memberSubscriptionId: orphan.id, memberId: orphan.memberId,
        kind: "PRICE_CHANGE", fromAmount: "100", toAmount: "90", source: "OWNER_ACTION",
      },
    });
    const lifecycleAfter = await countCovered(LIFECYCLE_EVENT_KINDS);
    const unfilteredAfter = await countCovered();
    check("a lone PRICE_CHANGE does NOT raise lifecycle coverage",
      lifecycleAfter === lifecycleBefore, { lifecycleBefore, lifecycleAfter });
    check("…while the unfiltered count DID rise — exactly the inflation the filter blocks",
      unfilteredAfter === covered.size + 1 && unfilteredAfter > lifecycleAfter,
      { unfilteredAfter, coveredBefore: covered.size, lifecycleAfter });
    check("subscriptionHistoryIsComplete still false after the repricing",
      (await subscriptionHistoryIsComplete(clubId)) === false);
    await prisma.memberSubscriptionEvent.deleteMany({
      where: { memberSubscriptionId: orphan.id, kind: "PRICE_CHANGE" },
    });
  }

  console.log("\nBillingAuditLog — where the credit surfaces:");
  const perMember = await prisma.billingAuditLog.findMany({
    where: { clubId, action: "MEMBERSHIP_PRICE_CHANGED" },
    select: { memberId: true, before: true, after: true, note: true },
  });
  check("one per-member audit row per update", perMember.length === 4, perMember.length);
  check("each is attached to a member (renders on their billing history)",
    perMember.every((r) => !!r.memberId));
  check("before/after carry the prices",
    perMember.every((r) => (r.before as any)?.price === 190 && (r.after as any)?.price === 175));
  check("credit kind recorded on every row",
    perMember.every((r) => !!(r.after as any)?.credit?.kind));
  check("monthly rows record NOT_APPLICABLE, with no invented amount",
    perMember.every((r) => (r.after as any)?.credit?.kind === "NOT_APPLICABLE" && (r.after as any)?.credit?.amount === null));

  const runRow = await prisma.billingAuditLog.findMany({
    where: { clubId, action: "MEMBERSHIP_BULK_PRICE_CHANGE" },
    select: { after: true, note: true },
    orderBy: { createdAt: "desc" },
  });
  check("a run-level audit row exists", runRow.length >= 1);
  check("run row states the price list was NOT changed",
    !!runRow[0]?.note?.includes("NOT changed"));

  console.log("\nNotification path:");
  const sends = await prisma.emailSend.findMany({
    where: { clubId },
    select: { recipientEmail: true, kind: true, status: true, skippedReason: true, subject: true, relatedMembershipId: true },
  });
  check("an EmailSend row per updated member — the path ran", sends.length === 4, sends.length);
  check("kind is TRANSACTIONAL (a marketing opt-out must not suppress it)",
    sends.every((s) => s.kind === "TRANSACTIONAL"), sends.map((s) => s.kind));
  check("nothing was actually delivered in this harness",
    sends.every((s) => s.status === "SKIPPED" && s.skippedReason === "NO_PROVIDER"),
    sends.map((s) => `${s.status}/${s.skippedReason}`));
  check("subject reads as a decrease", sends.every((s) => s.subject.includes("going down")), sends[0]?.subject);
  check("linked to the membership for the profile history tab",
    sends.every((s) => s.relatedMembershipId === "mship_mshs"));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
