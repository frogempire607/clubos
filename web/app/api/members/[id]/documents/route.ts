import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { documentSignatureStatus, isDocumentRequiredAt } from "@/lib/documents";

// GET /api/members/[id]/documents
//
// Every club document, with THIS member's signature status against each.
//
// ── Why this route exists (session 4) ───────────────────────────────────────
// The profile's Documents tab rendered nothing. Two separate gaps: the page had
// no card gated to that tab, and no endpoint could answer the question anyway.
// `/api/documents/[id]/signatures` is per-DOCUMENT (who signed this waiver?) and
// `/api/member/documents` resolves the viewer's OWN member context from their
// session — a staffer opening someone else's profile is neither.
//
// Julian: "I need to see signed waivers and ones still waiting." That is one
// list with three states, not two lists — MISSING and EXPIRED are different
// problems (never signed vs. lapsed and needs re-signing) and collapsing them
// hides which one you are looking at.
//
// READ-ONLY. Staff never sign on a member's behalf: signatures carry a signer
// identity, an IP and a user agent, and a staff-created one would be a forged
// audit record. The action offered here is "request", not "sign for them".
export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Gated on `documents`, not `members`: waiver contents and who signed what is
  // its own permission in lib/permissions.ts, and a coach with members:view is
  // not automatically entitled to it.
  const guard = requirePermission(session, "documents", "view");
  if (guard) return guard;

  const member = await prisma.member.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, isMinor: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const now = new Date();
  // Same publish/unpublish/expiry window the member portal applies, so staff
  // are not chasing a signature for a document the member cannot see.
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
    orderBy: [{ required: "desc" }, { title: "asc" }],
    select: {
      id: true,
      title: true,
      type: true,
      required: true,
      requiredAt: true,
      requiresGuardianSignature: true,
      signatureValidForDays: true,
    },
  });

  const signatures = await prisma.documentSignature.findMany({
    where: { memberId: member.id, documentId: { in: docs.map((d) => d.id) } },
    select: {
      documentId: true,
      signerName: true,
      relationship: true,
      signedAt: true,
      // Whether a drawn image exists — never the image itself. It is a ~220KB
      // data URL per row and the list does not render it.
      signatureDataUrl: false,
    },
  });
  const sigByDoc = new Map(signatures.map((s) => [s.documentId, s]));

  const documents = docs.map((d) => {
    const sig = sigByDoc.get(d.id);
    const { status, expiresAt } = documentSignatureStatus(d, sig, now);
    return {
      id: d.id,
      title: d.title,
      type: d.type,
      // "Required" is surface-specific — a SIGNUP-only document is not
      // outstanding for someone who was imported (lib/documents.ts). Reading
      // `required` alone would mark people as missing paperwork they were never
      // asked for, which is exactly the noise that gets a screen ignored.
      requiredForOnboarding: isDocumentRequiredAt(d, "ONBOARDING"),
      requiresGuardianSignature: d.requiresGuardianSignature,
      signatureValidForDays: d.signatureValidForDays,
      status,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      signature: sig
        ? {
            signerName: sig.signerName,
            relationship: sig.relationship,
            signedAt: sig.signedAt.toISOString(),
          }
        : null,
    };
  });

  const outstanding = documents.filter(
    (d) => d.requiredForOnboarding && (d.status === "MISSING" || d.status === "EXPIRED"),
  ).length;

  return NextResponse.json({
    member: { id: member.id, name: `${member.firstName} ${member.lastName}`.trim(), isMinor: member.isMinor },
    documents,
    summary: {
      total: documents.length,
      signed: documents.filter((d) => d.status === "SIGNED").length,
      expired: documents.filter((d) => d.status === "EXPIRED").length,
      missing: documents.filter((d) => d.status === "MISSING").length,
      /** Required-at-onboarding documents that are not currently covered. */
      outstanding,
    },
  });
}
