import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { formatZodError } from "@/lib/zodErrors";
import { requirePermissionLive } from "@/lib/apiGuard";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { refundEventRegistration, refundSheetData } from "@/lib/eventRefundServer";

// Refund one event registration, whether they are still registered or were
// already removed. Owner, or staff with billing:full, checked live.
//
//   GET   what was paid, what has been refunded, what can be, which card
//   POST  { mode: price|all|custom, amountCents?, expectedRefundedCents }
//
// All the rules (how much, once only, what a refusal leaves behind) are in
// lib/eventRefunds.ts and lib/eventRefundServer.ts.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string; regId: string }> };

export async function GET(_req: Request, context: Ctx) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const data = await refundSheetData(session.user.clubId, eventId, regId);
  if (!data) return NextResponse.json({ error: "That registration wasn't found." }, { status: 404 });
  return NextResponse.json(data);
}

const schema = z.object({
  mode: z.enum(["price", "all", "custom"]),
  amountCents: z.number().int().positive().max(10_000_000).nullable().optional(),
  // Required: a tap that doesn't say what it saw can't be told apart from a
  // second tap.
  expectedRefundedCents: z.number().int().min(0),
});

export async function POST(req: Request, context: Ctx) {
  const { id: eventId, regId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Please sign in again." }, { status: 401 });
  const denied = await requirePermissionLive(session, "billing", "full");
  if (denied) return denied;
  const rl = rateLimit({ key: `refund:event:${session.user.id}`, limit: 30, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "Too many refunds at once. Wait a minute and try again.");

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const r = await refundEventRegistration({
    clubId: session.user.clubId,
    eventId,
    registrationId: regId,
    mode: body.mode,
    customCents: body.amountCents ?? null,
    expectedRefundedCents: body.expectedRefundedCents,
    actorUserId: session.user.id ?? null,
    reason: "Refunded from the event's attendees",
    byStaff: true,
  });
  if (!r.ok) return NextResponse.json({ error: r.error, code: r.code }, { status: r.status });
  return NextResponse.json(r);
}
