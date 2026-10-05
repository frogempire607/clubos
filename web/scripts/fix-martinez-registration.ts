/**
 * Re-link event registrations that were attached to the WRONG member record,
 * and move the Booking with them. DRY RUN BY DEFAULT.
 *
 *   npx tsx scripts/fix-martinez-registration.ts                              # dry run, every row printed
 *   npx tsx scripts/fix-martinez-registration.ts --event=<eventId>            # dry run, one event
 *   npx tsx scripts/fix-martinez-registration.ts --apply --registration=<id>  # write ONE registration
 *   npx tsx scripts/fix-martinez-registration.ts --apply --event=<eventId>    # write every row listed for one event
 *
 * --apply refuses to run without --registration or --event: the dry run prints
 * the exact command for each row, so a write is always something you read first.
 *
 * ── Why these rows exist ────────────────────────────────────────────────────
 * Finger Lakes Duals, 2026-10: a parent registered two brothers (Mason, then
 * Lincoln Martinez) from the public link with one email. The public route
 * matched a member by EMAIL ONLY, so both registrations got Mason's member id.
 * Approving Lincoln created the Booking under Mason's member; every later
 * approval of Mason then hit the unique (eventId, memberId) on Booking inside
 * a transaction, the error was swallowed, and Postgres rolled the approval
 * back while the app said "approved". Both causes are fixed in the app
 * (lib/eventApproval, lib/registrationLink); this repairs the data.
 *
 * ── What it selects (lib/registrationRelink.planRelinks) ────────────────────
 * An ACTIVE registration (not canceled / declined) linked to a member whose
 * name is not the registration's name, where EXACTLY ONE other non-deleted
 * member of the same club has exactly that name, and that member has no other
 * active registration on the event. Name mismatches with no such member
 * (nicknames — "Zachary" on member "Zach") are listed under "Left alone" and
 * never written.
 *
 * Expected today: exactly one row —
 *   registration cmusol4w70009wiuh3g0midai "Lincoln Martinez"
 *   member cmr7b5wec00gt9il7391ik6i5 (Mason) → cmr7b5wea00gn9il7l6befb88 (Lincoln)
 *   Booking cmuspe2e3000212fyzbm24z4q moved to Lincoln.
 * Afterwards the owner approves Mason normally from Attendees / Approvals.
 *
 * ── What --apply writes (one transaction per registration) ──────────────────
 *   · EventRegistration.memberId → the right member (guarded on the old value)
 *   · the Booking, one of:
 *       MOVE          the wrong member's Booking is re-pointed to the right
 *                     member (the wrong member has no other confirmed
 *                     registration on the event)
 *       CANCEL_STRAY  the right member already has a live Booking → the stray
 *                     one is set to CANCELED (the app's cancel shape)
 *       RECONFIRM     the right member's canceled Booking → CONFIRMED
 *       CREATE        the wrong member keeps their own; a new CONFIRMED one
 *                     for the right member
 *       NONE          nothing to do (not confirmed yet — approving books them)
 *   · a BillingAuditLog row EVENT_REGISTRATION_RELINKED naming both members
 *     and the Booking step.
 *
 * ── What it will NEVER do ───────────────────────────────────────────────────
 * No Stripe import, no Stripe call. It never writes a money field (amountDue,
 * amountPaid, status, paymentMethod, transactions) and never changes a
 * registration's status or approval — only memberId and the Booking row.
 */
import { prisma } from "../lib/prisma";
import { planRelinks, type RelinkPlan } from "../lib/registrationRelink";
import { ACTIVE_REGISTRATION_STATUSES } from "../lib/eventPayments";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) || null;
const ONLY_EVENT = arg("event");
const ONLY_REG = arg("registration");

const fmt = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 19).replace("T", " ") : "—");

function bookingLine(p: RelinkPlan): string {
  const b = p.booking;
  switch (b.kind) {
    case "MOVE": return `MOVE          Booking ${b.bookingId}: member ${p.fromMemberId} → ${p.toMemberId}`;
    case "CANCEL_STRAY": return `CANCEL_STRAY  Booking ${b.bookingId} (on ${p.fromMemberName}) → CANCELED; ${p.toMemberName} keeps Booking ${b.keepBookingId}`;
    case "RECONFIRM": return `RECONFIRM     Booking ${b.bookingId} (${p.toMemberName}) CANCELED → CONFIRMED${b.strayBookingId ? `; stray Booking ${b.strayBookingId} → CANCELED` : ""}`;
    case "CREATE": return `CREATE        new CONFIRMED Booking for ${p.toMemberName} (${p.fromMemberName} keeps their own)`;
    case "NONE": return `NONE          ${b.why}`;
  }
}

async function main() {
  if (APPLY && !ONLY_EVENT && !ONLY_REG) {
    console.error("Refusing --apply without --registration=<id> or --event=<id>. Run the dry run first; it prints the command.");
    process.exit(1);
  }

  // Events that have at least one member-linked active registration.
  const regs = await prisma.eventRegistration.findMany({
    where: {
      memberId: { not: null },
      status: { not: "CANCELED" },
      event: { deletedAt: null },
      ...(ONLY_EVENT ? { eventId: ONLY_EVENT } : {}),
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true, eventId: true, clubId: true, memberId: true, name: true, email: true, status: true,
      approvalStatus: true, createdAt: true,
      event: { select: { name: true } },
    },
  });
  const clubIds = Array.from(new Set(regs.map((r) => r.clubId)));
  const eventIds = Array.from(new Set(regs.map((r) => r.eventId)));
  const [members, bookings] = await Promise.all([
    clubIds.length
      ? prisma.member.findMany({
          where: { clubId: { in: clubIds }, deletedAt: null },
          select: { id: true, clubId: true, firstName: true, lastName: true },
        })
      : [],
    eventIds.length
      ? prisma.booking.findMany({
          where: { eventId: { in: eventIds } },
          select: { id: true, eventId: true, memberId: true, status: true, createdAt: true },
        })
      : [],
  ]);

  const all = planRelinks({ registrations: regs, members, bookings, activeStatuses: ACTIVE_REGISTRATION_STATUSES });
  const plans = ONLY_REG ? all.plans.filter((p) => p.registrationId === ONLY_REG) : all.plans;
  const regById = new Map(regs.map((r) => [r.id, r]));
  const bookingById = new Map(bookings.map((b) => [b.id, b]));

  console.log(`\n=== ${APPLY ? "APPLY" : "DRY RUN"} — ${plans.length} registration(s) linked to the wrong member ===`);
  console.log(`    scanned ${regs.length} member-linked registration(s) on ${eventIds.length} event(s)${ONLY_EVENT ? ` (event ${ONLY_EVENT})` : ""}${ONLY_REG ? ` (registration ${ONLY_REG})` : ""}\n`);

  for (const [i, p] of plans.entries()) {
    const r = regById.get(p.registrationId)!;
    console.log(`${i + 1}. "${p.registrationName}" — ${r.event.name}`);
    console.log(`     registration ${p.registrationId}  status=${r.status}  approval=${r.approvalStatus ?? "—"}  email=${r.email}  created ${fmt(r.createdAt)}`);
    console.log(`     BEFORE  memberId ${p.fromMemberId}  (${p.fromMemberName})`);
    console.log(`     AFTER   memberId ${p.toMemberId}  (${p.toMemberName})`);
    console.log(`     BOOKING ${bookingLine(p)}`);
    for (const id of [p.fromMemberId, p.toMemberId]) {
      const b = bookings.find((x) => x.eventId === p.eventId && x.memberId === id);
      console.log(`       now: ${id === p.fromMemberId ? p.fromMemberName : p.toMemberName} → ${b ? `Booking ${b.id} ${b.status} (created ${fmt(b.createdAt)})` : "no Booking"}`);
    }
    if (!APPLY) console.log(`     to write: npx tsx scripts/fix-martinez-registration.ts --apply --registration=${p.registrationId}`);
    console.log("");
  }

  const skipped = ONLY_REG ? all.skipped.filter((s) => s.registrationId === ONLY_REG) : all.skipped;
  if (skipped.length) {
    console.log(`--- Left alone: ${skipped.length} name mismatch(es) that do NOT meet the rule (never written) ---`);
    for (const s of skipped) {
      console.log(`  · registration ${s.registrationId} "${s.registrationName}" on member "${s.memberName}" — ${s.reason}`);
    }
    console.log("");
  }

  if (!APPLY) {
    console.log("Dry run — nothing was written.\n");
    return;
  }

  let done = 0;
  for (const p of plans) {
    const outcome = await prisma.$transaction(async (db) => {
      // Same lock approve / decline / link-member take.
      await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${p.registrationId}`}, 0))`;
      // Guarded on the value the plan was made from: a row someone fixed by
      // hand in the meantime matches nothing and is skipped.
      const moved = await db.eventRegistration.updateMany({
        where: { id: p.registrationId, memberId: p.fromMemberId, status: { not: "CANCELED" } },
        data: { memberId: p.toMemberId },
      });
      if (moved.count !== 1) return { ok: false as const, why: "registration changed since the plan was made" };

      const b = p.booking;
      let wrote = 0;
      if (b.kind === "MOVE") {
        // Re-read both sides inside the lock; the unique (eventId, memberId)
        // must be free before the update, never discovered by a failed write.
        const taken = await db.booking.findUnique({
          where: { eventId_memberId: { eventId: p.eventId, memberId: p.toMemberId } },
          select: { id: true },
        });
        if (taken) throw new Error(`Booking ${taken.id} appeared for ${p.toMemberName} — re-run the dry run`);
        wrote = (await db.booking.updateMany({ where: { id: b.bookingId, memberId: p.fromMemberId }, data: { memberId: p.toMemberId } })).count;
      } else if (b.kind === "CANCEL_STRAY") {
        wrote = (await db.booking.updateMany({ where: { id: b.bookingId, memberId: p.fromMemberId }, data: { status: "CANCELED" } })).count;
      } else if (b.kind === "RECONFIRM") {
        wrote = (await db.booking.updateMany({ where: { id: b.bookingId, memberId: p.toMemberId }, data: { status: "CONFIRMED" } })).count;
        if (b.strayBookingId) {
          await db.booking.updateMany({ where: { id: b.strayBookingId, memberId: p.fromMemberId }, data: { status: "CANCELED" } });
        }
      } else if (b.kind === "CREATE") {
        const taken = await db.booking.findUnique({
          where: { eventId_memberId: { eventId: p.eventId, memberId: p.toMemberId } },
          select: { id: true },
        });
        if (taken) throw new Error(`Booking ${taken.id} appeared for ${p.toMemberName} — re-run the dry run`);
        await db.booking.create({ data: { eventId: p.eventId, memberId: p.toMemberId, status: "CONFIRMED" } });
        wrote = 1;
      }
      if (b.kind !== "NONE" && wrote !== 1) throw new Error(`Booking step ${b.kind} matched ${wrote} row(s) — rolled back, re-run the dry run`);

      await db.billingAuditLog.create({
        data: {
          clubId: p.clubId,
          memberId: p.toMemberId,
          actorUserId: null,
          action: "EVENT_REGISTRATION_RELINKED",
          before: { registrationId: p.registrationId, memberId: p.fromMemberId, memberName: p.fromMemberName },
          after: { registrationId: p.registrationId, memberId: p.toMemberId, memberName: p.toMemberName, booking: p.booking },
          note: `Script fix-martinez-registration: "${p.registrationName}" was linked to ${p.fromMemberName} by the email-only public signup match; re-linked to ${p.toMemberName}. Booking: ${p.booking.kind}.`,
        },
      });
      return { ok: true as const };
    });

    if (!outcome.ok) {
      console.log(`  SKIPPED ${p.registrationId} "${p.registrationName}" — ${outcome.why}`);
      continue;
    }
    // Verify, don't trust: read back what is actually stored.
    const after = await prisma.eventRegistration.findUnique({
      where: { id: p.registrationId },
      select: { memberId: true, status: true, approvalStatus: true },
    });
    const afterBookings = await prisma.booking.findMany({
      where: { eventId: p.eventId, memberId: { in: [p.fromMemberId, p.toMemberId] } },
      select: { id: true, memberId: true, status: true },
    });
    const good = after?.memberId === p.toMemberId;
    if (good) done++;
    console.log(`  ${good ? "WROTE  " : "FAILED "} ${p.registrationId} "${p.registrationName}"`);
    console.log(`     registration memberId now ${after?.memberId ?? "—"}  status=${after?.status}  approval=${after?.approvalStatus ?? "—"}`);
    for (const b of afterBookings) {
      const was = bookingById.get(b.id);
      console.log(`     Booking ${b.id}: member ${was?.memberId ?? "(new)"} ${was?.status ?? ""} → ${b.memberId} ${b.status}`);
    }
  }
  console.log(`\nDone — ${done} of ${plans.length} registration(s) re-linked. Nothing in Stripe and no money field was touched.\n`);
  if (done !== plans.length) process.exit(1);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
