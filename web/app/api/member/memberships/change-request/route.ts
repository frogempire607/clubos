import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { MEMBERSHIP_CHANGE_KIND } from "@/lib/approvals";
import { parseOptions } from "@/lib/membershipOptions";

// POST /api/member/memberships/change-request
//
// "I want a different membership" — routed to the club, not executed.
//
// An active subscription used to be a dead end in the portal: the memberships
// page replaced every option with a green "this is your current plan" box whose
// only suggestion was to cancel. A parent who believed their membership had
// lapsed could neither buy nor ask, and the club never learned they wanted to.
//
// Deliberately a REQUEST. Moving a live membership can mean a proration, a
// mid-commitment switch, or a Stripe billing interval that must not be edited
// in place — decisions belonging to whoever carries the money, not to a form.
// What the portal owes the family is a way to be heard, which is this.
//
// It does NOT refuse inside a commitment. Being committed is the most likely
// reason to need a conversation, and a portal that goes quiet exactly then is
// the behaviour being fixed.
const schema = z.object({
  memberId: z.string().min(1),
  membershipId: z.string().min(1),
  optionId: z.string().min(1).optional().nullable(),
  optionLabel: z.string().min(1).max(200),
  note: z.string().max(1000).optional().nullable(),
});

export async function POST(req: Request) {
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

  // Self, or a linked guardian. Same proof of access as every other member-side
  // action on somebody else's row.
  const member = await prisma.member.findFirst({
    where: { id: body.memberId, clubId, deletedAt: null },
    select: { id: true, userId: true, firstName: true, lastName: true },
  });
  if (!member) return NextResponse.json({ error: "Athlete not found." }, { status: 404 });
  if (member.userId !== session.user.id) {
    const link = await prisma.memberGuardianUser.findUnique({
      where: { userId_memberId: { userId: session.user.id, memberId: member.id } },
      select: { userId: true },
    });
    if (!link) return NextResponse.json({ error: "You don't manage this athlete." }, { status: 403 });
  }

  // The requested plan must be one the club is actually selling.
  const plan = await prisma.membership.findFirst({
    where: { id: body.membershipId, clubId, deletedAt: null, active: true },
    select: { id: true, name: true, options: true },
  });
  if (!plan) return NextResponse.json({ error: "That membership is no longer available." }, { status: 404 });

  // Resolve the option against the plan rather than trusting the client's
  // price. Prefer the id; fall back to the label so a request survives the
  // options being edited between page load and submit.
  const options = parseOptions(plan.options);
  const option =
    (body.optionId ? options.find((o) => o.id === body.optionId) : undefined) ??
    options.find((o) => o.label === body.optionLabel);
  if (!option) {
    return NextResponse.json(
      { error: "That option is no longer offered. Reload and pick again." },
      { status: 409 },
    );
  }

  const current = await prisma.memberSubscription.findFirst({
    where: { memberId: member.id, status: { in: ["active", "pending", "past_due"] } },
    orderBy: { createdAt: "desc" },
    select: { id: true, optionLabel: true, price: true, membershipId: true },
  });

  // Asking for the plan and option they are already on is a no-op, not a queue
  // entry — but only when it is genuinely the same option.
  if (current && current.membershipId === plan.id && current.optionLabel === option.label) {
    return NextResponse.json(
      { ok: true, unchanged: true, message: "That's the membership you're already on." },
      { status: 200 },
    );
  }

  const pending = await prisma.pendingApproval.findMany({
    where: { clubId, memberId: member.id, kind: MEMBERSHIP_CHANGE_KIND, status: "PENDING" },
    select: { payload: true },
  });
  const dupe = pending.some((r) => {
    const p = r.payload as { toMembershipId?: string; toOptionLabel?: string } | null;
    return p?.toMembershipId === plan.id && p?.toOptionLabel === option.label;
  });
  if (dupe) {
    return NextResponse.json(
      { ok: true, alreadyRequested: true, message: "Your club already has this request." },
      { status: 200 },
    );
  }

  await prisma.pendingApproval.create({
    data: {
      clubId,
      memberId: member.id,
      kind: MEMBERSHIP_CHANGE_KIND,
      amount: option.price,
      payload: {
        fromSubscriptionId: current?.id ?? null,
        fromOptionLabel: current?.optionLabel ?? null,
        fromPrice: current ? Number(current.price) : null,
        toMembershipId: plan.id,
        toPlanName: plan.name,
        toOptionId: option.id,
        toOptionLabel: option.label,
        toPrice: option.price,
        toBillingPeriod: option.billingPeriod,
        note: body.note?.trim() || null,
        requestingUserId: session.user.id,
      } as Prisma.InputJsonValue,
      status: "PENDING",
    },
  });

  return NextResponse.json(
    {
      ok: true,
      pendingApproval: true,
      message:
        "Sent to your club. Nothing has changed on your membership yet — they'll confirm the details with you.",
    },
    { status: 202 },
  );
}
