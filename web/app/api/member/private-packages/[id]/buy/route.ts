import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe, calculatePlatformFee } from "@/lib/stripe";
import { processingFeeLineItem } from "@/lib/fees";
import { getAppBaseUrl } from "@/lib/baseUrl";
import { resolveFamilyContext } from "@/lib/memberContext";
import { applyParentalControls } from "@/lib/parentalControls";
import {
  packageTotalForBasePrice,
  normalizePricingMode,
  optionAvailableToMember,
  normalizeOptionAudience,
} from "@/lib/privateLessonRules";

// POST /api/member/private-packages/[id]/buy
//
// Opens a Stripe Checkout session on the club's connected account for the
// chosen FLAT-mode published package. We deliberately do NOT pre-create
// a PrivateCreditLedger row here — credits get granted only after the
// webhook confirms payment, so the member can't see (or use) credits
// they haven't paid for if checkout abandons.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clubId = session.user.clubId;
  const body = (await req.json().catch(() => ({}))) as {
    memberId?: string;
    lessonTypeId?: string;
    priceOptionId?: string;
  };
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true },
  });
  // Family-aware: buy a package for the viewer's own profile or a child they
  // guardian.
  const resolved = user
    ? await resolveFamilyContext(session.user.id, clubId, user.email, body.memberId)
    : null;
  if (resolved === "FORBIDDEN") {
    return NextResponse.json({ error: "You can't manage that profile." }, { status: 403 });
  }
  const member = resolved?.context ?? null;
  if (!member) {
    return NextResponse.json(
      { error: "Your account isn't linked to a member profile yet. Contact your club." },
      { status: 400 },
    );
  }

  const pkg = await prisma.privatePackage.findFirst({
    where: {
      id: params.id,
      clubId,
      deletedAt: null,
      active: true,
      publishedToMembers: true,
    },
  });
  if (!pkg) {
    return NextResponse.json({ error: "Package not available" }, { status: 404 });
  }

  const club = await prisma.club.findUnique({ where: { id: clubId } });
  if (!club || !club.stripeAccountId || !club.stripeChargesEnabled) {
    return NextResponse.json(
      { error: "Your club hasn't enabled online payments yet." },
      { status: 400 },
    );
  }

  // Price the package. FLAT uses the stored flat total. PERCENT/FIXED are a
  // discount off the chosen lesson tier's per-lesson price, so we resolve that
  // tier from the lessonTypeId/priceOptionId the member picked in the request
  // flow (this is what fixed the "$0 / Package not available" bug for
  // discount-based packages).
  const mode = normalizePricingMode(pkg.pricingMode);
  let basePerLesson = 0;
  if (mode !== "FLAT") {
    if (!body.lessonTypeId) {
      return NextResponse.json(
        { error: "Pick a lesson type and option first so we can price this pack." },
        { status: 400 },
      );
    }
    const lt = await prisma.privateLessonType.findFirst({
      where: { id: body.lessonTypeId, clubId, deletedAt: null },
      select: { basePrice: true, priceOptions: true },
    });
    if (!lt) {
      return NextResponse.json({ error: "That lesson type isn't available." }, { status: 400 });
    }
    basePerLesson = Number(lt.basePrice) || 0;
    if (body.priceOptionId && Array.isArray(lt.priceOptions)) {
      const opt = (lt.priceOptions as Array<{ id?: string; price?: number; audience?: unknown }>).find(
        (o) => o?.id === body.priceOptionId,
      );
      if (opt && typeof opt.price === "number") {
        // Member vs non-member pricing: the tier the pack prices off must be
        // one this athlete is actually eligible for.
        const hasActiveMembership =
          (await prisma.memberSubscription.count({
            where: { memberId: member.id, status: "active" },
          })) > 0;
        if (!optionAvailableToMember(opt.audience, hasActiveMembership)) {
          const audience = normalizeOptionAudience(opt.audience);
          return NextResponse.json(
            {
              error:
                audience === "MEMBER"
                  ? "That rate is for active members. Pick the non-member option, or add a membership first."
                  : "That rate is for non-members. As an active member, pick the member option instead.",
            },
            { status: 400 },
          );
        }
        basePerLesson = opt.price;
      }
    }
  }
  const totalAmount = packageTotalForBasePrice(
    {
      pricingMode: pkg.pricingMode,
      discountValue: pkg.discountValue == null ? null : Number(pkg.discountValue),
      price: Number(pkg.price),
      credits: pkg.credits,
      bonusCredits: pkg.bonusCredits,
    },
    basePerLesson,
  );
  const totalCents = Math.round(totalAmount * 100);
  if (totalCents <= 0) {
    return NextResponse.json(
      { error: "This pack can't be priced for that lesson yet — pick a lesson and option, or contact your club." },
      { status: 400 },
    );
  }

  // P4 parental gate. Runs before any Stripe-side cost is paid; either
  // allows the checkout, blocks the buy outright (allowPackagePurchase=false),
  // or queues a PendingApproval for the guardian. The replay payload is
  // just the package id — POST this same endpoint again after approval
  // and the gate will return "allow" because the row already exists.
  const gate = await applyParentalControls({
    member: {
      id: member.id,
      clubId,
      userId: member.userId,
      isMinor: member.isMinor,
      parentControls: member.parentControls,
    },
    bookerUserId: session.user.id,
    bookerIsGuardian: resolved?.bookerIsGuardian ?? false,
    kind: "PACKAGE_BUY",
    amount: totalAmount,
    payload: { packageId: pkg.id, memberId: member.id },
  });
  if (gate.kind === "block") {
    return NextResponse.json(gate.body, { status: gate.status });
  }
  if (gate.kind === "queue") {
    return NextResponse.json(gate.response, { status: 202 });
  }

  const platformFee = calculatePlatformFee(totalCents, club.tier);
  const feeItem = processingFeeLineItem(totalCents, club.passProcessingFees);
  const baseUrl = getAppBaseUrl();

  const checkoutSession = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: totalCents,
            product_data: {
              name: pkg.title,
              ...(pkg.description ? { description: pkg.description } : {}),
            },
          },
        },
        ...(feeItem ? [feeItem] : []),
      ],
      // Packages are now an inline offer inside the private-request
      // flow, not a separate shop. Redirect back to /member/privates
      // so the athlete lands where the credits become usable.
      success_url: `${baseUrl}/member/privates?bought=1`,
      cancel_url: `${baseUrl}/member/privates?canceled=1`,
      payment_intent_data: {
        application_fee_amount: platformFee,
        metadata: {
          privatePackageId: pkg.id,
          memberId: member.id,
          clubId,
        },
      },
      // Webhook reads from the top-level session.metadata. We mirror the
      // payment_intent.metadata so either source resolves the right
      // package + member.
      metadata: {
        privatePackageId: pkg.id,
        memberId: member.id,
        clubId,
      },
    },
    { stripeAccount: club.stripeAccountId },
  );

  return NextResponse.json({ url: checkoutSession.url });
}
