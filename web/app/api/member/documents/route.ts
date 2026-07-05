import { NextResponse } from "next/server";
import { guardianActionBlocked, CONSENT_BLOCK_BODY } from "@/lib/parentalConsent";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { findOrAutoLinkMember } from "@/lib/memberLink";

// GET /api/member/documents?memberId=<id>
// Returns club documents visible to the current viewer, with signature status
// for the requested member. If memberId is omitted, defaults to the viewer's
// own member profile. Parents may request signatures for any linked child.
export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const requestedMemberId = url.searchParams.get("memberId");

  const viewer = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      email: true,
      memberProfile: { select: { id: true, isMinor: true, firstName: true, lastName: true } },
      guardianOf: {
        select: {
          member: { select: { id: true, firstName: true, lastName: true, isMinor: true } },
        },
      },
    },
  });
  if (!viewer) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Auto-link by email if no userId-linked member profile found
  let linkedMemberProfile = viewer.memberProfile;
  if (!linkedMemberProfile) {
    const autoLinked = await findOrAutoLinkMember(
      session.user.id,
      session.user.clubId,
      viewer.email,
    );
    if (autoLinked) {
      linkedMemberProfile = {
        id: autoLinked.id,
        isMinor: autoLinked.isMinor,
        firstName: autoLinked.firstName,
        lastName: autoLinked.lastName,
      };
    }
  }

  // Build the set of memberIds the viewer can act on
  const accessibleMemberIds = new Set<string>();
  if (linkedMemberProfile?.id) accessibleMemberIds.add(linkedMemberProfile.id);
  for (const g of viewer.guardianOf) accessibleMemberIds.add(g.member.id);

  // Resolve the context member (the one we're showing signatures for)
  let contextMemberId: string | null = null;
  if (requestedMemberId) {
    if (!accessibleMemberIds.has(requestedMemberId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    contextMemberId = requestedMemberId;
  } else if (linkedMemberProfile?.id) {
    contextMemberId = linkedMemberProfile.id;
  } else if (viewer.guardianOf[0]) {
    contextMemberId = viewer.guardianOf[0].member.id;
  }

  // COPPA: don't surface a minor's documents to a guardian until consent is on file.
  if (contextMemberId && (await guardianActionBlocked(session.user.id, contextMemberId))) {
    return NextResponse.json(CONSENT_BLOCK_BODY, { status: 403 });
  }

  const now = new Date();
  const docs = await prisma.document.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      AND: [
        { OR: [{ publishAt: null }, { publishAt: { lte: now } }] },
        { OR: [{ unpublishAt: null }, { unpublishAt: { gt: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      ],
    },
    orderBy: [{ required: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      title: true,
      type: true,
      body: true,
      required: true,
      requiresGuardianSignature: true,
      deliveryTrigger: true,
      expiresAt: true,
      signatureValidForDays: true,
      createdAt: true,
    },
  });

  // Load signatures for the context member
  const signatures = contextMemberId
    ? await prisma.documentSignature.findMany({
        where: { memberId: contextMemberId, documentId: { in: docs.map((d) => d.id) } },
        select: {
          documentId: true,
          signerName: true,
          relationship: true,
          signedAt: true,
        },
      })
    : [];
  const sigByDoc = new Map(signatures.map((s) => [s.documentId, s]));

  const enriched = docs.map((d) => {
    const sig = sigByDoc.get(d.id);
    let signature = null;
    let signatureExpired = false;
    let signatureExpiresAt: string | null = null;
    if (sig) {
      if (d.signatureValidForDays) {
        const expiresAt = new Date(sig.signedAt);
        expiresAt.setDate(expiresAt.getDate() + d.signatureValidForDays);
        signatureExpiresAt = expiresAt.toISOString();
        signatureExpired = expiresAt < now;
      }
      signature = {
        signerName: sig.signerName,
        relationship: sig.relationship,
        signedAt: sig.signedAt,
        expiresAt: signatureExpiresAt,
        expired: signatureExpired,
      };
    }
    return { ...d, signature };
  });

  const contextMember =
    contextMemberId === linkedMemberProfile?.id
      ? linkedMemberProfile
      : viewer.guardianOf.find((g) => g.member.id === contextMemberId)?.member ?? null;

  return NextResponse.json({
    documents: enriched,
    contextMemberId,
    contextMember,
    accessibleMembers: [
      ...(linkedMemberProfile
        ? [{ id: linkedMemberProfile.id, firstName: linkedMemberProfile.firstName, lastName: linkedMemberProfile.lastName, isMinor: linkedMemberProfile.isMinor, kind: "self" as const }]
        : []),
      ...viewer.guardianOf.map((g) => ({
        id: g.member.id,
        firstName: g.member.firstName,
        lastName: g.member.lastName,
        isMinor: g.member.isMinor,
        kind: "child" as const,
      })),
    ],
  });
}
