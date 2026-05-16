import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";

// GET /api/contractors — list active + archived contractors with payment totals.
export async function GET() {
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  const contractors = await prisma.contractor.findMany({
    where: { clubId: session!.user.clubId, deletedAt: null },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    include: {
      payments: { select: { amount: true, date: true } },
    },
  });

  const shaped = contractors.map((c) => {
    const total = c.payments.reduce((s, p) => s + Number(p.amount), 0);
    const lastPaid = c.payments.reduce<Date | null>(
      (acc, p) => (!acc || p.date > acc ? p.date : acc),
      null,
    );
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      phone: c.phone,
      role: c.role,
      w9Url: c.w9Url,
      payoutNotes: c.payoutNotes,
      active: c.active,
      convertedUserId: c.convertedUserId,
      paymentCount: c.payments.length,
      totalPaid: total,
      lastPaidAt: lastPaid ? lastPaid.toISOString() : null,
    };
  });

  return NextResponse.json(shaped);
}

const createSchema = z.object({
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  role: z.string().optional().or(z.literal("")),
  w9Url: z.string().optional().or(z.literal("")),
  payoutNotes: z.string().optional().or(z.literal("")),
});

// POST /api/contractors — create a lightweight contractor (no auth account).
// Requires a name and at least one of email / W9 on file.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  const denied = requireOwner(session);
  if (denied) return denied;

  let data: z.infer<typeof createSchema>;
  try {
    data = createSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  if (!data.email && !data.w9Url) {
    return NextResponse.json(
      { error: "Add an email address or upload a W-9 so this contractor can be paid." },
      { status: 400 },
    );
  }

  const contractor = await prisma.contractor.create({
    data: {
      clubId: session!.user.clubId,
      name: data.name,
      email: data.email || null,
      phone: data.phone || null,
      role: data.role || null,
      w9Url: data.w9Url || null,
      payoutNotes: data.payoutNotes || null,
    },
  });

  return NextResponse.json(contractor, { status: 201 });
}
