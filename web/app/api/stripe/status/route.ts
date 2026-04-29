import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      stripeAccountId: true,
      stripeOnboardingComplete: true,
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
    },
  });

  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  if (club.stripeAccountId) {
    try {
      const account = await stripe.accounts.retrieve(club.stripeAccountId);

      const updated = {
        stripeOnboardingComplete: account.details_submitted ?? false,
        stripeChargesEnabled: account.charges_enabled ?? false,
        stripePayoutsEnabled: account.payouts_enabled ?? false,
      };

      if (
        updated.stripeOnboardingComplete !== club.stripeOnboardingComplete ||
        updated.stripeChargesEnabled !== club.stripeChargesEnabled ||
        updated.stripePayoutsEnabled !== club.stripePayoutsEnabled
      ) {
        await prisma.club.update({
          where: { id: session.user.clubId },
          data: updated,
        });
      }

      return NextResponse.json({ connected: true, ...updated });
    } catch (err) {
      return NextResponse.json({
        connected: true,
        ...club,
        error: "Couldn't refresh from Stripe",
      });
    }
  }

  return NextResponse.json({
    connected: false,
    stripeOnboardingComplete: false,
    stripeChargesEnabled: false,
    stripePayoutsEnabled: false,
  });
}
