import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { isBookable, normalizeProductSettings } from "@/lib/productSettings";
import { lengthOptions } from "@/lib/productBooking";
import { clubTimezone, createProductBooking } from "@/lib/productBookingServer";

// GET /api/products/bookings?from=ISO&to=ISO — B10 2d. Every booking of every
// Bookable product in the range (the week grid + the list), the bookable
// products with their options (for + Add booking), and the club timezone.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "events", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  const url = new URL(req.url);
  const from = new Date(url.searchParams.get("from") ?? Date.now() - 7 * 86_400_000);
  const to = new Date(url.searchParams.get("to") ?? Date.now() + 14 * 86_400_000);
  const [rows, products, pending, tz] = await Promise.all([
    prisma.productBooking.findMany({
      where: { clubId, startsAt: { gte: from, lt: to }, status: { notIn: ["DECLINED"] } },
      orderBy: { startsAt: "asc" },
      include: { product: { select: { id: true, name: true } } },
    }),
    prisma.product.findMany({
      where: { clubId, deletedAt: null, productType: { in: ["BOOKABLE", "FACILITY_RENTAL", "BIRTHDAY_PARTY"] } },
      select: { id: true, name: true, price: true, settings: true, active: true },
      orderBy: { name: "asc" },
    }),
    prisma.productBooking.count({ where: { clubId, status: "PENDING" } }),
    clubTimezone(clubId),
  ]);
  const memberIds = Array.from(new Set(rows.map((r) => r.memberId).filter((x): x is string => !!x)));
  const members = memberIds.length ? await prisma.member.findMany({ where: { id: { in: memberIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const nameOf = new Map(members.map((m) => [m.id, `${m.firstName} ${m.lastName ?? ""}`.trim()]));
  return NextResponse.json({
    tz,
    pendingTotal: pending,
    bookings: rows.map((b) => ({
      id: b.id, productId: b.productId, productName: b.product.name, status: b.status, paymentMode: b.paymentMode,
      who: (b.memberId && nameOf.get(b.memberId)) || b.guestName || "Guest", memberId: b.memberId, email: b.guestEmail, phone: b.guestPhone,
      tierName: b.tierName, durationMins: b.durationMins, startsAt: b.startsAt, endsAt: b.endsAt, guests: b.guests,
      addOns: b.addOns, answers: b.answers, amountTotal: Number(b.amountTotal), dueNow: Number(b.dueNow), amountPaid: Number(b.amountPaid),
      paidByCard: !!b.stripePaymentIntentId, notes: b.notes, declinedReason: b.declinedReason,
    })),
    products: products.map((p) => {
      const s = normalizeProductSettings(p.settings);
      return { id: p.id, name: p.name, active: p.active, options: lengthOptions(s, Number(p.price)), addOns: s.addOns.filter((a) => a.price != null), maxGuests: s.maxGuests };
    }),
  });
}

const addSchema = z.object({
  productId: z.string().min(1),
  memberId: z.string().optional().nullable(),
  guestName: z.string().max(120).optional().nullable(),
  guestEmail: z.string().email().max(200).optional().nullable().or(z.literal("")),
  guestPhone: z.string().max(40).optional().nullable(),
  lengthKey: z.string().min(1).max(200),
  startsAt: z.string().min(10).max(40),
  guests: z.number().int().min(1).max(500).default(1),
  addOns: z.array(z.string().max(200)).max(30).default([]),
  answers: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  notes: z.string().max(1000).optional().nullable(),
  cashNow: z.number().min(0).optional().nullable(),
});

// POST /api/products/bookings — "+ Add booking" at the front desk: confirmed
// at once (a phone booking), optionally with cash taken now.
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "events", "edit");
  if (denied) return denied;
  try {
    const body = addSchema.parse(await req.json());
    const product = await prisma.product.findFirst({ where: { id: body.productId, clubId: session.user.clubId, deletedAt: null } });
    if (!product || !isBookable(product.productType)) return NextResponse.json({ error: "Pick a bookable product." }, { status: 404 });
    if (body.memberId) {
      const m = await prisma.member.findFirst({ where: { id: body.memberId, clubId: session.user.clubId }, select: { id: true } });
      if (!m) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    } else if (!body.guestName?.trim()) {
      return NextResponse.json({ error: "Pick a member or type the guest's name." }, { status: 400 });
    }
    const res = await createProductBooking({
      product,
      who: { memberId: body.memberId ?? null, guestName: body.guestName ?? null, guestEmail: body.guestEmail || null, guestPhone: body.guestPhone ?? null, bookedByUserId: session.user.id },
      request: body,
      channel: "STAFF",
      staffCash: body.cashNow ?? 0,
    });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.status });
    return NextResponse.json({ ok: true, bookingId: res.bookingId }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
