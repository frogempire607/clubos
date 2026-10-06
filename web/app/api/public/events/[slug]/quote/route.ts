import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { registrationListPrice, registrationPriceTiers } from "@/lib/eventRepricing";
import { rateLimit, rateLimitedResponse, ipFromRequest } from "@/lib/ratelimit";
import { linkAccess } from "@/lib/eventShareLink";
import { resolveEventLink } from "@/lib/eventShareLinkServer";
import { findMemberForPublicSignup } from "@/lib/publicSignupMember";

// POST /api/public/events/[slug]/quote
// NO AUTH, read-only. "Which price is mine?" for an event that charges members
// and non-members differently: the page sends the athlete's name and email and
// gets back the tier and the unit price the register route will use — the same
// match (email AND name) and the same resolver, so the number on screen before
// they submit is the number they're charged.
//
// It answers only for events that actually have two prices, and it is rate
// limited like the discount check: it says whether a name+email pair is a
// member, which the register route already reveals through the amount.
const schema = z.object({ name: z.string().min(1).max(200), email: z.string().email().max(320) });

export async function POST(req: Request, context: { params: Promise<{ slug: string }> }) {
  const rl = rateLimit({ key: `quote:public:${ipFromRequest(req)}`, limit: 30, windowMs: 10 * 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many attempts. Try again in a few minutes.");

  const params = await context.params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Enter the athlete's name and a valid email." }, { status: 400 });
  }

  const link = await resolveEventLink(params.slug);
  const event = await prisma.event.findUnique({
    where: link.where,
    select: {
      id: true,
      clubId: true,
      deletedAt: true,
      publishAt: true,
      unpublishAt: true,
      registrationDeadline: true,
      signupAccess: true,
      publicRegistration: true,
      tournamentMode: true,
      publicPricingOption: true,
      memberPrice: true,
      nonMemberPrice: true,
      dropInFee: true,
      variableCostEnabled: true,
    },
  });
  const access = linkAccess(link.via, event);
  if (!event || !access.ok) {
    return NextResponse.json({ error: access.ok ? "Event not found" : access.error }, { status: access.ok ? 404 : access.status });
  }
  if (!access.canRegister) {
    return NextResponse.json({ error: "Public registration is not enabled for this event" }, { status: 403 });
  }

  // One price (or billed later): nothing to decide, and nothing to look up.
  const tiers = registrationPriceTiers(event);
  if (event.variableCostEnabled || !tiers.differ) {
    return NextResponse.json({ tier: null, price: event.variableCostEnabled ? null : tiers.other });
  }

  const memberId = await findMemberForPublicSignup({ clubId: event.clubId, email: body.email, name: body.name });
  return NextResponse.json({
    tier: memberId ? "MEMBER" : "NON_MEMBER",
    price: registrationListPrice(event, { memberId }),
  });
}
