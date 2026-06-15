import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberships = await prisma.membership.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { members: true } } },
  });

  return NextResponse.json(memberships);
}

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

const createSchema = z.object({
  name:                    z.string().min(1),
  description:             z.string().optional(),
  options:                 z.array(optionSchema).min(1),
  active:                  z.boolean().default(true),
  purchaseAccess:          z.enum(["ANYONE", "STAFF_ONLY"]).default("ANYONE"),
  autoRenewDefault:        z.boolean().default(true),
  allowManualRenewal:      z.boolean().default(true),
  allowCustomDates:        z.boolean().default(false),
  allowBillingDayOverride: z.boolean().default(false),
  defaultBillingDay:       z.number().int().min(1).max(28).optional().nullable(),
  contractMonths:          z.number().int().positive().optional().nullable(),
  trialEnabled:            z.boolean().default(false),
  trialDays:               z.number().int().positive().max(365).optional().nullable(),
  trialAppliesToReturning: z.boolean().default(false),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const membership = await prisma.membership.create({
      data: {
        clubId:                  session.user.clubId,
        name:                    data.name,
        description:             data.description || null,
        options:                 JSON.stringify(data.options),
        active:                  data.active,
        purchaseAccess:          data.purchaseAccess,
        autoRenewDefault:        data.autoRenewDefault,
        allowManualRenewal:      data.allowManualRenewal,
        allowCustomDates:        data.allowCustomDates,
        allowBillingDayOverride: data.allowBillingDayOverride,
        defaultBillingDay:       data.defaultBillingDay ?? null,
        contractMonths:          data.contractMonths ?? null,
        trialEnabled:            data.trialEnabled,
        trialDays:               data.trialEnabled ? (data.trialDays ?? null) : null,
        trialAppliesToReturning: data.trialAppliesToReturning,
      },
    });

    return NextResponse.json(membership, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
