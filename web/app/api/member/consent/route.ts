import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ipFromRequest } from "@/lib/ratelimit";
import { TERMS_VERSION, PRIVACY_VERSION, PARENTAL_CONSENT_VERSION } from "@/legal/versions";
import {
  listChildrenNeedingConsent,
  recordParentalConsent,
  buildParentalConsentText,
  resolveIsMinor,
  parentalConsentEnforced,
} from "@/lib/parentalConsent";

// Authenticated in-portal consent. GET returns the minor children this guardian
// still needs to consent for (empty when enforcement is off, so the client gate
// is inert until the flag is enabled). POST records an immutable consent for one
// child the caller is a verified guardian of.

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as any).id as string;
  const clubId = (session.user as any).clubId as string;

  if (!parentalConsentEnforced()) {
    return NextResponse.json({ enforced: false, pending: [] });
  }

  const children = await listChildrenNeedingConsent(userId);
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
  const clubName = club?.name ?? "the club";

  return NextResponse.json({
    enforced: true,
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    consentVersion: PARENTAL_CONSENT_VERSION,
    pending: children.map((c) => {
      const name = `${c.firstName} ${c.lastName}`.trim();
      return { memberId: c.memberId, childName: name, consentText: buildParentalConsentText({ childName: name, clubName }) };
    }),
  });
}

const bodySchema = z.object({
  memberId: z.string().min(1),
  accepted: z.literal(true),
  relationship: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = (session.user as any).id as string;
  const clubId = (session.user as any).clubId as string;

  try {
    const body = bodySchema.parse(await req.json());

    // The caller must be a recorded guardian of this member.
    const link = await prisma.memberGuardianUser.findUnique({
      where: { userId_memberId: { userId, memberId: body.memberId } },
      select: { id: true },
    });
    if (!link) return NextResponse.json({ error: "You are not authorized for this member." }, { status: 403 });

    const member = await prisma.member.findFirst({
      where: { id: body.memberId, clubId, deletedAt: null },
      select: { id: true, firstName: true, lastName: true, isMinor: true, dateOfBirth: true, userId: true },
    });
    if (!member) return NextResponse.json({ error: "Member not found." }, { status: 404 });
    if (!resolveIsMinor(member)) return NextResponse.json({ error: "This member is not a minor." }, { status: 400 });

    const self = await prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, email: true },
    });
    const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });

    await recordParentalConsent(prisma, {
      clubId,
      memberId: member.id,
      childUserId: member.userId ?? null,
      guardianUserId: userId,
      guardianName: self ? `${self.firstName} ${self.lastName}`.trim() : "Guardian",
      guardianEmail: self?.email ?? "",
      relationship: body.relationship || null,
      clubName: club?.name ?? null,
      childName: `${member.firstName} ${member.lastName}`.trim(),
      ipAddress: ipFromRequest(req),
      userAgent: req.headers.get("user-agent"),
      source: "PORTAL_GATE",
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error("member consent POST failed:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
