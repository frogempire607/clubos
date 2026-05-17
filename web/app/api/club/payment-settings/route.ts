import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { describeProcessingFee } from "@/lib/fees";

// GET /api/club/payment-settings — current processing-fee pass-through config.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { passProcessingFees: true, processingFeeNote: true },
  });
  if (!club) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ...club, feeDescription: describeProcessingFee() });
}

const schema = z.object({
  passProcessingFees: z.boolean(),
  processingFeeNote: z.string().max(300).optional().nullable(),
});

// PATCH /api/club/payment-settings — toggle passing Stripe processing fees to
// the customer at checkout. Not tier-gated; available on every plan.
export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }
  const club = await prisma.club.update({
    where: { id: session.user.clubId },
    data: {
      passProcessingFees: data.passProcessingFees,
      processingFeeNote: data.processingFeeNote?.trim() || null,
    },
    select: { passProcessingFees: true, processingFeeNote: true },
  });
  return NextResponse.json({ ok: true, ...club });
}
