import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";

// GET /api/plaid/connections — list every active bank connection for the
// current club, plus the cached institution name so the UI can label them.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.plaid) {
    return NextResponse.json({
      connections: [],
      multipleAllowed: false,
      upgradeRequired: "pro" as const,
    });
  }

  const connections = await prisma.plaidConnection.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      label: true,
      institutionName: true,
      itemId: true,
      createdAt: true,
    },
  });

  return NextResponse.json({
    connections,
    // Plaid itself starts at Pro per lib/tier.ts, so any tier that can use
    // Plaid at all may add multiple banks. Kept as a separate flag so the
    // tier matrix can evolve later without changing the response shape.
    multipleAllowed: true,
  });
}

const postSchema = z.object({
  publicToken: z.string(),
  label: z.string().max(80).optional(),
});

// POST /api/plaid/connections — exchange a Plaid public token for an
// access token and persist it as a new connection. Replaces the legacy
// single-account exchange (which still works for back-compat).
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const club = await prisma.club.findUnique({ where: { id: session.user.clubId } });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.plaid) {
    return NextResponse.json(
      { error: "Bank integration requires a Pro plan or higher.", upgradeRequired: "pro" },
      { status: 403 },
    );
  }

  try {
    const { publicToken, label } = postSchema.parse(await req.json());

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = exchange.data.access_token;
    const itemId = exchange.data.item_id;

    // Look up the institution name so the UI has something readable to
    // show even if the owner doesn't supply a label.
    let institutionName: string | null = null;
    try {
      const item = await plaidClient.itemGet({ access_token: accessToken });
      const institutionId = item.data.item.institution_id;
      if (institutionId) {
        const inst = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: ["US"] as never,
        });
        institutionName = inst.data.institution.name ?? null;
      }
    } catch (e) {
      // Non-fatal — the connection still works without the cached name.
      console.warn("Plaid institutionsGetById failed:", e);
    }

    const connection = await prisma.plaidConnection.create({
      data: {
        clubId: session.user.clubId,
        accessToken,
        itemId,
        label: label || institutionName || null,
        institutionName,
      },
    });

    return NextResponse.json({
      id: connection.id,
      label: connection.label,
      institutionName: connection.institutionName,
    });
  } catch (err) {
    console.error("Plaid connection create error:", err);
    return NextResponse.json({ error: "Failed to add bank connection" }, { status: 500 });
  }
}
