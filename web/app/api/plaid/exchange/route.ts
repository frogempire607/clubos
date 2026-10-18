import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { plaidClient } from "@/lib/plaid";
import { prisma } from "@/lib/prisma";
import { requireTierFeature, clubTier, limitBlocked } from "@/lib/tierGuard";

const schema = z.object({ publicToken: z.string() });

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Tier gate (pricing overhaul 2026-10-18) — enforced server-side.
  const tierGate = await requireTierFeature(session.user.clubId, "plaid");
  if (tierGate) return tierGate;
  // Bank-account limit by plan (Pro 2, Enterprise unlimited). A new bank
  // login can add several accounts; we refuse once the club is AT its limit.
  {
    const count = await prisma.bankAccount.count({ where: { clubId: session.user.clubId, connection: { deletedAt: null } } });
    const lim = limitBlocked(await clubTier(session.user.clubId), "maxBankAccounts", count);
    if (lim) return lim;
  }

  try {
    const { publicToken } = schema.parse(await req.json());
    const res = await plaidClient.itemPublicTokenExchange({ public_token: publicToken });
    const accessToken = res.data.access_token;
    const itemId = res.data.item_id;

    await prisma.plaidConnection.upsert({
      where: { itemId },
      update: { accessToken, deletedAt: null },
      create: {
        clubId: session.user.clubId,
        accessToken,
        itemId,
        label: "Primary",
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Plaid exchange error:", err);
    return NextResponse.json({ error: "Failed to exchange token" }, { status: 500 });
  }
}
