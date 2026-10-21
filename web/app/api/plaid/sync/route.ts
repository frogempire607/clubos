import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireBankConnect } from "@/lib/plaidGate";
import { prisma } from "@/lib/prisma";
import { plaidClient } from "@/lib/plaid";
import { syncConnection } from "@/lib/plaidSync";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/plaid/sync
//   { connectionId?: string }
//
// Pulls fresh transactions from Plaid /transactions/sync and persists them.
// - With connectionId: sync just that bank.
// - Without: sync every active bank on the club.
//
// Owner + finances:full only. First-time sync on a fresh connection pulls the
// full account history (that's how the "All time" range gets its data).
const schema = z.object({
  connectionId: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "full");
  if (denied) return denied;

  // Phase 11 task 8: ONE hard gate for connecting/syncing a bank.
  // Starter can never connect, whatever it already has. See lib/plaidGate.ts.
  const tierGate = await requireBankConnect(session.user.clubId);
  if (tierGate) return tierGate;

  const body = await req.json().catch(() => ({}));
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { connectionId } = parsed.data;

  const connections = await prisma.plaidConnection.findMany({
    where: {
      clubId: session.user.clubId,
      deletedAt: null,
      ...(connectionId ? { id: connectionId } : {}),
    },
    select: { id: true, label: true, institutionName: true },
  });
  if (connections.length === 0) {
    return NextResponse.json({ error: "No matching bank connection" }, { status: 404 });
  }

  const results = [];
  for (const c of connections) {
    const r = await syncConnection(prisma, plaidClient, c.id);
    results.push({
      connectionId: c.id,
      label: c.label || c.institutionName || "Bank",
      ...r,
      earliestDate: r.earliestDate?.toISOString().slice(0, 10) ?? null,
    });
  }

  return NextResponse.json({ ok: true, results });
}
