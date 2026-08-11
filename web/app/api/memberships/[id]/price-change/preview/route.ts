import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";
import {
  parseMembershipOptions,
  planPriceChange,
  REPRICEABLE_STATUSES,
} from "@/lib/bulkPriceChange";

// POST /api/memberships/[id]/price-change/preview
//
// READ-ONLY. This route performs zero writes: no DB mutation, no Stripe call,
// no email, no audit row. It answers one question — "if this option's price
// moved to X, who is affected and what would change for each of them" — and
// the answer is the screen the owner reads before anything is applied.
//
// It is a POST because the input is a body (option + proposed price), not
// because it changes state. Nothing in this file may ever be given a write.
//
// ── Owner-only, deliberately ────────────────────────────────────────────────
//
// Not billing:full. billing:full is the "set up and collect money from ONE
// member" key — it gates a member's payment methods, their offer, recording
// their cash. Repricing every membership in the club is a different act: it
// rewrites the club's price list against its whole book of business. Staff who
// legitimately need billing:full to run the front desk should not be able to
// do it, so this is requireOwner. Preview is gated the same as apply will be,
// because the preview itself discloses every member's individual negotiated
// price — which is exactly the data an override is meant to keep quiet.

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  // The option being repriced, identified as the edit screen knows it.
  optionLabel: z.string().min(1),
  // Disambiguates when a plan has two options sharing a label (the label is
  // free text and not unique). Optional — falls back to first label match.
  billingPeriod: z.string().min(1).optional(),
  newPrice: z.number().min(0).max(1_000_000),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  // Explicit null check before the guard — requireOwner does not narrow
  // `session` for TypeScript, and the later session.user reads need it.
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    }
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const membership = await prisma.membership.findFirst({
    where: { id: params.id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, name: true, options: true },
  });
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const options = parseMembershipOptions(membership.options);
  const option = options.find(
    (o) =>
      o.label === body.optionLabel &&
      (body.billingPeriod ? o.billingPeriod === body.billingPeriod : true),
  );
  if (!option) {
    return NextResponse.json(
      {
        error: `This plan has no option "${body.optionLabel}"${body.billingPeriod ? ` billed ${body.billingPeriod}` : ""}.`,
        availableOptions: options.map((o) => ({ label: o.label, billingPeriod: o.billingPeriod, price: o.price })),
      },
      { status: 400 },
    );
  }

  // Match on plan + billing period, NOT on optionLabel. See the module note in
  // lib/bulkPriceChange.ts — optionLabel carries the plan name on every row
  // written by the migration/approve path, so selecting on it would silently
  // skip real subscribers.
  const subs = await prisma.memberSubscription.findMany({
    where: {
      membershipId: membership.id,
      billingPeriod: option.billingPeriod,
      status: { in: [...REPRICEABLE_STATUSES] },
      member: { clubId: session.user.clubId, deletedAt: null },
    },
    select: {
      id: true,
      memberId: true,
      optionLabel: true,
      price: true,
      billingPeriod: true,
      billingType: true,
      status: true,
      stripeSubscriptionId: true,
      stripePriceId: true,
      stripeStatus: true,
      currentPeriodEnd: true,
      endDate: true,
      billingAnchorDate: true,
      startDate: true,
      effectiveStartDate: true,
      autoRenew: true,
      discountCode: true,
      discountAmount: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  const plan = planPriceChange({
    membership: { id: membership.id, name: membership.name },
    option,
    newPrice: body.newPrice,
    subs,
    now: new Date(),
  });

  return NextResponse.json({ preview: true, ...plan });
}
