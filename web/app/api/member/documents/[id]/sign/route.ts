import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY, resolveIsMinor } from "@/lib/parentalConsent";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";
import { isValidSignatureDataUrl } from "@/lib/signature";
import { ACTIVE_GUARDIAN_LINK } from "@/lib/familyAccess";

const schema = z.object({
  memberId: z.string().optional(),
  // Drawn signature image (PNG data URL). Optional for back-compat with the
  // typed-acknowledgement flow.
  signatureDataUrl: z.string().optional(),
});

// POST /api/member/documents/[id]/sign
// Body: { memberId?: string }
// Records an acknowledgement. If memberId omitted, defaults to the signer's own
// member profile. Parents may sign on behalf of linked children (validated
// against MemberGuardianUser). If the document requires a guardian signature
// and the target member is a minor, the signer must be a guardian — not the
// minor themselves.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const document = await prisma.document.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!document) return NextResponse.json({ error: "Document not found" }, { status: 404 });

  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      email: true,
      firstName: true,
      lastName: true,
      // dateOfBirth is selected because `resolveIsMinor` lets it OUTRANK the
      // stored `isMinor` flag — see the guardian-signature rule below.
      memberProfile: { select: { id: true, isMinor: true, dateOfBirth: true } },
      guardianOf: {
        where: ACTIVE_GUARDIAN_LINK,
        select: { member: { select: { id: true, isMinor: true, dateOfBirth: true } } },
      },
    },
  });
  if (!viewer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Resolve own member profile — auto-link by email if not yet linked
  let ownMemberId = viewer.memberProfile?.id ?? null;
  let ownMemberIsMinor = viewer.memberProfile ? resolveIsMinor(viewer.memberProfile) : false;
  if (!ownMemberId) {
    const autoLinked = await findOrAutoLinkMember(
      session.user.id,
      session.user.clubId,
      viewer.email,
    );
    if (autoLinked) {
      ownMemberId = autoLinked.id;
      ownMemberIsMinor = resolveIsMinor(autoLinked);
    }
  }

  // Resolve target member
  const targetMemberId = body.memberId ?? ownMemberId;
  if (!targetMemberId) {
    return NextResponse.json({ error: "No member context for signing" }, { status: 400 });
  }

  const isSelf = ownMemberId === targetMemberId;
  const linkedChild = viewer.guardianOf.find((g) => g.member.id === targetMemberId);
  if (!isSelf && !linkedChild) {
    return NextResponse.json({ error: "You don't have access to sign for this member" }, { status: 403 });
  }

  // COPPA: a guardian can't sign for a minor until consent is on file.
  if (!isSelf && (await guardianActionBlocked(session.user.id, targetMemberId))) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  // DOB decides, not the stored flag. This gate used to read `Member.isMinor`
  // directly, and that is exactly how a FOUR-YEAR-OLD came to be recorded as
  // having personally signed his own liability waiver: his row said
  // `isMinor: false` because signup stored whichever option was clicked, so
  // `targetIsMinor` was false and the guard below never fired. `resolveIsMinor`
  // exists precisely so a birthday outranks that flag — the login gate has
  // always used it; the document layer never did.
  const targetIsMinor = isSelf
    ? ownMemberIsMinor
    : linkedChild
      ? resolveIsMinor(linkedChild.member)
      : false;

  // Guardian-signature rule: if the document requires guardian sig and the
  // target is a minor, the signer must be a guardian (not the minor signing
  // their own record).
  if (document.requiresGuardianSignature && targetIsMinor && isSelf) {
    return NextResponse.json(
      { error: "This document requires a parent or guardian signature" },
      { status: 403 }
    );
  }

  const relationship = isSelf ? "SELF" : "GUARDIAN";
  const signerName = `${viewer.firstName} ${viewer.lastName}`.trim();

  const ipHeader = req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip");
  const ipAddress = ipHeader ? ipHeader.split(",")[0].trim() : null;
  const userAgent = req.headers.get("user-agent");

  // Drawn signature is optional but, when present, must be a valid PNG data URL.
  const signatureDataUrl = isValidSignatureDataUrl(body.signatureDataUrl) ? body.signatureDataUrl : null;
  if (body.signatureDataUrl && !signatureDataUrl) {
    return NextResponse.json(
      { error: "That signature image looks invalid — please re-draw and try again." },
      { status: 400 },
    );
  }

  // `signatureDataUrl` is cast in (the cached Prisma client predates the column;
  // the build regenerates the client, where the field is first-class).
  const base = {
    signerUserId: session.user.id,
    signerName,
    relationship,
    ipAddress,
    userAgent,
    signatureDataUrl,
  };
  const signature = await prisma.documentSignature.upsert({
    where: { documentId_memberId: { documentId: document.id, memberId: targetMemberId } },
    update: { ...base, signedAt: new Date() } as Prisma.DocumentSignatureUncheckedUpdateInput,
    create: { documentId: document.id, memberId: targetMemberId, ...base } as Prisma.DocumentSignatureUncheckedCreateInput,
  });

  return NextResponse.json({ ok: true, signature });
}
