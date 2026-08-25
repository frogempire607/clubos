import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { setAutoRenew } from "@/lib/autopay";
import { SUBSCRIPTION_EVENT_SOURCE } from "@/lib/subscriptionEvents";

// GET/POST /api/member/subscriptions/[id]/auto-renew
//
// The member's own toggle: does this membership start ANOTHER term when the
// current one finishes.
//
// ── Why this executes while the autopay one queues ──────────────────────────
//
// Owner's rule, and it is the right line: cancelling inside a commitment needs
// approval because that money is already promised, but choosing not to start a
// FURTHER commitment is a decision about money nobody has committed yet. There
// is nothing for the club to weigh, and making a family ask permission to not
// re-sign is how a club acquires a reputation it does not want.
//
// It is also safe by construction: turning it off schedules the stop at the end
// of the term (§8.6.6), so it can never cut a commitment short — the family
// still pays out everything they agreed to. Turning it back on clears the stop.
const schema = z.object({ autoRenew: z.boolean() });

async function authorize(subscriptionId: string, clubId: string, userId: string) {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: subscriptionId, member: { clubId, deletedAt: null } },
    select: {
      id: true, memberId: true, status: true, autoRenew: true, optionLabel: true,
      price: true, billingPeriod: true, endDate: true, minimumTermEndsAt: true,
      currentPeriodEnd: true, paidThroughDate: true,
      member: { select: { userId: true, commitmentEndDate: true } },
    },
  });
  if (!sub) return { error: NextResponse.json({ error: "Membership not found." }, { status: 404 }) };
  if (sub.member.userId !== userId) {
    const link = await prisma.memberGuardianUser.findUnique({
      where: { userId_memberId: { userId, memberId: sub.memberId } },
      select: { userId: true },
    });
    if (!link) return { error: NextResponse.json({ error: "You don't manage this membership." }, { status: 403 }) };
  }
  return { sub };
}

const dayStr = (d: Date) =>
  d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const gate = await authorize(id, session.user.clubId, session.user.id);
  if (gate.error) return gate.error;
  const sub = gate.sub!;

  const term = sub.minimumTermEndsAt ?? sub.member.commitmentEndDate ?? null;
  const termRunning = !!term && term.getTime() > Date.now();

  return NextResponse.json({
    autoRenew: sub.autoRenew,
    optionLabel: sub.optionLabel,
    // What turning it off would actually mean, in the family's words. Stated
    // from the row rather than assumed, because "when does this stop" is the
    // one question the toggle has to answer honestly.
    termEndsOn: termRunning ? term : null,
    stopsOn: sub.autoRenew
      ? null
      : sub.endDate ?? (termRunning ? term : sub.currentPeriodEnd ?? sub.paidThroughDate ?? null),
    explanation: sub.autoRenew
      ? termRunning
        ? `Renews into another term after ${dayStr(term!)}. Turn this off and it finishes that term and stops — you'll still pay out what you signed up for.`
        : "Renews automatically. Turn this off and it stops at the end of the period you've paid for."
      : termRunning
        ? `Set to finish on ${dayStr(term!)} and not renew. You'll still be billed through that date.`
        : "Set to stop at the end of the period you've paid for.",
  });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }
  const gate = await authorize(id, session.user.clubId, session.user.id);
  if (gate.error) return gate.error;
  const sub = gate.sub!;

  if (sub.status === "canceled" || sub.status === "expired") {
    return NextResponse.json({ error: "This membership has already ended." }, { status: 409 });
  }

  // The same function the owner path uses, so there is one implementation of
  // what auto-renew means and the member cannot reach a different one.
  const result = await setAutoRenew(sub.id, session.user.clubId, body.autoRenew, {
    userId: session.user.id,
    source: SUBSCRIPTION_EVENT_SOURCE.MEMBER_ACTION,
  });
  if (!result.ok) {
    if (result.code === "UNCHANGED") return NextResponse.json({ ok: true, unchanged: true });
    const status = result.code === "STRIPE_FAILED" ? 502 : 409;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }
  return NextResponse.json({ ok: true, autoRenew: body.autoRenew, message: result.message });
}
