import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// GET /api/members/migration/[id]
// Full migration detail for the Set-up / Review-&-approve drawer, including
// the client's submitted requests and the resolved activation link.
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "view");
  if (denied) return denied;

  const m = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: {
      id: true, firstName: true, lastName: true, email: true, guardianEmail: true, isMinor: true,
      legacySource: true, legacyMembershipName: true, legacyMembershipPrice: true,
      legacyBillingFrequency: true, membershipStartDate: true, nextBillingDate: true,
      billingAnchorDate: true, commitmentEndDate: true, migrationStatus: true,
      approvalStatus: true, paymentSetupStatus: true, migrationMembershipId: true,
      migrationPriceOverride: true, migrationDiscountNote: true,
      activationEditableFields: true, requestedBillingDate: true, requestedBillingNote: true,
      activationNote: true, activationToken: true, activationTokenExpires: true,
      activationEmailSentAt: true, activationEmailSendCount: true,
    },
  });
  if (!m) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  const activationUrl = m.activationToken ? `${baseUrl}/activate/${m.activationToken}` : null;

  return NextResponse.json({ member: m, activationUrl });
}

const patchSchema = z.object({
  migrationMembershipId: z.string().optional().nullable(),
  billingAnchorDate: z.string().optional().nullable(),
  commitmentEndDate: z.string().optional().nullable(),
  priceOverride: z.number().nonnegative().optional().nullable(),
  discountNote: z.string().max(200).optional().nullable(),
  activationEditableFields: z
    .object({
      phone: z.boolean().optional(),
      email: z.boolean().optional(),
      billingDateRequest: z.boolean().optional(),
      notes: z.boolean().optional(),
    })
    .optional()
    .nullable(),
});

// PATCH — owner sets up the migration before sending the activation link:
// which plan it continues, the billing anchor (matching the old software's
// cycle or manually edited), the commitment/termination date, and which
// fields the client may edit during activation.
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "members", "edit");
  if (denied) return denied;

  const member = await prisma.member.findFirst({
    where: { id, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, clubId: true },
  });
  if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let data: z.infer<typeof patchSchema>;
  try {
    data = patchSchema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  // Validate the assigned plan belongs to this club.
  if (data.migrationMembershipId) {
    const plan = await prisma.membership.findFirst({
      where: { id: data.migrationMembershipId, clubId: member.clubId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) return NextResponse.json({ error: "Membership plan not found" }, { status: 400 });
  }

  const parseDate = (s: string | null | undefined) => {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  };

  const updated = await prisma.member.update({
    where: { id },
    data: {
      ...(data.migrationMembershipId !== undefined
        ? { migrationMembershipId: data.migrationMembershipId || null }
        : {}),
      ...(data.billingAnchorDate !== undefined
        ? { billingAnchorDate: parseDate(data.billingAnchorDate) }
        : {}),
      ...(data.commitmentEndDate !== undefined
        ? { commitmentEndDate: parseDate(data.commitmentEndDate) }
        : {}),
      ...(data.priceOverride !== undefined
        ? { migrationPriceOverride: data.priceOverride }
        : {}),
      ...(data.discountNote !== undefined
        ? { migrationDiscountNote: data.discountNote?.trim() || null }
        : {}),
      ...(data.activationEditableFields !== undefined
        ? { activationEditableFields: data.activationEditableFields ?? undefined }
        : {}),
    },
    select: { id: true, migrationMembershipId: true, billingAnchorDate: true, commitmentEndDate: true },
  });

  await prisma.memberMigrationEvent.create({
    data: {
      clubId: member.clubId,
      memberId: id,
      type: "NOTE",
      message: "Migration setup updated (plan / billing date / editable fields)",
      actorUserId: session.user.id,
    },
  });

  return NextResponse.json({ ok: true, member: updated });
}
