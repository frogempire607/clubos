import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { prisma } from "@/lib/prisma";
import { requireOwnerLive } from "@/lib/apiGuard";
import { ipFromRequest, rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { fieldCryptoConfigured } from "@/lib/fieldCrypto";
import { TinError, maskFor, requestNewW9, submitW9, w9History } from "@/lib/contractorTin";
import { W9_CERTIFICATION_TEXT, W9_ESIGN_NOTICE, TAX_CLASSIFICATIONS } from "@/lib/tin";

export const dynamic = "force-dynamic";

/// Who may look at this contractor's W-9: the club's owner, or the staff
/// member the contractor record belongs to. Nobody else — not a coach with
/// staff-management permission, because a colleague's tax details are not
/// staff administration.
async function access(clubId: string, contractorId: string, userId: string | null, isOwner: boolean) {
  const contractor = await prisma.contractor.findFirst({
    where: { id: contractorId, clubId, deletedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      convertedUserId: true,
      w9Status: true,
      w9CurrentSubmissionId: true,
      taxIdLast4: true,
      taxIdKind: true,
      w9Url: true,
      w9RequestedAt: true,
      streetAddress: true,
      city: true,
      state: true,
      zipCode: true,
    },
  });
  if (!contractor) return { contractor: null, isSelf: false, allowed: false as const };
  const isSelf = !!userId && contractor.convertedUserId === userId;
  return { contractor, isSelf, allowed: isOwner || isSelf };
}

// GET /api/contractors/[id]/w9 — status, the MASKED tax id, and the history.
// The owner, or the staff member it belongs to.
//
// Never returns a tax id. The mask is built from the stored plaintext last
// four, so reading this page is not a decryption and needs no audit.
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clubId = session.user.clubId;
  const isOwner = session.user.role === "OWNER";

  const { contractor, isSelf, allowed } = await access(clubId, params.id, session.user.id ?? null, isOwner);
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!allowed) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const history = await w9History(clubId, contractor.id);
  return NextResponse.json({
    contractor: {
      id: contractor.id,
      name: contractor.name,
      email: contractor.email,
      w9Status: contractor.w9Status,
      maskedTin: maskFor(contractor.taxIdLast4, contractor.taxIdKind),
      hasW9: !!contractor.w9CurrentSubmissionId,
      w9Url: contractor.w9Url,
      w9RequestedAt: contractor.w9RequestedAt?.toISOString() ?? null,
      streetAddress: contractor.streetAddress,
      city: contractor.city,
      state: contractor.state,
      zipCode: contractor.zipCode,
      linkedToMe: isSelf,
    },
    // An owner sees the whole history; the staff member sees their own, which
    // is the same list — it is their form either way.
    history,
    // What the form needs to render, and whether it can be submitted at all.
    form: {
      classifications: TAX_CLASSIFICATIONS,
      certificationText: W9_CERTIFICATION_TEXT,
      esignNotice: W9_ESIGN_NOTICE,
      /// False when this installation has no encryption key. The form refuses
      /// to collect a tax id in that state rather than collecting one it
      /// cannot store safely.
      canCollectTaxId: fieldCryptoConfigured(),
    },
    viewer: { isOwner, isSelf },
  });
}

const submitSchema = z
  .object({
    legalName: z.string().trim().min(1).max(200),
    businessName: z.string().trim().max(200).nullable().optional(),
    taxClassification: z.string().trim().min(1).max(40),
    classificationNote: z.string().trim().max(200).nullable().optional(),
    streetAddress: z.string().trim().min(1).max(200),
    city: z.string().trim().min(1).max(100),
    state: z.string().trim().min(1).max(40),
    zipCode: z.string().trim().min(1).max(12),
    taxIdKind: z.enum(["SSN", "EIN"]),
    // Accepts what people type; normalised and validated in lib/tin.
    taxId: z.string().trim().min(1).max(20),
    signedName: z.string().trim().min(1).max(200),
    /// The contractor must tick the certification. A submission without it is
    /// not a signed W-9.
    certified: z.literal(true),
  })
  .strict();

// POST /api/contractors/[id]/w9 — the contractor completes and signs their own
// W-9.
//
// SELF ONLY, deliberately, even for an owner. Part II of a W-9 is a
// certification under penalties of perjury; an owner filling it in on somebody
// else's behalf would be forging that certification. An owner who holds a
// PAPER W-9 can still attach it as a staff document, which is what that path
// is for.
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clubId = session.user.clubId;
  const userId = session.user.id ?? null;

  // A tax id is the most sensitive thing this app accepts; a submission
  // endpoint taking one should not be callable in a loop.
  const rl = rateLimit({ key: `w9:submit:${userId ?? ipFromRequest(req)}`, limit: 10, windowMs: 10 * 60 * 1000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const { contractor, isSelf } = await access(clubId, params.id, userId, session.user.role === "OWNER");
  if (!contractor) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!isSelf) {
    return NextResponse.json(
      {
        error:
          "A W-9 has to be completed and signed by the person it is for — its certification is made under penalties of perjury. Ask them to fill it in from their own profile, or attach a signed paper copy to their staff documents instead.",
      },
      { status: 403 },
    );
  }

  const parsed = submitSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(formatZodError(parsed.error), { status: 400 });
  const { certified, ...draft } = parsed.data;
  void certified;

  try {
    const result = await submitW9(
      clubId,
      contractor.id,
      {
        legalName: draft.legalName,
        businessName: draft.businessName ?? null,
        taxClassification: draft.taxClassification,
        classificationNote: draft.classificationNote ?? null,
        streetAddress: draft.streetAddress,
        city: draft.city,
        state: draft.state,
        zipCode: draft.zipCode,
        taxIdKind: draft.taxIdKind,
        taxId: draft.taxId,
        signedName: draft.signedName,
      },
      {
        signedByUserId: userId,
        ipAddress: ipFromRequest(req),
        userAgent: req.headers.get("user-agent"),
      },
      { userId, name: session.user.name ?? null },
    );
    // Returns the mask, never the number that was just submitted.
    return NextResponse.json({
      ok: true,
      maskedTin: maskFor(result.last4, draft.taxIdKind),
      fileUrl: result.fileUrl,
    });
  } catch (err) {
    if (err instanceof TinError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}

// PATCH /api/contractors/[id]/w9 — an owner asks for a fresh W-9. Resets the
// status; the existing submission stays in force and is kept.
export async function PATCH(_req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const notOwner = await requireOwnerLive(session);
  if (notOwner) return notOwner;

  try {
    await requestNewW9(session.user.clubId, params.id, {
      userId: session.user.id ?? null,
      name: session.user.name ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof TinError) return NextResponse.json({ error: err.message }, { status: err.status });
    throw err;
  }
}
