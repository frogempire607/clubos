import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

const optionSchema = z.object({
  label: z.string().min(1),
  price: z.number().min(0),
  billingPeriod: z.enum([
    "WEEKLY",
    "MONTHLY",
    "QUADRIMESTRAL",
    "QUARTERLY",
    "SEMI_ANNUAL",
    "ANNUAL",
    "ONE_TIME",
  ]),
});

const updateSchema = z.object({
  name:                   z.string().min(1).optional(),
  description:            z.string().optional().nullable(),
  options:                z.array(optionSchema).optional(),
  active:                 z.boolean().optional(),
  purchaseAccess:         z.enum(["ANYONE", "STAFF_ONLY"]).optional(),
  autoRenewDefault:       z.boolean().optional(),
  allowManualRenewal:     z.boolean().optional(),
  allowCustomDates:       z.boolean().optional(),
  allowBillingDayOverride: z.boolean().optional(),
  defaultBillingDay:      z.number().int().min(1).max(28).optional().nullable(),
  contractMonths:         z.number().int().positive().optional().nullable(),
});

async function requireMembership(id: string, clubId: string) {
  return prisma.membership.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(membership);
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    const updated = await prisma.membership.update({
      where: { id: params.id },
      data: {
        name:                    data.name,
        description:             data.description,
        options:                 data.options ? JSON.stringify(data.options) : undefined,
        active:                  data.active,
        purchaseAccess:          data.purchaseAccess,
        autoRenewDefault:        data.autoRenewDefault,
        allowManualRenewal:      data.allowManualRenewal,
        allowCustomDates:        data.allowCustomDates,
        allowBillingDayOverride: data.allowBillingDayOverride,
        defaultBillingDay:       data.defaultBillingDay,
        contractMonths:          data.contractMonths,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_: Request, { params }: { params: { id: string } }) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.membership.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
