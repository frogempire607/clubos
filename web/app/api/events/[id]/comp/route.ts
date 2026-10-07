import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, hasPermissionLive, isOwnerLive } from "@/lib/apiGuard";
import { SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { addEventStaffIfMissing } from "@/lib/staffAssignmentsServer";
import {
  COMP_METHODS,
  COMP_BASES,
  COMP_PAYEE_TYPES,
  collectedRevenue,
  computePayoutAmount,
} from "@/lib/eventComp";

// Event payroll config + live revenue/payout preview. Money-shaped, so it's
// gated on finances (not events) — a coach who can edit event details must not
// be able to set their own pay.

const assignmentSchema = z.object({
  id: z.string().optional(),
  payeeType: z.enum(COMP_PAYEE_TYPES),
  userId: z.string().optional().nullable(),
  contractorId: z.string().optional().nullable(),
  compMethod: z.enum(COMP_METHODS),
  flatAmount: z.number().min(0).max(100000).optional().nullable(),
  percent: z.number().min(0).max(100).optional().nullable(),
  basis: z.enum(COMP_BASES).default("GROSS_COLLECTED"),
  notes: z.string().max(500).optional().nullable(),
});

const putSchema = z.object({
  compNoRefunds: z.boolean().optional(),
  assignments: z.array(assignmentSchema).max(50),
});

async function loadEvent(id: string, clubId: string) {
  return prisma.event.findFirst({
    where: { id, clubId, deletedAt: null },
    select: { id: true, name: true, startsAt: true, compNoRefunds: true },
  });
}

async function compPayload(clubId: string, event: NonNullable<Awaited<ReturnType<typeof loadEvent>>>) {
  const [assignments, txns, payouts] = await Promise.all([
    prisma.eventCompAssignment.findMany({
      where: { eventId: event.id, clubId },
      orderBy: { createdAt: "asc" },
    }),
    prisma.transaction.findMany({
      where: { clubId, eventId: event.id },
      select: {
        status: true,
        reconciliationStatus: true,
        amount: true,
        refundedAmount: true,
        stripeFeeAmount: true,
      },
    }),
    prisma.payout.findMany({
      where: { clubId, eventId: event.id },
      select: { id: true, status: true, amount: true, payeeName: true, paidAt: true },
    }),
  ]);

  const revenue = collectedRevenue(txns, { ignoreRefunds: event.compNoRefunds });
  const payoutById = new Map(payouts.map((p) => [p.id, p]));
  const eventOver = event.startsAt < new Date();

  return {
    event: { id: event.id, name: event.name, startsAt: event.startsAt, compNoRefunds: event.compNoRefunds },
    revenue,
    eventOver,
    assignments: assignments.map((a) => ({
      id: a.id,
      payeeType: a.payeeType,
      userId: a.userId,
      contractorId: a.contractorId,
      payeeName: a.payeeName,
      compMethod: a.compMethod,
      flatAmount: a.flatAmount != null ? Number(a.flatAmount) : null,
      percent: a.percent != null ? Number(a.percent) : null,
      basis: a.basis,
      notes: a.notes,
      // Live estimate before the event; the same math is the final number
      // once revenue stops moving.
      estimatedPayout: computePayoutAmount(
        {
          compMethod: a.compMethod,
          flatAmount: a.flatAmount != null ? Number(a.flatAmount) : null,
          percent: a.percent != null ? Number(a.percent) : null,
          basis: a.basis,
        },
        revenue,
      ),
      payout: a.payoutId ? (payoutById.get(a.payoutId) ?? null) : null,
    })),
  };
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;

  const event = await loadEvent(id, session.user.clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [payload, staff, contractors] = await Promise.all([
    compPayload(session.user.clubId, event),
    prisma.user.findMany({
      where: { clubId: session.user.clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { firstName: "asc" },
    }),
    prisma.contractor.findMany({
      where: { clubId: session.user.clubId, deletedAt: null, active: true },
      select: { id: true, name: true, role: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return NextResponse.json({ ...payload, staff, contractors });
}

export async function PUT(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Money: Financials & payroll FULL, read live (was the token-snapshot
  // `finances:edit` until 2026-10-07).
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const me = session.user.id;
  // Owners have no manager above them; everyone else is under the self rule.
  const actorIsOwner = await isOwnerLive(session);

  const event = await loadEvent(id, clubId);
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.errors[0]?.message ?? "Invalid request" }, { status: 400 });
  }
  const { assignments, compNoRefunds } = parsed.data;

  // Resolve + validate every payee inside this club; denormalize the name so
  // the pay record stays legible even if the person is later removed.
  const userIds = assignments.filter((a) => a.payeeType === "STAFF").map((a) => a.userId).filter(Boolean) as string[];
  const contractorIds = assignments
    .filter((a) => a.payeeType === "CONTRACTOR")
    .map((a) => a.contractorId)
    .filter(Boolean) as string[];
  const [users, contractors] = await Promise.all([
    prisma.user.findMany({
      // A STAFF payee is a current OWNER/STAFF of this club — never a member's
      // login or a removed account.
      where: { id: { in: userIds }, clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
      select: { id: true, firstName: true, lastName: true },
    }),
    prisma.contractor.findMany({
      where: { id: { in: contractorIds }, clubId, deletedAt: null },
      select: { id: true, name: true },
    }),
  ]);
  const userById = new Map(users.map((u) => [u.id, u]));
  const contractorById = new Map(contractors.map((c) => [c.id, c]));

  for (const a of assignments) {
    if (a.payeeType === "STAFF" && (!a.userId || !userById.has(a.userId))) {
      return NextResponse.json({ error: "One of the staff members couldn't be found." }, { status: 400 });
    }
    if (a.payeeType === "CONTRACTOR" && (!a.contractorId || !contractorById.has(a.contractorId))) {
      return NextResponse.json({ error: "One of the guest clinicians couldn't be found." }, { status: 400 });
    }
    if (a.compMethod === "FLAT" && !(Number(a.flatAmount) > 0)) {
      return NextResponse.json({ error: "Flat payments need an amount above $0." }, { status: 400 });
    }
    if (a.compMethod === "PERCENT" && !(Number(a.percent) > 0)) {
      return NextResponse.json({ error: "Percentage payments need a percent above 0." }, { status: 400 });
    }
  }

  const existing = await prisma.eventCompAssignment.findMany({
    where: { eventId: event.id, clubId },
    select: {
      id: true, payoutId: true, payeeType: true, userId: true,
      compMethod: true, flatAmount: true, percent: true, basis: true, notes: true,
    },
  });
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const keptIds = new Set(assignments.map((a) => a.id).filter(Boolean) as string[]);

  // ── Self rule: nobody but an owner sets their own event pay ───────────────
  // "A staff member must never be able to set or modify their own event pay
  // unless an authorized admin does so." The save is one list, so compare the
  // caller's OWN rows before and after: adding one, changing one, removing one,
  // or re-pointing any row at/away from the caller refuses the WHOLE save —
  // nothing is written. Other people's rows are unaffected by this check.
  if (!actorIsOwner) {
    const norm = (r: { compMethod: string; flatAmount?: unknown; percent?: unknown; basis: string; notes?: string | null }) =>
      JSON.stringify([
        r.compMethod,
        r.compMethod === "FLAT" && r.flatAmount != null ? Number(r.flatAmount) : null,
        r.compMethod === "PERCENT" && r.percent != null ? Number(r.percent) : null,
        r.basis,
        (r.notes ?? "").trim() || null, // "" and null are the same "no note"
      ]);
    const mineBefore = new Map(existing.filter((e) => e.payeeType === "STAFF" && e.userId === me).map((e) => [e.id, norm(e)]));
    const mineAfter = assignments.filter((a) => a.payeeType === "STAFF" && a.userId === me);
    const unchanged =
      mineAfter.length === mineBefore.size &&
      mineAfter.every((a) => !!a.id && mineBefore.get(a.id) === norm(a));
    if (!unchanged) {
      return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay, code: "SELF_PAY_FORBIDDEN" }, { status: 403 });
    }
  }

  // Pay follows the roster (below): a NEW staff payee is put on the event,
  // which is an assignment — schedule:edit (live) only. Without it the payee
  // must already be on "Staff on this event".
  const roster = await prisma.eventStaffAssignment.findMany({ where: { eventId: event.id, clubId }, select: { userId: true } });
  const onRoster = new Set(roster.map((r) => r.userId));
  const offRoster = Array.from(new Set(userIds)).filter((uid) => !onRoster.has(uid));
  if (offRoster.length > 0 && !(await hasPermissionLive(session, "schedule", "edit"))) {
    return NextResponse.json(
      {
        error: "Someone you're paying isn't on this event's staff yet. Adding them needs schedule-management access — ask a schedule manager to put them on the event first.",
        code: "ASSIGNMENT_FORBIDDEN",
      },
      { status: 403 },
    );
  }

  // Deleting an assignment never deletes an already-generated Payout — the
  // ledger row stands on its own for the owner to void/mark-paid there.
  const toDelete = existing.filter((e) => !keptIds.has(e.id)).map((e) => e.id);

  await prisma.$transaction([
    ...(compNoRefunds !== undefined
      ? [prisma.event.update({ where: { id: event.id }, data: { compNoRefunds } })]
      : []),
    ...(toDelete.length ? [prisma.eventCompAssignment.deleteMany({ where: { id: { in: toDelete }, clubId } })] : []),
    ...assignments.map((a) => {
      const payeeName =
        a.payeeType === "STAFF"
          ? `${userById.get(a.userId!)!.firstName} ${userById.get(a.userId!)!.lastName ?? ""}`.trim()
          : contractorById.get(a.contractorId!)!.name;
      const fields = {
        payeeType: a.payeeType,
        userId: a.payeeType === "STAFF" ? a.userId : null,
        contractorId: a.payeeType === "CONTRACTOR" ? a.contractorId : null,
        payeeName,
        compMethod: a.compMethod,
        flatAmount: a.compMethod === "FLAT" ? a.flatAmount : null,
        percent: a.compMethod === "PERCENT" ? a.percent : null,
        basis: a.basis,
        notes: a.notes ?? null,
      };
      return a.id && existingById.has(a.id)
        ? prisma.eventCompAssignment.update({ where: { id: a.id }, data: fields })
        : prisma.eventCompAssignment.create({
            data: { ...fields, clubId, eventId: event.id },
          });
    }),
  ]);

  // Pay follows the roster: a staff member being paid for this event works
  // it, so they are put on "Staff on this event" (schedule, calendar, payroll
  // all read that). Removing them from the event later deletes their unpaid
  // comp row — lib/staffAssignmentsServer.removeEventStaff.
  for (const uid of new Set(userIds)) {
    if (userById.has(uid)) await addEventStaffIfMissing(clubId, event.id, uid);
  }

  const fresh = await loadEvent(id, clubId);
  return NextResponse.json(await compPayload(clubId, fresh!));
}
