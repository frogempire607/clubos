import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolveFamilyContext } from "@/lib/memberContext";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { createProductBooking } from "@/lib/productBookingServer";

const schema = z.object({
  memberId: z.string().optional().nullable(),
  lengthKey: z.string().min(1).max(200),
  startsAt: z.string().min(10).max(40),
  guests: z.number().int().min(1).max(500).default(1),
  addOns: z.array(z.string().max(200)).max(30).default([]),
  answers: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  notes: z.string().max(1000).optional().nullable(),
});

// POST /api/member/products/[id]/book — B10 2f. A member (or a guardian for a
// child) books a rental / party. Money due now → Stripe Checkout; request-first
// or free → filed straight away. The server re-prices from the product's own
// tables and re-checks the slot; nothing the page computed is trusted.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rl = rateLimit({ key: `pbook:${session.user.id}`, limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a moment.");
  try {
    const body = schema.parse(await req.json().catch(() => ({})));
    const product = await prisma.product.findFirst({
      where: {
        id, clubId: session.user.clubId, deletedAt: null, active: true,
        visibility: { in: ["MEMBERS_ONLY", "MEMBERS_AND_PUBLIC"] },
        showLocation: { in: ["MEMBER_PORTAL", "PUBLIC_CHECKOUT"] },
      },
    });
    if (!product) return NextResponse.json({ error: "Not available" }, { status: 404 });
    const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { email: true, firstName: true, lastName: true } });
    const resolved = user ? await resolveFamilyContext(session.user.id, session.user.clubId, user.email, body.memberId ?? undefined) : null;
    if (resolved === "FORBIDDEN") return NextResponse.json({ error: "You can't book for that profile." }, { status: 403 });
    const member = resolved?.context ?? null;
    if (!member) return NextResponse.json({ error: "Your account isn't linked to a member profile yet. Contact your club." }, { status: 400 });
    if (await guardianActionBlocked(session.user.id, member.id)) return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });

    const base = getAppBaseUrl();
    const res = await createProductBooking({
      product,
      who: {
        memberId: member.id,
        guestName: `${user?.firstName ?? member.firstName ?? ""} ${user?.lastName ?? member.lastName ?? ""}`.trim() || null,
        guestEmail: user?.email ?? null,
        bookedByUserId: session.user.id,
      },
      request: body,
      channel: "MEMBER",
      successUrl: `${base}/member/products/${product.id}?booked=1`,
      cancelUrl: `${base}/member/products/${product.id}?canceled=1`,
    });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.status });
    return NextResponse.json({ ok: true, bookingId: res.bookingId, status: res.status, url: res.url });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
