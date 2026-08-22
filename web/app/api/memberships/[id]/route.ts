import { NextResponse } from "next/server";
import { z } from "zod";
import {
  serializeOptions,
  validateOptionsForSave,
  type MembershipOption,
} from "@/lib/membershipOptions";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";

// Accept the option objects loosely here and let lib/membershipOptions.parseOptions
// be the ONE validator, exactly as it is the one parser everywhere else.
//
// This used to be a closed z.object of three keys. Zod strips unknown keys, so
// it silently deleted `id`, `contractMonths`, `autoRenewDefault`, `entitlement`
// and `requiredDocumentIds` from every option on every write — the option
// identity that `member_subscriptions.optionId` resolves against. A second
// schema for a blob that already has a parser is exactly the drift the option
// model was consolidated to stop.
//
// Loose does not mean unvalidated: `readOptions` below rejects the request if
// the parser cannot make sense of any entry, so a malformed period still 400s
// rather than being quietly dropped.
const optionSchema = z.record(z.unknown());

// Validation lives in lib/membershipOptions.validateOptionsForSave — one gate,
// shared by both routes, with the message next to the rule. It rejects entries
// the parser cannot read AND two options that share a billing period and a
// price, which is the one shape that makes a subscription's option
// unidentifiable.


const updateSchema = z.object({
  name:                   z.string().min(1).optional(),
  description:            z.string().optional().nullable(),
  options:                z.array(optionSchema).optional(),
  active:                 z.boolean().optional(),
  purchaseAccess:         z.enum(["ANYONE", "STAFF_ONLY"]).optional(),
  autoRenewDefault:       z.boolean().optional(),
  allowCustomDates:       z.boolean().optional(),
  allowBillingDayOverride: z.boolean().optional(),
  defaultBillingDay:      z.number().int().min(1).max(28).optional().nullable(),
  contractMonths:         z.number().int().positive().optional().nullable(),
  trialEnabled:           z.boolean().optional(),
  trialDays:              z.number().int().positive().max(365).optional().nullable(),
  trialAppliesToReturning: z.boolean().optional(),
});

async function requireMembership(id: string, clubId: string) {
  return prisma.membership.findFirst({
    where: { id, clubId, deletedAt: null },
  });
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(membership);
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    const body = await req.json();
    const data = updateSchema.parse(body);

    // undefined = the caller is not touching options at all; null = they sent
    // something the parser could not read, which must fail loudly.
    let options: MembershipOption[] | undefined;
    if (data.options) {
      const checked = validateOptionsForSave(data.options);
      if (!checked.ok) {
        return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
      }
      options = checked.options;
    }

    const updated = await prisma.membership.update({
      where: { id: params.id },
      data: {
        name:                    data.name,
        description:             data.description,
        options:                 options ? serializeOptions(options) : undefined,
        active:                  data.active,
        purchaseAccess:          data.purchaseAccess,
        autoRenewDefault:        data.autoRenewDefault,
        // D5: no longer accepted or written. Prisma ignores an absent key, so
        // whatever value a plan already holds is preserved untouched.
        allowCustomDates:        data.allowCustomDates,
        allowBillingDayOverride: data.allowBillingDayOverride,
        defaultBillingDay:       data.defaultBillingDay,
        contractMonths:          data.contractMonths,
        trialEnabled:            data.trialEnabled,
        // Force trialDays to null when trial is disabled to keep state clean
        trialDays:               data.trialEnabled === false ? null : data.trialDays,
        trialAppliesToReturning: data.trialAppliesToReturning,
      },
    });

    return NextResponse.json(updated);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Staff with full Events/purchase-options access can delete — not owner-only.
  const denied = requirePermission(session, "events", "full");
  if (denied) return denied;

  const membership = await requireMembership(params.id, session.user.clubId);
  if (!membership) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.membership.update({
    where: { id: params.id },
    data: { deletedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
