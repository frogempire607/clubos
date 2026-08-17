import { NextResponse } from "next/server";
import { z } from "zod";
import { parseOptions, serializeOptions, type MembershipOption } from "@/lib/membershipOptions";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { ensureMembershipProduct } from "@/lib/stripeCatalog";

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

/**
 * Validate + normalize a submitted options array through the canonical parser.
 * Returns null when any entry is unusable, so a bad billingPeriod is a 400
 * instead of a silently vanished purchase option.
 */
function readOptions(raw: unknown[]): MembershipOption[] | null {
  const parsed = parseOptions(raw);
  return parsed.length === raw.length ? parsed : null;
}


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
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const data = createSchema.parse(body);

    const options = readOptions(data.options);
    if (!options) {
      return NextResponse.json({ error: "One or more purchase options are malformed" }, { status: 400 });
    }

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
