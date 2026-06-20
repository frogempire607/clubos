import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";

// Purchases a guardian can move between their family profiles. Reassigning is
// just changing which member a purchase is attributed to — used to fix a buy
// made under the wrong child. Scoped to memberships + product sales (items tied
// to a schedule, like event/class/private bookings, aren't reassignable here).

async function accessibleIds(userId: string, clubId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return null;
  const resolved = await resolveFamilyContext(userId, clubId, user.email);
  if (resolved === "FORBIDDEN") return null;
  return resolved.accessible;
}

// GET /api/member/family/[memberId]/purchases
// This profile's reassignable purchases + the other family profiles to move to.
export async function GET(_req: Request, context: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const accessible = await accessibleIds(session.user.id, session.user.clubId);
  if (!accessible || !accessible.some((m) => m.id === memberId)) {
    return NextResponse.json({ error: "You can't manage that profile." }, { status: 403 });
  }

  const [subs, sales] = await Promise.all([
    prisma.memberSubscription.findMany({
      where: { memberId, status: { in: ["active", "past_due", "pending"] } },
      orderBy: { createdAt: "desc" },
      select: { id: true, optionLabel: true, status: true, membership: { select: { name: true } } },
    }),
    prisma.productSale.findMany({
      where: { memberId, clubId: session.user.clubId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, quantity: true, status: true, product: { select: { name: true } } },
    }),
  ]);

  return NextResponse.json({
    purchases: [
      ...subs.map((s) => ({
        type: "subscription" as const,
        id: s.id,
        label: `${s.membership?.name ?? "Membership"}${s.optionLabel ? ` — ${s.optionLabel}` : ""}`,
        status: s.status,
      })),
      ...sales.map((s) => ({
        type: "sale" as const,
        id: s.id,
        label: `${s.product?.name ?? "Product"}${s.quantity > 1 ? ` ×${s.quantity}` : ""}`,
        status: s.status,
      })),
    ],
    targets: accessible
      .filter((m) => m.id !== memberId)
      .map((m) => ({ id: m.id, firstName: m.firstName, lastName: m.lastName, kind: m.kind })),
  });
}

const reassignSchema = z.object({
  type: z.enum(["subscription", "sale"]),
  id: z.string(),
  targetMemberId: z.string(),
});

// POST /api/member/family/[memberId]/purchases — reassign a purchase to another
// profile in the same family.
export async function POST(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof reassignSchema>;
  try {
    body = reassignSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const accessible = await accessibleIds(session.user.id, session.user.clubId);
  if (!accessible) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const ids = new Set(accessible.map((m) => m.id));
  // The guardian must control BOTH the source and the destination profile.
  if (!ids.has(memberId) || !ids.has(body.targetMemberId)) {
    return NextResponse.json({ error: "You can't manage one of those profiles." }, { status: 403 });
  }
  if (memberId === body.targetMemberId) {
    return NextResponse.json({ error: "Pick a different profile to move it to." }, { status: 400 });
  }

  if (body.type === "subscription") {
    const sub = await prisma.memberSubscription.findFirst({ where: { id: body.id, memberId } });
    if (!sub) return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
    await prisma.memberSubscription.update({ where: { id: sub.id }, data: { memberId: body.targetMemberId } });
  } else {
    const sale = await prisma.productSale.findFirst({
      where: { id: body.id, memberId, clubId: session.user.clubId },
    });
    if (!sale) return NextResponse.json({ error: "Purchase not found." }, { status: 404 });
    await prisma.productSale.update({ where: { id: sale.id }, data: { memberId: body.targetMemberId } });
  }

  return NextResponse.json({ ok: true });
}
