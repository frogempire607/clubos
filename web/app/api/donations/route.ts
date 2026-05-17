import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/donations?entity=&from=&to= — recorded gifts for nonprofit entities.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "view");
  if (denied) return denied;

  const url = new URL(req.url);
  const entity = url.searchParams.get("entity");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const donations = await prisma.donation.findMany({
    where: {
      clubId: session.user.clubId,
      ...(entity && entity !== "all" ? { legalEntityId: entity } : {}),
      ...(from || to
        ? { date: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
        : {}),
    },
    orderBy: { date: "desc" },
    include: { legalEntity: { select: { id: true, name: true, entityType: true } } },
  });

  const total = donations.reduce((s, d) => s + Number(d.amount), 0);
  return NextResponse.json({ donations, total });
}

const schema = z.object({
  donorName: z.string().min(1),
  donorEmail: z.string().email().optional().or(z.literal("")),
  amount: z.number().positive(),
  fund: z.string().optional().nullable(),
  restricted: z.boolean().optional().default(false),
  sponsorship: z.boolean().optional().default(false),
  paymentMethod: z.string().optional().default("CASH"),
  date: z.string().optional().nullable(),
  receiptUrl: z.string().optional().nullable(),
  legalEntityId: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const donation = await prisma.donation.create({
    data: {
      clubId: session.user.clubId,
      donorName: data.donorName,
      donorEmail: data.donorEmail || null,
      amount: data.amount,
      fund: data.fund || null,
      restricted: data.restricted ?? false,
      sponsorship: data.sponsorship ?? false,
      paymentMethod: data.paymentMethod || "CASH",
      date: data.date ? new Date(data.date) : new Date(),
      receiptUrl: data.receiptUrl || null,
      legalEntityId: data.legalEntityId || null,
      notes: data.notes || null,
    },
  });
  return NextResponse.json(donation, { status: 201 });
}
