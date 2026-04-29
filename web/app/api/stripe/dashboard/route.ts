import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { stripe } from "@/lib/stripe";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { stripeAccountId: true },
  });

  if (!club?.stripeAccountId) {
    return NextResponse.json({ error: "Stripe not connected" }, { status: 400 });
  }

  try {
    const link = await stripe.accounts.createLoginLink(club.stripeAccountId);
    return NextResponse.json({ url: link.url });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
