import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Owner/staff manage event bundles (#3): discounted packages of events.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const bundles = await prisma.eventBundle.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: {
      items: {
        include: {
          event: {
            select: { id: true, name: true, startsAt: true, memberPrice: true, nonMemberPrice: true },
          },
        },
      },
    },
  });
  return NextResponse.json(bundles);
}

const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().max(2000).optional().nullable(),
  price: z.number().nonnegative(),
  published: z.boolean().default(false),
  eventIds: z.array(z.string()).default([]),
  // Payment methods buyers may choose (lib/bundlePurchases.ts). null/empty =
  // card only. Saved-card pay-now is offered automatically with CARD.
  paymentMethods: z.array(z.enum(["CARD", "CASH", "CHECK", "PAY_LATER"])).optional().nullable(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const data = createSchema.parse(await req.json());
    // Only attach events that actually belong to this club.
    const validIds = data.eventIds.length
      ? (
          await prisma.event.findMany({
            where: { id: { in: data.eventIds }, clubId: session.user.clubId, deletedAt: null },
            select: { id: true },
          })
        ).map((e) => e.id)
      : [];

    const bundle = await prisma.eventBundle.create({
      data: {
        clubId: session.user.clubId,
        name: data.name,
        description: data.description?.trim() || null,
        price: data.price,
        published: data.published,
        paymentMethods: data.paymentMethods ?? undefined,
        items: { create: validIds.map((eventId) => ({ eventId })) },
      },
      include: { items: true },
    });
    return NextResponse.json(bundle, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
