import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermissionLive } from "@/lib/apiGuard";
import { enrollAlreadyPaid } from "@/lib/enrollPaid";
import { parseOptions } from "@/lib/membershipOptions";

// POST /api/members/[id]/enroll-paid
//
// "This family has already paid me — put them on a membership from here."
//
// billing:full and confirm-gated: it records money as received and can arm a
// recurring card charge, which is every reason the other money routes are
// gated the same way.
const schema = z.object({
  confirm: z.literal(true, { errorMap: () => ({ message: "This action requires explicit confirmation." }) }),
  membershipId: z.string().min(1),
  optionId: z.string().min(1),
  amountReceived: z.number().nonnegative(),
  method: z.enum(["CASH", "CHECK"]),
  reference: z.string().max(120).optional().nullable(),
  /** YYYY-MM-DD — the last day the money covers. */
  coversUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "coversUntil must be YYYY-MM-DD"),
  startCardBilling: z.boolean().default(false),
  note: z.string().max(500).optional().nullable(),
  /**
   * Accept a figure that differs from the option price. Off by default: a
   * mismatch is usually a mis-key, and silently recording the wrong number is
   * how a ledger stops being trusted.
   */
  allowAmountMismatch: z.boolean().default(false),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const clubId = session.user.clubId;
  const coversUntil = new Date(`${body.coversUntil}T00:00:00.000Z`);
  if (Number.isNaN(coversUntil.getTime())) {
    return NextResponse.json({ error: "coversUntil is not a real date." }, { status: 400 });
  }

  // Price check against the option actually sold. A past coversUntil is fine
  // and expected — Dakota Mastrantonio's cash covered a period that ended
  // yesterday — so it is NOT rejected; billing simply resumes immediately.
  const plan = await prisma.membership.findFirst({
    where: { id: body.membershipId, clubId, deletedAt: null },
    select: { options: true, name: true },
  });
  if (!plan) return NextResponse.json({ error: "Membership plan not found." }, { status: 404 });
  const option = parseOptions(plan.options).find((o) => o.id === body.optionId);
  if (!option) return NextResponse.json({ error: "That option is not on the plan." }, { status: 404 });

  if (!body.allowAmountMismatch && Math.abs(body.amountReceived - option.price) > 0.005) {
    return NextResponse.json(
      {
        error:
          `"${option.label}" is $${option.price.toFixed(2)} but $${body.amountReceived.toFixed(2)} was entered. ` +
          `If that is genuinely what they handed over, re-send with allowAmountMismatch.`,
        code: "AMOUNT_MISMATCH",
        expected: option.price,
        received: body.amountReceived,
      },
      { status: 400 },
    );
  }

  const result = await enrollAlreadyPaid({
    memberId: id,
    clubId,
    actorUserId: session.user.id ?? null,
    membershipId: body.membershipId,
    optionId: body.optionId,
    amountReceived: body.amountReceived,
    method: body.method,
    reference: body.reference ?? null,
    coversUntil,
    startCardBilling: body.startCardBilling,
    note: body.note ?? null,
  });

  if (!result.ok) {
    const status = result.code === "LIVE_CARD_BILLING" ? 409 : result.code === "NOT_FOUND" ? 404 : 400;
    return NextResponse.json({ error: result.error, code: result.code }, { status });
  }
  return NextResponse.json(result);
}
