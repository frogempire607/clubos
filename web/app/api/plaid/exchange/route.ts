import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";

const schema = z.object({ publicToken: z.string() });

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { publicToken } = schema.parse(await req.json());
    const res = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = res.data.access_token;
    const itemId = res.data.item_id;

    // Mirror legacy fields for back-compat AND create a row in the new
    // plaid_connections table so the multi-bank API sees it.
    await prisma.$transaction([
      prisma.club.update({
        where: { id: session.user.clubId },
        data: { plaidAccessToken: accessToken, plaidItemId: itemId },
      }),
      prisma.plaidConnection.upsert({
        where: { itemId },
        update: { accessToken, deletedAt: null },
        create: {
          clubId: session.user.clubId,
          accessToken,
          itemId,
          label: "Primary",
        },
      }),
    ]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Plaid exchange error:", err);
    return NextResponse.json({ error: "Failed to exchange token" }, { status: 500 });
  }
}
