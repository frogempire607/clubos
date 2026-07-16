import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const upcoming = searchParams.get("upcoming") === "true";

  const events = await prisma.event.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(upcoming ? { endsAt: { gte: new Date() } } : {}),
    },
    orderBy: { startsAt: "asc" },
    include: {
      location: { select: { name: true } },
      customEventType: { select: { id: true, name: true, color: true, textColor: true } },
      sessions: { orderBy: { sortOrder: "asc" } },
      staffAssignments: { include: { user: { select: { id: true, firstName: true, lastName: true } } } },
      _count: { select: { bookings: true, registrations: true } },
    },
  });

  return NextResponse.json(events);
}

const sessionSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  sortOrder: z.number().int().default(0),
});

const formFieldSchema = z.object({
  id: z.string(),
  label: z.string().min(1),
  type: z.enum(["text", "email", "phone", "textarea", "select", "checkbox"]),
  required: z.boolean().default(false),
  options: z.array(z.string()).optional(),
});

// Shared event fields used by both create and update.
const eventFields = {
  type: z.enum(["CLASS", "PRIVATE", "CLINIC", "CAMP", "TOURNAMENT", "OTHER"]),
  customEventTypeId: z.string().optional().nullable(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  capacity: z.number().int().positive().optional().nullable(),
  memberPrice: z.number().min(0).optional().nullable(),
  nonMemberPrice: z.number().min(0).optional().nullable(),
  dropInFee: z.number().min(0).optional().nullable(),
  travelFee: z.number().min(0).optional().nullable(),
  publishAt: z.string().optional().nullable(),
  unpublishAt: z.string().optional().nullable(),
  locationId: z.string().optional().nullable(),
  visibility: z.enum(["PUBLIC", "MEMBERS_ONLY", "STAFF_ONLY"]),
  purchaseAccess: z.enum(["ANYONE", "STAFF_ONLY"]),
  allowMembershipPayment: z.boolean(),
  imageUrl: z.string().optional().nullable(),
  imagePositionX: z.number().min(0).max(100).optional(),
  imagePositionY: z.number().min(0).max(100).optional(),
  pricingOptions: z.array(z.object({ type: z.literal("membership"), membershipId: z.string() })),
  staffUserIds: z.array(z.string()),
  sessions: z.array(sessionSchema).optional(),
  // Tournament + public-registration fields
  tournamentMode: z.enum(["HOST", "ATTEND"]).optional().nullable(),
  registrationForm: z.array(formFieldSchema).optional().nullable(),
  publicRegistration: z.boolean().optional(),
  publicFormIntro: z.string().optional().nullable(),
  publicPricingOption: z.enum(["MEMBER", "NON_MEMBER", "DROP_IN"]).optional().nullable(),
  variableCostEnabled: z.boolean().optional(),
  variableCostMode: z.enum(["ESTIMATED", "OFFICIAL"]).optional().nullable(),
  variableCostTotal: z.number().min(0).optional().nullable(),
  variableCostEstimatedSignups: z.number().int().positive().optional().nullable(),
  variableCostEstimatedTotal: z.number().min(0).optional().nullable(),
  invoiceScheduledAt: z.string().optional().nullable(),
  // Registration payment decision (lib/eventPayments.ts model)
  paymentMethods: z.array(z.enum(["CARD", "AUTO_CARD", "CASH", "CHECK"])).optional().nullable(),
  autoChargeDate: z.string().optional().nullable(),
  requirePaymentBeforeCheckin: z.boolean().optional(),
};

const createSchema = z.object({
  ...eventFields,
  type: eventFields.type.default("OTHER"),
  description: z.string().optional(),
  visibility: eventFields.visibility.default("PUBLIC"),
  purchaseAccess: eventFields.purchaseAccess.default("ANYONE"),
  allowMembershipPayment: z.boolean().default(false),
  pricingOptions: eventFields.pricingOptions.default([]),
  staffUserIds: z.array(z.string()).default([]),
});

// Slugify + ensure uniqueness for the public registration link.
async function uniqueSlug(name: string): Promise<string> {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "event";
  let slug = base;
  let n = 1;
  // Loop until we find an unused slug. Bounded by a sane cap.
  while (n < 50) {
    const existing = await prisma.event.findUnique({ where: { publicSlug: slug }, select: { id: true } });
    if (!existing) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const startsAt = new Date(data.startsAt);
    const endsAt = new Date(data.endsAt);

    if (endsAt <= startsAt) {
      return NextResponse.json({ error: "End time must be after start time" }, { status: 400 });
    }

    // Determine the base type: use OTHER when a custom type is selected
    const baseType = data.customEventTypeId ? "OTHER" : (data.type || "OTHER");
    const isTournament = baseType === "TOURNAMENT";

    // Generate a public slug whenever public registration is on (or it's a
    // hosted tournament, which is inherently public-facing).
    const needsSlug =
      data.publicRegistration || (isTournament && data.tournamentMode === "HOST");
    const publicSlug = needsSlug ? await uniqueSlug(data.name) : null;

    const event = await prisma.event.create({
      data: {
        clubId: session.user.clubId,
        type: baseType,
        customEventTypeId: data.customEventTypeId || null,
        name: data.name,
        description: data.description || null,
        startsAt,
        endsAt,
        capacity: data.capacity || null,
        memberPrice: data.memberPrice ?? null,
        nonMemberPrice: data.nonMemberPrice ?? null,
        dropInFee: data.dropInFee ?? null,
        travelFee: data.travelFee ?? null,
        publishAt: data.publishAt ? new Date(data.publishAt) : null,
        unpublishAt: data.unpublishAt ? new Date(data.unpublishAt) : null,
        locationId: data.locationId || null,
        visibility: data.visibility,
        purchaseAccess: data.purchaseAccess,
        allowMembershipPayment: data.allowMembershipPayment,
        imageUrl: data.imageUrl ?? null,
        imagePositionX: data.imagePositionX ?? 50,
        imagePositionY: data.imagePositionY ?? 50,
        pricingOptions: data.pricingOptions,
        isTournament,
        tournamentMode: isTournament ? (data.tournamentMode ?? null) : null,
        registrationForm: data.registrationForm ?? undefined,
        publicRegistration: data.publicRegistration ?? false,
        publicSlug,
        publicFormIntro: data.publicFormIntro ?? null,
        publicPricingOption: data.publicPricingOption ?? null,
        variableCostEnabled: data.variableCostEnabled ?? false,
        variableCostMode: data.variableCostEnabled ? (data.variableCostMode ?? null) : null,
        variableCostTotal: data.variableCostEnabled ? (data.variableCostTotal ?? null) : null,
        variableCostEstimatedSignups: data.variableCostEnabled
          ? (data.variableCostEstimatedSignups ?? null)
          : null,
        variableCostEstimatedTotal: data.variableCostEnabled
          ? (data.variableCostEstimatedTotal ?? null)
          : null,
        invoiceScheduledAt:
          data.variableCostEnabled && data.invoiceScheduledAt
            ? new Date(data.invoiceScheduledAt)
            : null,
        paymentMethods: data.paymentMethods ?? undefined,
        autoChargeDate: data.autoChargeDate ? new Date(data.autoChargeDate) : null,
        requirePaymentBeforeCheckin: data.requirePaymentBeforeCheckin ?? false,
        sessions: data.sessions?.length
          ? {
              create: data.sessions.map((s, i) => ({
                name: s.name || null,
                startsAt: new Date(s.startsAt),
                endsAt: new Date(s.endsAt),
                sortOrder: s.sortOrder ?? i,
              })),
            }
          : undefined,
      },
    });

    if (data.staffUserIds.length > 0) {
      await prisma.eventStaffAssignment.createMany({
        data: data.staffUserIds.map((userId) => ({
          clubId: session.user.clubId,
          eventId: event.id,
          userId,
          role: "COACH",
        })),
        skipDuplicates: true,
      });
    }

    return NextResponse.json(event, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
