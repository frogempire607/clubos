import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { PAYEE_TYPES, PAYOUT_KINDS, PAYOUT_METHODS, payeeUsesContractor } from "@/lib/payouts";

// GET /api/payouts  (finances:view)
// Returns the payout ledger PLUS picker data (staff, contractors, events) so the
// dashboard page doesn't depend on the owner-only /api/staff endpoint.
export async function GET() {
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  const [payouts, staffRows, contractors, events] = await Promise.all([
    prisma.payout.findMany({ where: { clubId }, orderBy: { createdAt: "desc" } }),
    prisma.user.findMany({
      where: { clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
      select: { id: true, firstName: true, lastName: true, role: true },
      orderBy: [{ firstName: "asc" }],
    }),
    prisma.contractor.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, name: true, role: true, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.event.findMany({
      where: { clubId, deletedAt: null },
      select: { id: true, name: true, startsAt: true },
      orderBy: { startsAt: "desc" },
      take: 100,
    }),
  ]);

  const eventName = new Map(events.map((e) => [e.id, e.name]));

  return NextResponse.json({
    payouts: payouts.map((p) => ({
      ...p,
      amount: Number(p.amount),
      eventName: p.eventId ? eventName.get(p.eventId) ?? null : null,
    })),
    staff: staffRows.map((u) => ({
      id: u.id,
      name: `${u.firstName} ${u.lastName}`.trim(),
      role: u.role,
    })),
    contractors,
    events,
  });
}

const createSchema = z.object({
  payeeType: z.enum(PAYEE_TYPES),
  payeeUserId: z.string().optional().nullable(),
  contractorId: z.string().optional().nullable(),
  payeeName: z.string().trim().max(160).optional().nullable(),
  kind: z.enum(PAYOUT_KINDS).default("OTHER"),
  eventId: z.string().optional().nullable(),
  amount: z.number().positive().max(1_000_000),
  status: z.enum(["PENDING", "PAID"]).default("PENDING"),
  method: z.enum(PAYOUT_METHODS).optional().nullable(),
  paidAt: z.string().optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

// POST /api/payouts  (finances:full) — record a payout (PENDING or PAID).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Resolve + validate the payee (club-scoped) and a display name.
  let payeeName = data.payeeName?.trim() || "";
  let payeeUserId: string | null = null;
  let contractorId: string | null = null;

  if (payeeUsesContractor(data.payeeType)) {
    if (data.contractorId) {
      const c = await prisma.contractor.findFirst({
        where: { id: data.contractorId, clubId, deletedAt: null },
        select: { id: true, name: true },
      });
      if (!c) return NextResponse.json({ error: "Contractor not found." }, { status: 400 });
      contractorId = c.id;
      if (!payeeName) payeeName = c.name;
    }
  } else {
    if (data.payeeUserId) {
      const u = await prisma.user.findFirst({
        where: { id: data.payeeUserId, clubId, deletedAt: null, role: { in: ["OWNER", "STAFF"] } },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!u) return NextResponse.json({ error: "Staff member not found." }, { status: 400 });
      payeeUserId = u.id;
      if (!payeeName) payeeName = `${u.firstName} ${u.lastName}`.trim();
    }
  }

  if (!payeeName) {
    return NextResponse.json({ error: "Choose a payee or enter a name." }, { status: 400 });
  }

  if (data.eventId) {
    const ev = await prisma.event.findFirst({
      where: { id: data.eventId, clubId, deletedAt: null },
      select: { id: true },
    });
    if (!ev) return NextResponse.json({ error: "Event not found." }, { status: 400 });
  }

  const paid = data.status === "PAID";
  const payout = await prisma.payout.create({
    data: {
      clubId,
      payeeType: data.payeeType,
      payeeUserId,
      contractorId,
      payeeName,
      kind: data.kind,
      eventId: data.eventId || null,
      amount: data.amount,
      status: data.status,
      method: data.method ?? null,
      paidAt: paid ? (data.paidAt ? new Date(data.paidAt) : new Date()) : null,
      notes: data.notes ?? null,
      createdById: session!.user.id ?? null,
    },
  });

  return NextResponse.json({ ...payout, amount: Number(payout.amount) }, { status: 201 });
}
