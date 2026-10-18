import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { describeProcessingFee } from "@/lib/fees";
import { describePlatformFee, getPlatformRate, getTierName, normalizeTier, TIER_FEATURES } from "@/lib/tier";

const SELECT = {
  passProcessingFees: true,
  passPlatformFee: true,
  processingFeeNote: true,
  offlineActivationPolicy: true,
  feeChoiceMadeAt: true,
  tier: true,
} as const;

function view(club: {
  passProcessingFees: boolean;
  passPlatformFee: boolean;
  processingFeeNote: string | null;
  offlineActivationPolicy: string | null;
  feeChoiceMadeAt: Date | null;
  tier: string;
}) {
  const tier = normalizeTier(club.tier);
  return {
    passProcessingFees: club.passProcessingFees,
    passPlatformFee: club.passPlatformFee,
    processingFeeNote: club.processingFeeNote,
    // Null column = the safe default: activate only when staff records payment.
    offlineActivationPolicy: club.offlineActivationPolicy === "ON_ACCEPTANCE" ? "ON_ACCEPTANCE" : "ON_PAYMENT",
    feeChoiceMadeAt: club.feeChoiceMadeAt,
    feeChoiceRequired: club.feeChoiceMadeAt == null,
    feeDescription: describeProcessingFee(),
    tier,
    tierName: getTierName(tier),
    platformFeeDescription: describePlatformFee(tier),
    platformRate: getPlatformRate(tier),
    platformFixedCents: TIER_FEATURES[tier].platformFixedCents,
  };
}

// GET /api/club/payment-settings — the club's fee split + plan rate.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const club = await prisma.club.findUnique({ where: { id: session.user.clubId }, select: SELECT });
  if (!club) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(view(club));
}

const schema = z.object({
  // Each optional so a card can PATCH its own field alone.
  passProcessingFees: z.boolean().optional(),
  passPlatformFee: z.boolean().optional(),
  processingFeeNote: z.string().max(300).optional().nullable(),
  // "Keep these settings" on the one-time fee-change banner: records the
  // choice without changing either toggle.
  confirmFeeChoice: z.literal(true).optional(),
  // CASH/CHECK activation rule: ON_PAYMENT (default, safer) = the membership
  // activates only when staff records the money as physically received;
  // ON_ACCEPTANCE = it activates when the client accepts (payment still due).
  offlineActivationPolicy: z.enum(["ON_PAYMENT", "ON_ACCEPTANCE"]).optional(),
});

// PATCH /api/club/payment-settings — who absorbs which fee. Not tier-gated:
// every plan chooses its own split. Saving either fee toggle (or confirming)
// stamps feeChoiceMadeAt, which ends the one-time owner redirect.
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }
  const choosing = data.passProcessingFees !== undefined || data.passPlatformFee !== undefined || data.confirmFeeChoice === true;
  const club = await prisma.club.update({
    where: { id: session.user.clubId },
    data: {
      ...(data.passProcessingFees !== undefined ? { passProcessingFees: data.passProcessingFees } : {}),
      ...(data.passPlatformFee !== undefined ? { passPlatformFee: data.passPlatformFee } : {}),
      ...(data.processingFeeNote !== undefined ? { processingFeeNote: data.processingFeeNote?.trim() || null } : {}),
      ...(data.offlineActivationPolicy !== undefined ? { offlineActivationPolicy: data.offlineActivationPolicy } : {}),
      ...(choosing ? { feeChoiceMadeAt: new Date() } : {}),
    },
    select: SELECT,
  });
  return NextResponse.json({ ok: true, ...view(club) });
}
