import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// POST /api/memberships/[id]/duplicate — clone a membership plan.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const src = await prisma.membership.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
  });
  if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const copy = await prisma.membership.create({
    data: {
      clubId: src.clubId,
      name: `${src.name} (Copy)`,
      description: src.description,
      options: src.options as object,
      active: false,
      purchaseAccess: src.purchaseAccess,
      autoRenewDefault: src.autoRenewDefault,
      allowManualRenewal: src.allowManualRenewal,
      allowCustomDates: src.allowCustomDates,
      allowBillingDayOverride: src.allowBillingDayOverride,
      defaultBillingDay: src.defaultBillingDay,
      contractMonths: src.contractMonths,
      trialEnabled: src.trialEnabled,
      trialDays: src.trialDays,
      trialAppliesToReturning: src.trialAppliesToReturning,
    },
  });
  return NextResponse.json(copy, { status: 201 });
}
