import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { publicClubLogoUrl } from "@/lib/clubLogo";

// GET /api/checkin/[id] — PUBLIC (no auth). Minimal display data for the
// walk-in QR landing page. `id` is a ClassSession id or an Event id.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const ses = await prisma.classSession.findUnique({
    where: { id },
    select: {
      startsAt: true,
      endsAt: true,
      recurringClass: { select: { name: true } },
      club: { select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true } },
    },
  });

  if (ses) {
    return NextResponse.json({
      kind: "class",
      title: ses.recurringClass.name,
      // Class sessions store wall-clock as UTC — format in UTC.
      dateLabel: ses.startsAt.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
      }),
      timeLabel: ses.startsAt.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: "UTC",
      }),
      // This page is viewed logged-out — the raw logoUrl is session-gated.
      club: { ...ses.club, logoUrl: publicClubLogoUrl(ses.club.id, ses.club.logoUrl) },
    });
  }

  const ev = await prisma.event.findUnique({
    where: { id },
    select: {
      name: true,
      startsAt: true,
      club: { select: { id: true, name: true, slug: true, logoUrl: true, primaryColor: true } },
    },
  });

  if (ev) {
    return NextResponse.json({
      kind: "event",
      title: ev.name,
      // Events are true instants — local time.
      dateLabel: ev.startsAt.toLocaleDateString("en-US", {
        weekday: "long", month: "long", day: "numeric",
      }),
      timeLabel: ev.startsAt.toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit",
      }),
      club: { ...ev.club, logoUrl: publicClubLogoUrl(ev.club.id, ev.club.logoUrl) },
    });
  }

  return NextResponse.json({ error: "Not found" }, { status: 404 });
}
