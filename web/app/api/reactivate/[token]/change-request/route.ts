import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { writeBillingAudit } from "@/lib/billingAudit";

export const dynamic = "force-dynamic";

// POST /api/reactivate/[token]/change-request — the client asks the club to
// adjust the offer instead of confirming it.
//
// Safety properties:
//   • NEVER mutates billing data, the offer snapshot, or Stripe — it records a
//     request and LOCKS this offer's confirmation until the owner resolves it.
//   • The client cannot submit a price — there is deliberately no price field.
//   • One open request at a time per offer.
const schema = z.object({
  // Everything optional — the note alone is a valid request.
  requestedMembership: z.string().max(120).optional().nullable(),
  requestedOption: z.string().max(120).optional().nullable(),
  requestedBillingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional()
    .nullable(),
  requestedFrequency: z.enum(["WEEKLY", "MONTHLY", "QUARTERLY", "SEMI_ANNUAL", "ANNUAL"]).optional().nullable(),
  requestedPayer: z.string().max(160).optional().nullable(),
  requestedPaymentMethod: z.enum(["CARD", "NEW_CARD", "CASH", "CHECK"]).optional().nullable(),
  note: z.string().max(1000).optional().nullable(),
});

export async function POST(req: Request, context: { params: Promise<{ token: string }> }) {
  const { token } = await context.params;
  if (!token || token.length < 20) return NextResponse.json({ error: "Invalid link" }, { status: 400 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }
  const fields = {
    membership: body.requestedMembership?.trim() || null,
    purchaseOption: body.requestedOption?.trim() || null,
    billingDate: body.requestedBillingDate || null,
    frequency: body.requestedFrequency || null,
    payer: body.requestedPayer?.trim() || null,
    paymentMethod: body.requestedPaymentMethod || null,
  };
  const note = body.note?.trim() || null;
  if (!note && Object.values(fields).every((v) => !v)) {
    return NextResponse.json({ error: "Describe what you'd like changed." }, { status: 400 });
  }

  const r = await prisma.membershipReactivation.findUnique({
    where: { token },
    select: {
      id: true,
      clubId: true,
      memberId: true,
      status: true,
      tokenExpires: true,
      offerVersion: true,
      changeRequestStatus: true,
    },
  });
  if (!r) return NextResponse.json({ error: "This link isn't valid." }, { status: 404 });
  if (r.status !== "DRAFT" && r.status !== "SENT") {
    return NextResponse.json({ error: "This offer is no longer open. Ask the club for a fresh link." }, { status: 410 });
  }
  if (r.tokenExpires < new Date()) {
    return NextResponse.json({ error: "This link has expired. Ask the club to resend it." }, { status: 410 });
  }
  if (r.changeRequestStatus === "OPEN") {
    return NextResponse.json(
      { error: "A change request is already with the club — they'll follow up shortly.", code: "ALREADY_REQUESTED" },
      { status: 409 },
    );
  }

  // Who asked (best-effort — the token itself authorizes the request).
  const session = await getServerSession(authOptions).catch(() => null);
  const request = {
    fields,
    note,
    requestedAt: new Date().toISOString(),
    byUserId: session?.user?.id ?? null,
    byEmail: session?.user?.email ?? null,
  };

  await prisma.membershipReactivation.update({
    where: { id: r.id },
    data: {
      changeRequest: request as unknown as Prisma.InputJsonValue,
      changeRequestStatus: "OPEN",
      changeRequestAt: new Date(),
      changeRequestResolvedAt: null,
      changeRequestResolvedById: null,
    },
  });
  await writeBillingAudit({
    clubId: r.clubId,
    memberId: r.memberId,
    actorUserId: session?.user?.id ?? null,
    action: "REACTIVATION_CHANGE_REQUESTED",
    before: { reactivationId: r.id, offerVersion: r.offerVersion },
    after: { reactivationId: r.id, request },
    note: "Client requested changes to the reactivation offer — confirmation locked until the owner resolves it. No billing data changed.",
  });

  return NextResponse.json({
    ok: true,
    message: "Your request was sent to the club. This offer can't be confirmed until they respond.",
  });
}
