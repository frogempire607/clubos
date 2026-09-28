import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { setAutoRenew } from "@/lib/autopay";
import {
  recordSubscriptionEvent,
  SUBSCRIPTION_EVENT_KIND,
  SUBSCRIPTION_EVENT_SOURCE,
} from "@/lib/subscriptionEvents";
import { dayLabel } from "@/lib/autoRenewCopy";
import {
  payablePeopleFor,
  clubOwnerUserId,
  describeForPortal,
  AUTO_RENEW_SUB_SELECT,
  type PayablePerson,
} from "@/lib/memberAutoRenewAccess";

// GET/POST /api/member/subscriptions/[id]/auto-renew
//
// The family's own toggle: does this membership start ANOTHER term when the
// current one finishes. Any membership — Stripe or cash — for anyone the
// signed-in adult can pay for (lib/memberAutoRenewAccess).
//
// ── Why this executes while the autopay one queues ──────────────────────────
//
// Owner's rule, and it is the right line: cancelling inside a commitment needs
// approval because that money is already promised, but choosing not to start a
// FURTHER commitment is a decision about money nobody has committed yet. There
// is nothing for the club to weigh, so there is no approval setting for it —
// the club is TOLD (a message to the owner, the billing audit and the
// subscription timeline), not asked.
//
// It is also safe by construction: turning it off stops at the commitment end
// (Stripe `cancel_at`; offline `endDate`), never earlier, so the family still
// pays out everything they agreed to. Turning it back on clears the stop. The
// mechanics are lib/autopay setAutoRenew — the same function staff use.
const schema = z.object({ autoRenew: z.boolean() });

async function authorize(subscriptionId: string, clubId: string, userId: string) {
  const sub = await prisma.memberSubscription.findFirst({
    where: { id: subscriptionId, member: { clubId, deletedAt: null } },
    select: AUTO_RENEW_SUB_SELECT,
  });
  if (!sub) return { error: NextResponse.json({ error: "Membership not found." }, { status: 404 }) };
  const people = await payablePeopleFor(userId, clubId);
  const person = people.find((p) => p.memberId === sub.memberId);
  if (!person) {
    return {
      error: NextResponse.json(
        { error: "Only a parent or guardian who pays for this membership can change auto-renew." },
        { status: 403 },
      ),
    };
  }
  return { sub, person };
}

async function describe(sub: NonNullable<Awaited<ReturnType<typeof authorize>>["sub"]>, person: PayablePerson, clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { passProcessingFees: true } });
  return describeForPortal({
    sub, person, passProcessingFees: !!club?.passProcessingFees, card: null, lastPaidMethod: null, now: new Date(),
  });
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const gate = await authorize(id, session.user.clubId, session.user.id);
  if (gate.error) return gate.error;
  const row = await describe(gate.sub!, gate.person!, session.user.clubId);
  return NextResponse.json({
    autoRenew: row.autoRenew,
    optionLabel: gate.sub!.optionLabel,
    termEndsOn: row.copy.commitmentEndsOn,
    stopsOn: row.autoRenew ? null : row.copy.stopsOn,
    explanation: row.copy.currentSentence,
    offSentence: row.copy.offSentence,
    onSentence: row.copy.onSentence,
    canToggle: row.copy.canToggle,
    blockedReason: row.copy.blockedReason,
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
  const clubId = session.user.clubId;
  const gate = await authorize(id, clubId, session.user.id);
  if (gate.error) return gate.error;
  const sub = gate.sub!;
  const person = gate.person!;

  if (sub.status === "canceled" || sub.status === "expired") {
    return NextResponse.json({ error: "This membership has already ended." }, { status: 409 });
  }
  const before = await describe(sub, person, clubId);
  if (!before.copy.canToggle && !body.autoRenew) {
    return NextResponse.json({ error: before.copy.blockedReason, code: "NOT_READY" }, { status: 409 });
  }

  const source = person.isSelf ? SUBSCRIPTION_EVENT_SOURCE.MEMBER_ACTION : SUBSCRIPTION_EVENT_SOURCE.GUARDIAN_ACTION;
  // The same function the staff path uses, so there is one implementation of
  // what auto-renew means and the family cannot reach a different one.
  const result = await setAutoRenew(sub.id, clubId, body.autoRenew, { userId: session.user.id, source });
  if (!result.ok) {
    if (result.code === "UNCHANGED") return NextResponse.json({ ok: true, unchanged: true });
    const status = result.code === "STRIPE_FAILED" ? 502 : 409;
    // Never leak a raw Stripe error to a family.
    const error = result.code === "STRIPE_FAILED"
      ? "We couldn't update this with the card processor. Nothing changed — try again, or ask your club."
      : result.error;
    return NextResponse.json({ error, code: result.code }, { status });
  }

  // Re-read the row: the stop date Stripe answered with is what we report.
  const fresh = await prisma.memberSubscription.findFirst({ where: { id: sub.id }, select: AUTO_RENEW_SUB_SELECT });
  const after = fresh ? await describe(fresh, person, clubId) : before;
  const stopsOn = body.autoRenew ? null : fresh?.endDate ?? null;

  const actor = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { firstName: true, lastName: true },
  });
  const actorName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : "A family member";
  const athlete = person.isSelf ? "their own" : `${person.firstName} ${person.lastName}'s`.trim();

  await recordSubscriptionEvent({
    clubId,
    memberSubscriptionId: sub.id,
    memberId: sub.memberId,
    kind: SUBSCRIPTION_EVENT_KIND.RENEWAL_CHANGED,
    actorUserId: session.user.id,
    source,
    detail: {
      route: "member/subscriptions/auto-renew",
      autoRenew: body.autoRenew,
      stopsOn: stopsOn?.toISOString() ?? null,
      billing: before.billing,
      sentence: after.copy.currentSentence,
    },
  });

  // Tell the club, the way other member self-service changes do (a message to
  // the owner's inbox). Never blocks the change.
  const ownerId = await clubOwnerUserId(clubId);
  if (ownerId && ownerId !== session.user.id) {
    const plan = before.plan;
    const text = body.autoRenew
      ? `${actorName} turned auto-renew ON for ${athlete} membership (${plan}). ${after.copy.onSentence}`
      : `${actorName} turned auto-renew OFF for ${athlete} membership (${plan}). It ends ${stopsOn ? dayLabel(stopsOn) : "at the end of the paid period"}${after.copy.commitmentEndsOn ? ", after the commitment" : ""}; nothing is charged after that.`;
    await prisma.message
      .create({ data: { clubId, senderId: session.user.id, recipientId: ownerId, body: text, subjectMemberId: sub.memberId } })
      .catch(() => {});
  }

  return NextResponse.json({
    ok: true,
    autoRenew: body.autoRenew,
    stopsOn: stopsOn?.toISOString() ?? null,
    // The preview sentence names the commitment ("after your 3-month
    // commitment"); use it when Stripe stopped on the date it promised.
    message: body.autoRenew
      ? after.copy.onSentence
      : before.copy.stopsOn && stopsOn && before.copy.stopsOn.slice(0, 10) === stopsOn.toISOString().slice(0, 10)
        ? before.copy.offSentence
        : after.copy.offSentence,
  });
}
