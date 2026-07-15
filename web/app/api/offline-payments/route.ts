import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { resolvePermissions, hasPermission } from "@/lib/permissions";

export const dynamic = "force-dynamic";

// GET /api/offline-payments — every outstanding cash/check payment in the club
// (PENDING transactions with paymentSource CASH/CHECK), with the member
// attached. This is a READ-ONLY finder for the surfaces that make the
// existing record-received flow easy to reach (Approvals section, attendance
// "owes" chips). Recording still goes through
// POST /api/members/[id]/offline-payment (billing:full) — one engine.
//
// Visible to desk staff too: billing:view OR attendance:edit (owners bypass).
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "OWNER") {
    // Session augmentation doesn't declare `permissions` — same cast
    // convention as lib/apiGuard.ts.
    const perms = resolvePermissions(
      (session.user as { permissions?: Record<string, unknown> | null }).permissions,
    );
    const allowed = hasPermission(perms, "billing", "view") || hasPermission(perms, "attendance", "edit");
    if (!allowed) return NextResponse.json({ error: "Not permitted" }, { status: 403 });
  }

  const rows = await prisma.transaction.findMany({
    where: {
      clubId: session.user.clubId,
      status: "PENDING",
      paymentSource: { in: ["CASH", "CHECK"] },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      amount: true,
      paymentSource: true,
      description: true,
      discountCode: true,
      createdAt: true,
      member: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  return NextResponse.json({
    outstanding: rows
      .filter((t) => t.member)
      .map((t) => ({
        transactionId: t.id,
        memberId: t.member!.id,
        memberName: `${t.member!.firstName} ${t.member!.lastName ?? ""}`.trim(),
        amount: Number(t.amount),
        method: t.paymentSource as "CASH" | "CHECK",
        description: t.description,
        discountCode: t.discountCode,
        acceptedAt: t.createdAt,
        stateLabel:
          t.paymentSource === "CHECK"
            ? "Client accepted — awaiting check payment"
            : "Client accepted — awaiting cash payment",
      })),
  });
}
