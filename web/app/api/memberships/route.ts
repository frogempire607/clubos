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
import { HOLDS_MEMBERSHIP_STATUSES } from "@/lib/membersQuery";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const memberships = await prisma.membership.findMany({
    where: { clubId: session.user.clubId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    // `_count.members` counts Member.membershipId — a denormalised "current
    // plan" pointer that goes stale — and it is deliberately still returned so
    // nothing that reads it breaks. It is NOT the member count any more.
    include: { _count: { select: { members: true } } },
  });

  // Who actually holds each plan, counted from subscriptions.
  //
  // On 2026-08-25 the pointer-based count said Girls Only had 0 members while
  // Beatriz Godden and Dakota Mastrantonio were both on it, and said Girls Jr
  // Frogs had 2 on the strength of two pointers left behind by memberships that
  // had ended. Neither number described anybody.
  //
  // One grouped query for the whole list, not one per plan — this endpoint
  // renders every membership card on the page.
  const held = await prisma.memberSubscription.groupBy({
    by: ["membershipId"],
    where: {
      membershipId: { in: memberships.map((m) => m.id) },
      status: { in: [...HOLDS_MEMBERSHIP_STATUSES] },
      member: { clubId: session.user.clubId, deletedAt: null },
    },
    _count: { _all: true },
  });
  const heldBy = new Map(held.map((h) => [h.membershipId, h._count._all]));

  return NextResponse.json(
    memberships.map((m) => ({ ...m, activeMemberCount: heldBy.get(m.id) ?? 0 })),
  );
}

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


const createSchema = z.object({
  name:                    z.string().min(1),
  description:             z.string().optional(),
  options:                 z.array(optionSchema).min(1),
  active:                  z.boolean().default(true),
  purchaseAccess:          z.enum(["ANYONE", "STAFF_ONLY"]).default("ANYONE"),
  autoRenewDefault:        z.boolean().default(true),
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
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "finances", "edit");
  if (denied) return denied;

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const checked = validateOptionsForSave(data.options);
    if (!checked.ok) {
      return NextResponse.json({ error: checked.error, code: checked.code }, { status: 400 });
    }
    const options = checked.options;

    const membership = await prisma.membership.create({
      data: {
        clubId:                  session.user.clubId,
        name:                    data.name,
        description:             data.description || null,
        options:                 serializeOptions(options),
        active:                  data.active,
        purchaseAccess:          data.purchaseAccess,
        autoRenewDefault:        data.autoRenewDefault,
        // allowManualRenewal is intentionally not set here (decision D5) — the
        // column keeps its default and nothing reads it. See lib/membershipOptions.ts.
        allowCustomDates:        data.allowCustomDates,
        allowBillingDayOverride: data.allowBillingDayOverride,
        defaultBillingDay:       data.defaultBillingDay ?? null,
        contractMonths:          data.contractMonths ?? null,
        trialEnabled:            data.trialEnabled,
        trialDays:               data.trialEnabled ? (data.trialDays ?? null) : null,
        trialAppliesToReturning: data.trialAppliesToReturning,
      },
    });

    // Pre-provision the plan's Stripe catalog Product so owners never have to
    // create products in Stripe by hand. No-op (returns null) until the club
    // finishes Connect onboarding; safe + non-blocking (errors are swallowed).
    const club = await prisma.club.findUnique({
      where: { id: session.user.clubId },
      select: { id: true, stripeAccountId: true, stripeChargesEnabled: true },
    });
    if (club) await ensureMembershipProduct(membership, club);

    return NextResponse.json(membership, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
