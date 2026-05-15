import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// GET /api/events/[id]/registrations
// Owner/staff: list everyone who signed up via the public link (or was matched
// as a member), with their custom form answers and payment status.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const event = await prisma.event.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      publicSlug: true,
      registrationForm: true,
      variableCostEnabled: true,
      variableCostMode: true,
      variableCostTotal: true,
      variableCostEstimatedSignups: true,
      variableCostBilledAt: true,
    },
  });
  if (!event) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const registrations = await prisma.eventRegistration.findMany({
    where: { eventId: event.id },
    orderBy: { createdAt: "asc" },
    include: { member: { select: { id: true, firstName: true, lastName: true } } },
  });

  const activeCount = registrations.filter((r) => r.status !== "CANCELED").length;
  const officialPerHead =
    event.variableCostEnabled &&
    event.variableCostMode === "OFFICIAL" &&
    event.variableCostTotal &&
    activeCount > 0
      ? +(Number(event.variableCostTotal) / activeCount).toFixed(2)
      : null;

  return NextResponse.json({ event, registrations, activeCount, officialPerHead });
}
