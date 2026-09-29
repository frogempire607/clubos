import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { ACTIVE_REGISTRATION_STATUSES } from "@/lib/eventPayments";
import { formatZodError } from "@/lib/zodErrors";
import { linkBookingNeeded, nameKey } from "@/lib/registrationLink";

// /api/events/[id]/registrations/[regId]/link-member
//
// A public signup (no account → no memberId) for someone who IS in the club —
// typically an imported PROSPECT with no email, which the public form had no
// way to match. Until it is linked, check-in, attendance and the member's
// history can't see the registration.
//
//   GET  ?q=   suggestions (exact name, case/space-insensitive) + search results
//   POST { memberId }   link it — staff always confirm; nothing auto-links.
//
// Gated events:edit (it changes who a registration belongs to) AND
// members:view (it reads and names club members).
//
// Refused when the registration is already linked, or the member already has
// a live registration on this event (that would be two rows for one person).
//
// Booking: a linked registration that already holds a confirmed spot (active
// status, not waiting on a coach) gets the CONFIRMED Booking approval would
// have created for a member registration (lib/eventApproval.approveRegistration).
// A registration still under review gets none — approving it creates it, the
// same as for any member registration.

async function guard(eventId: string, regId: string) {
  const session = await getServerSession(authOptions);
  if (!session) return { res: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const denied = (await requirePermissionLive(session, "events", "edit")) ?? (await requirePermissionLive(session, "members", "view"));
  if (denied) return { res: denied };
  const clubId = session.user.clubId;
  const reg = await prisma.eventRegistration.findFirst({
    where: { id: regId, eventId, clubId, event: { deletedAt: null } },
    select: { id: true, name: true, memberId: true, status: true, approvalStatus: true, eventId: true, event: { select: { name: true } } },
  });
  if (!reg) return { res: NextResponse.json({ error: "Registration not found" }, { status: 404 }) };
  return { session, clubId, reg };
}

const MEMBER_SELECT = { id: true, firstName: true, lastName: true, status: true, dateOfBirth: true, email: true, guardianName: true } as const;

export async function GET(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const g = await guard(eventId, regId);
  if ("res" in g) return g.res;
  const { clubId, reg } = g;

  const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 80);
  const wanted = nameKey(reg.name);
  const parts = reg.name.trim().split(/\s+/);
  const first = parts[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1] : "";

  // Exact-name candidates: narrow in SQL on first/last (insensitive), then
  // compare the whole normalized name here so "Eli  Fasulo" = "eli fasulo".
  const candidates = first
    ? await prisma.member.findMany({
        where: {
          clubId,
          deletedAt: null,
          firstName: { equals: first, mode: "insensitive" },
          ...(last ? { lastName: { equals: last, mode: "insensitive" } } : {}),
        },
        select: MEMBER_SELECT,
        take: 20,
      })
    : [];
  const suggestions = candidates.filter((m) => nameKey(`${m.firstName} ${m.lastName}`) === wanted);

  let results: typeof candidates = [];
  if (q.length >= 2) {
    const words = q.split(/\s+/).filter(Boolean).slice(0, 3);
    results = await prisma.member.findMany({
      where: {
        clubId,
        deletedAt: null,
        AND: words.map((w) => ({
          OR: [{ firstName: { contains: w, mode: "insensitive" as const } }, { lastName: { contains: w, mode: "insensitive" as const } }],
        })),
      },
      select: MEMBER_SELECT,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 20,
    });
  }

  // Who already has a live registration here — shown, not offered.
  const ids = [...suggestions, ...results].map((m) => m.id);
  const taken = ids.length
    ? await prisma.eventRegistration.findMany({
        where: { eventId: reg.eventId, memberId: { in: ids }, status: { not: "CANCELED" } },
        select: { memberId: true },
      })
    : [];
  const takenSet = new Set(taken.map((t) => t.memberId));
  const view = (m: (typeof candidates)[number]) => ({
    id: m.id,
    name: `${m.firstName} ${m.lastName}`.trim(),
    status: m.status,
    dateOfBirth: m.dateOfBirth ? m.dateOfBirth.toISOString().slice(0, 10) : null,
    hasEmail: !!m.email,
    guardianName: m.guardianName,
    alreadyRegistered: takenSet.has(m.id),
  });

  return NextResponse.json({
    registration: { id: reg.id, name: reg.name, memberId: reg.memberId },
    suggestions: suggestions.map(view),
    results: results.map(view),
  });
}

const bodySchema = z.object({ memberId: z.string().min(1).max(64) });

export async function POST(req: Request, context: { params: Promise<{ id: string; regId: string }> }) {
  const { id: eventId, regId } = await context.params;
  const g = await guard(eventId, regId);
  if ("res" in g) return g.res;
  const { session, clubId } = g;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const out = await prisma.$transaction(async (db) => {
    // Same per-registration lock approve/decline take, so a link can't race a decision.
    await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`evreg-mut:${regId}`}, 0))`;
    const reg = await db.eventRegistration.findFirst({
      where: { id: regId, eventId, clubId },
      select: { id: true, name: true, memberId: true, status: true, approvalStatus: true, eventId: true },
    });
    if (!reg) return { status: 404, body: { error: "Registration not found" } };
    if (reg.memberId) {
      return { status: 409, body: { error: "ALREADY_LINKED", message: `${reg.name} is already linked to a member.` } };
    }
    const member = await db.member.findFirst({
      where: { id: body.memberId, clubId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true },
    });
    if (!member) return { status: 404, body: { error: "Member not found" } };
    const memberName = `${member.firstName} ${member.lastName}`.trim();

    const dup = await db.eventRegistration.findFirst({
      where: { eventId: reg.eventId, memberId: member.id, status: { not: "CANCELED" }, id: { not: reg.id } },
      select: { id: true },
    });
    if (dup) {
      return {
        status: 409,
        body: { error: "ALREADY_REGISTERED", message: `${memberName} already has a registration on this event — remove one of the two instead of linking.` },
      };
    }

    await db.eventRegistration.update({ where: { id: reg.id }, data: { memberId: member.id } });

    let booking: "created" | "reconfirmed" | "existing" | "none" = "none";
    if (linkBookingNeeded(reg, ACTIVE_REGISTRATION_STATUSES)) {
      const existing = await db.booking.findUnique({
        where: { eventId_memberId: { eventId: reg.eventId, memberId: member.id } },
        select: { id: true, status: true },
      });
      if (!existing) {
        await db.booking.create({
          data: { eventId: reg.eventId, memberId: member.id, status: "CONFIRMED", bookedByUserId: session.user.id ?? null },
        });
        booking = "created";
      } else if (existing.status === "CANCELED") {
        await db.booking.update({ where: { id: existing.id }, data: { status: "CONFIRMED" } });
        booking = "reconfirmed";
      } else booking = "existing";
    }
    return { status: 200, body: { ok: true, registrationId: reg.id, memberId: member.id, memberName, booking } };
  });

  if (out.status !== 200) return NextResponse.json(out.body, { status: out.status });

  await writeBillingAudit({
    clubId,
    memberId: (out.body as { memberId: string }).memberId,
    actorUserId: session.user.id ?? null,
    action: "EVENT_REGISTRATION_LINKED_TO_MEMBER",
    before: { registrationId: regId, memberId: null },
    after: { registrationId: regId, memberId: (out.body as { memberId: string }).memberId, booking: (out.body as { booking: string }).booking },
    note: `${g.reg.name} linked to ${(out.body as { memberName: string }).memberName} by staff.`,
  });

  return NextResponse.json(out.body);
}
