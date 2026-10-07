import { NextResponse } from "next/server";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive, isOwnerLive } from "@/lib/apiGuard";
import { PAYEE_TYPES, PAYOUT_KINDS, PAYOUT_METHODS, payeeUsesContractor } from "@/lib/payouts";

// GET /api/payouts  (finances:view)
// Returns the payout ledger PLUS picker data (staff, contractors, events) so the
// dashboard page doesn't depend on the owner-only /api/staff endpoint.
export async function GET() {
  const session = await getServerSession(authOptions);
  const denied = await requirePermissionLive(session, "finances", "view");
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
  // Pay-ledger payouts settle specific pay lines; the page shows how many.
  const lineRows = payouts.length
    ? await prisma.payLine.findMany({ where: { clubId, payoutId: { in: payouts.map((p) => p.id) } }, select: { payoutId: true } })
    : [];
  const lineCount = new Map<string, number>();
  for (const l of lineRows) if (l.payoutId) lineCount.set(l.payoutId, (lineCount.get(l.payoutId) ?? 0) + 1);

  return NextResponse.json({
    payouts: payouts.map((p) => ({
      ...p,
      amount: Number(p.amount),
      eventName: p.eventId ? eventName.get(p.eventId) ?? null : null,
      lineCount: lineCount.get(p.id) ?? 0,
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
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session!.user.clubId;

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
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
      // Julian's rule: staff never touch their own pay — that includes
      // recording a payout to themselves. Owners are exempt.
      if (selfRule(session!.user.role, session!.user.id, u.id, "edit_pay") === "deny") {
        return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
      }
      payeeUserId = u.id;
      if (!payeeName) payeeName = `${u.firstName} ${u.lastName}`.trim();
    }
  }

  if (!payeeName) {
    return NextResponse.json({ error: "Choose a payee or enter a name." }, { status: 400 });
  }

  // A payout to a typed-in name (no staff member, no contractor on file) cannot
  // be checked against the self rule — a manager could pay "themself by name".
  // So free-text payees are owner-only (verified live). Everyone else picks a
  // staff member (self is refused above) or a contractor on file.
  if (!payeeUserId && !contractorId && !(await isOwnerLive(session))) {
    return NextResponse.json(
      { error: "Only an owner can record a payout to a typed-in name. Pick a staff member or a contractor on file.", code: "OWNER_REQUIRED" },
      { status: 403 },
    );
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
