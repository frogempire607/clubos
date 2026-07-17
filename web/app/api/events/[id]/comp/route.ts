import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
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
  const denied = requirePermission(session, "finances", "view");
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
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;
  const clubId = session.user.clubId;

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
      where: { id: { in: userIds }, clubId, deletedAt: null },
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
    select: { id: true, payoutId: true },
  });
  const existingById = new Map(existing.map((e) => [e.id, e]));
  const keptIds = new Set(assignments.map((a) => a.id).filter(Boolean) as string[]);

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

  const fresh = await loadEvent(id, clubId);
  return NextResponse.json(await compPayload(clubId, fresh!));
}
