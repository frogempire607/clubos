import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { TERMS_VERSION, PRIVACY_VERSION, PARENTAL_CONSENT_VERSION } from "@/legal/versions";
import {
  resolveGuardianConsentToken,
  recordParentalConsent,
  buildParentalConsentText,
  type ConsentSource,
} from "@/lib/parentalConsent";

// Public, token-gated COPPA consent completion. A parent/guardian arrives here
// from the emailed consent link, reviews the statement + Terms/Privacy, and
// records their explicit, immutable consent. No login required — the token is
// the authorization.

function childName(m: { firstName: string; lastName: string }): string {
  return `${m.firstName} ${m.lastName}`.trim();
}

export async function GET(_req: Request, { params }: { params: { token: string } }) {
  const { status, request } = await resolveGuardianConsentToken(params.token);
  if (!request) {
    return NextResponse.json({ status, error: "This consent link is not valid." }, { status: 404 });
  }
  const child = request.member!;
  const club = request.club!;
  const name = childName(child);
  return NextResponse.json({
    status, // valid | expired | used | invalid
    child: { firstName: child.firstName, lastName: child.lastName },
    guardianName: request.guardianName,
    guardianEmail: request.guardianEmail,
    club: { name: club.name, slug: club.slug },
    termsVersion: TERMS_VERSION,
    privacyVersion: PRIVACY_VERSION,
    consentVersion: PARENTAL_CONSENT_VERSION,
    consentText: buildParentalConsentText({ childName: name, clubName: club.name }),
  });
}

const bodySchema = z.object({
  // Must be exactly true — rejects undefined/false/"true".
  accepted: z.literal(true),
  guardianName: z.string().optional(),
  relationship: z.string().optional(),
});

export async function POST(req: Request, { params }: { params: { token: string } }) {
  const rl = rateLimit({ key: `guardian-consent:${ipFromRequest(req)}`, limit: 20, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a few minutes.");

  try {
    const body = bodySchema.parse(await req.json());
    const { status, request } = await resolveGuardianConsentToken(params.token);
    if (!request) return NextResponse.json({ error: "This consent link is not valid." }, { status: 404 });
    if (status === "used") return NextResponse.json({ error: "This consent has already been completed." }, { status: 409 });
    if (status === "expired") return NextResponse.json({ error: "This consent link has expired. Ask the club to resend it." }, { status: 410 });
    if (status !== "valid") return NextResponse.json({ error: "This consent link is not valid." }, { status: 400 });

    const child = request.member!;
    const club = request.club!;
    const name = childName(child);

    // Link an existing guardian account when one already exists for this email
    // in the club, so consent is attributed to a real account when possible.
    const guardianUser = await prisma.user.findUnique({
      where: { clubId_email: { clubId: club.id, email: request.guardianEmail.toLowerCase() } },
      select: { id: true, firstName: true, lastName: true, deletedAt: true },
    });
    const liveGuardian = guardianUser && !guardianUser.deletedAt ? guardianUser : null;
    const guardianName =
      body.guardianName?.trim() ||
      request.guardianName?.trim() ||
      (liveGuardian ? `${liveGuardian.firstName} ${liveGuardian.lastName}`.trim() : request.guardianEmail);
    const relationship = body.relationship?.trim() || request.relationship || null;
    const source: ConsentSource =
      request.source === "OWNER_INVITE" ? "OWNER_INVITE" : request.source === "PARENT_INVITE" ? "PARENT_INVITE" : "SIGNUP";

    await prisma.$transaction(async (tx) => {
      await recordParentalConsent(tx, {
        clubId: club.id,
        memberId: child.id,
        childUserId: child.userId ?? null,
        guardianUserId: liveGuardian?.id ?? null,
        guardianName,
        guardianEmail: request.guardianEmail,
        relationship,
        clubName: club.name,
        childName: name,
        ipAddress: ipFromRequest(req),
        userAgent: req.headers.get("user-agent"),
        source,
      });
      // Consume the token (mutable operational record).
      await tx.guardianConsentRequest.update({ where: { id: request.id }, data: { consumedAt: new Date() } });
      // If the guardian has a portal account, ensure the guardian link so they
      // can manage the child now that consent is on record.
      if (liveGuardian) {
        await tx.memberGuardianUser.upsert({
          where: { userId_memberId: { userId: liveGuardian.id, memberId: child.id } },
          update: {},
          create: { userId: liveGuardian.id, memberId: child.id, relationship: relationship || "GUARDIAN" },
        });
      }
    });

    return NextResponse.json({ ok: true, clubSlug: club.slug });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error("guardian-consent POST failed:", err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
