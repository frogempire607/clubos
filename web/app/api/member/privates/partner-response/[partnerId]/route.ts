import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// POST /api/member/privates/partner-response/[partnerId]
// The invited MEMBER partner (or one of their linked guardians) confirms or
// declines an invitation to join a partner private lesson.
const schema = z.object({ action: z.enum(["confirm", "decline"]) });

export async function POST(req: Request, context: { params: Promise<{ partnerId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clubId = session.user.clubId;

  const partner = await prisma.privateBookingPartner.findFirst({
    where: { id: params.partnerId, clubId, kind: "MEMBER" },
    include: {
      member: { include: { guardianLinks: { select: { userId: true } } } },
    },
  });
  if (!partner || !partner.member) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Verify the caller is the partner member (or one of their guardians).
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const caller = user ? await findOrAutoLinkMember(session.user.id, clubId, user.email) : null;
  const isThePartner = caller?.id === partner.memberId;
  const isGuardian = partner.member.guardianLinks.some((g) => g.userId === session.user.id);
  if (!isThePartner && !isGuardian) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (partner.status === "PENDING_COACH") {
    return NextResponse.json(
      { error: "This invitation isn't open yet — waiting on coach approval." },
      { status: 409 },
    );
  }
  if (partner.status === "CONFIRMED" || partner.status === "DECLINED") {
    return NextResponse.json({ error: "Already responded." }, { status: 409 });
  }

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  await prisma.privateBookingPartner.update({
    where: { id: partner.id },
    data: data.action === "confirm"
      ? { status: "CONFIRMED", confirmedAt: new Date(), respondedAt: new Date() }
      : { status: "DECLINED", respondedAt: new Date() },
  });

  return NextResponse.json({ ok: true, status: data.action === "confirm" ? "CONFIRMED" : "DECLINED" });
}

// GET — list pending member-partner invitations addressed to the caller. Used
// to surface "You've been invited to a partner lesson" notifications in the
// member portal.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const clubId = session.user.clubId;
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  const caller = user ? await findOrAutoLinkMember(session.user.id, clubId, user.email) : null;
  if (!caller) return NextResponse.json([]);

  // Also include partners pointing at any member I'm a guardian for.
  const guardianFor = await prisma.memberGuardianUser.findMany({
    where: { userId: session.user.id },
    select: { memberId: true },
  });
  const memberIds = [caller.id, ...guardianFor.map((g) => g.memberId)];

  const invites = await prisma.privateBookingPartner.findMany({
    where: { clubId, kind: "MEMBER", status: "INVITED", memberId: { in: memberIds } },
    include: {
      booking: {
        select: {
          id: true,
          status: true,
          confirmedStartAt: true,
          confirmedEndAt: true,
          member: { select: { firstName: true, lastName: true } },
          lessonType: { select: { title: true } },
        },
      },
      member: { select: { firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(invites);
}
