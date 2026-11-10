import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { fieldCryptoConfigured } from "@/lib/fieldCrypto";
import { maskFor, w9History } from "@/lib/contractorTin";
import { CLASSIFICATION_NOTE, contractorForStaff, workerTypeDescription, workerTypeLabel } from "@/lib/workerType";
import { TAX_CLASSIFICATIONS, W9_CERTIFICATION_TEXT, W9_ESIGN_NOTICE } from "@/lib/tin";

export const dynamic = "force-dynamic";

// GET /api/me/worker — MY OWN worker type and W-9.
//
// Every signed-in dashboard user can read this, and it only ever describes the
// caller: there is no id parameter, so there is nothing to tamper with and no
// way to ask about a colleague. "Staff see only their own" is structural here
// rather than a check that could be forgotten.
//
// Never returns a tax ID — only the mask, built from the stored plaintext last
// four, so loading this page is not a decryption.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const clubId = session.user.clubId;
  const userId = session.user.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const profile = await prisma.staffProfile.findFirst({
    where: { userId, user: { clubId } },
    select: { workerType: true, title: true },
  });
  const contractor = await contractorForStaff(clubId, userId);

  return NextResponse.json({
    workerType: profile?.workerType ?? null,
    workerTypeLabel: workerTypeLabel(profile?.workerType),
    workerTypeDescription: workerTypeDescription(profile?.workerType),
    classificationNote: CLASSIFICATION_NOTE,
    title: profile?.title ?? null,
    contractor: contractor
      ? {
          id: contractor.id,
          name: contractor.name,
          w9Status: contractor.w9Status,
          hasW9: !!contractor.w9CurrentSubmissionId,
          maskedTin: maskFor(contractor.taxIdLast4, contractor.taxIdKind),
          w9Url: contractor.w9Url,
          w9RequestedAt: contractor.w9RequestedAt?.toISOString() ?? null,
          streetAddress: contractor.streetAddress,
          city: contractor.city,
          state: contractor.state,
          zipCode: contractor.zipCode,
        }
      : null,
    history: contractor ? await w9History(clubId, contractor.id) : [],
    form: {
      classifications: TAX_CLASSIFICATIONS,
      certificationText: W9_CERTIFICATION_TEXT,
      esignNotice: W9_ESIGN_NOTICE,
      // False when this installation has no encryption key: the form says so
      // rather than collecting a tax ID it cannot store safely.
      canCollectTaxId: fieldCryptoConfigured(),
    },
    signerName: `${session.user.name ?? ""}`.trim() || null,
  });
}
