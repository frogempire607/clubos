import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { CountryCode, Products } from "plaid";

export async function POST() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Plaid bank sync requires Growth plan or higher
  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { tier: true },
  });
  const features = getTierFeatures(club?.tier ?? "starter");
  if (!features.plaid) {
    return NextResponse.json(
      {
        error: "Bank integration requires a Growth plan or higher.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "growth",
      },
      { status: 403 }
    );
  }

  if (!process.env.PLAID_CLIENT_ID || !process.env.PLAID_SECRET) {
    return NextResponse.json({ error: "Plaid not configured" }, { status: 503 });
  }

  try {
    const res = await plaidClient.linkTokenCreate({
      user: { client_user_id: session.user.id },
      client_name: "ClubOS",
      products: [Products.Transactions],
      country_codes: [CountryCode.Us],
      language: "en",
    });

    return NextResponse.json({ linkToken: res.data.link_token });
  } catch (err) {
    console.error("Plaid link-token error:", err);
    return NextResponse.json({ error: "Failed to create link token" }, { status: 500 });
  }
}
