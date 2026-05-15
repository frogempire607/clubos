import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/public/events/[slug]
// NO AUTH. Returns the public-safe view of an event for the /e/[slug] page:
// image, info, owner-defined registration form, and the price a non-member
// would pay. Only resolves events that have a publicSlug and are within their
// publish window.
export async function GET(_req: Request, context: { params: Promise<{ slug: string }> }) {
  const params = await context.params;
  const event = await prisma.event.findUnique({
    where: { publicSlug: params.slug },
    select: {
      id: true,
      name: true,
      description: true,
      startsAt: true,
      endsAt: true,
      imageUrl: true,
      capacity: true,
      nonMemberPrice: true,
      publicRegistration: true,
      publicFormIntro: true,
      registrationForm: true,
      isTournament: true,
      tournamentMode: true,
      variableCostEnabled: true,
      variableCostMode: true,
      variableCostTotal: true,
      variableCostEstimatedSignups: true,
      publishAt: true,
      unpublishAt: true,
      deletedAt: true,
      registrationDeadline: true,
      location: { select: { name: true, address: true } },
      club: { select: { name: true, logoUrl: true, primaryColor: true } },
      _count: { select: { registrations: true, bookings: true } },
    },
  });

  if (!event || event.deletedAt) {
    return NextResponse.json({ error: "Event not found" }, { status: 404 });
  }

  const now = new Date();
  if (event.publishAt && event.publishAt > now) {
    return NextResponse.json({ error: "Registration is not open yet" }, { status: 403 });
  }
  if (event.unpublishAt && event.unpublishAt < now) {
    return NextResponse.json({ error: "Registration has closed" }, { status: 403 });
  }
  if (event.registrationDeadline && event.registrationDeadline < now) {
    return NextResponse.json({ error: "The registration deadline has passed" }, { status: 403 });
  }

  // Compute the price a public registrant pays.
  let price: number | null = null;
  let priceLabel = "Free";
  if (
    event.variableCostEnabled &&
    event.variableCostMode === "ESTIMATED" &&
    event.variableCostTotal &&
    event.variableCostEstimatedSignups
  ) {
    price = +(Number(event.variableCostTotal) / event.variableCostEstimatedSignups).toFixed(2);
    priceLabel = `$${price.toFixed(2)} (estimated split)`;
  } else if (event.nonMemberPrice && Number(event.nonMemberPrice) > 0) {
    price = Number(event.nonMemberPrice);
    priceLabel = `$${price.toFixed(2)}`;
  } else if (
    event.variableCostEnabled &&
    event.variableCostMode === "OFFICIAL"
  ) {
    priceLabel = "Cost billed after the tournament";
  }

  const capacityReached =
    event.capacity != null &&
    event._count.registrations + event._count.bookings >= event.capacity;

  return NextResponse.json({
    id: event.id,
    name: event.name,
    description: event.description,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    imageUrl: event.imageUrl,
    location: event.location,
    club: event.club,
    isTournament: event.isTournament,
    tournamentMode: event.tournamentMode,
    publicFormIntro: event.publicFormIntro,
    registrationForm: event.registrationForm ?? [],
    price,
    priceLabel,
    capacityReached,
    registrationOpen:
      (event.publicRegistration || event.tournamentMode === "HOST") && !capacityReached,
  });
}
