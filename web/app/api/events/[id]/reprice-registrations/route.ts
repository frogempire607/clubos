import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/apiGuard";
import { writeBillingAudit } from "@/lib/billingAudit";
import { planReprice } from "@/lib/eventRepricing";

// GET  /api/events/[id]/reprice-registrations  → preview only, never writes
// POST /api/events/[id]/reprice-registrations  → apply the preview
//
// "Change the price on an event and have every non-paid registration follow"
// as an EXPLICIT, previewable action. The preview is the screen the owner
// reads before any invoice goes out: every registrant, what they're carrying
// now, what they'd be charged after, and who is untouchable because their
// money is already committed.
//
// Nothing here talks to Stripe and nothing here emails anyone. Repricing a row
// changes what a future invoice would say — it never charges, refunds, or
// re-sends.

const bodySchema = z.object({
  // Explicit opt-in. A bare POST previews rather than writes.
  apply: z.boolean().optional().default(false),
  // Limit the reprice to these registrations; omitted = every repriceable row.
  registrationIds: z.array(z.string()).optional(),
});

async function loadPlan(eventId: string, clubId: string) {
  const event = await prisma.event.findFirst({
    where: { id: eventId, clubId, deletedAt: null },
  });
  if (!event) return null;
  const registrations = await prisma.eventRegistration.findMany({
    where: { eventId, status: { not: "CANCELED" } },
    orderBy: { createdAt: "asc" },
  });
  return { event, registrations, plan: planReprice(event, registrations) };
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "events", "view");
  if (denied) return denied;

  const loaded = await loadPlan(params.id, session.user.clubId);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ preview: true, ...loaded.plan });
}

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Rewriting what a family will be billed is a money decision, even though no
  // charge happens here.
  const denied = requirePermission(session, "events", "edit");
  if (denied) return denied;

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    throw err;
  }

  const loaded = await loadPlan(params.id, session.user.clubId);
  if (!loaded) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { event, plan } = loaded;

  if (!body.apply) return NextResponse.json({ preview: true, ...plan });

  let targets = plan.changed;
  if (body.registrationIds && body.registrationIds.length > 0) {
    const ids = new Set(body.registrationIds);
    targets = targets.filter((r) => ids.has(r.id));
  }

  if (targets.length === 0) {
    return NextResponse.json({
      ok: true,
      updated: 0,
      message: "Every registration already matches the event's current pricing.",
      ...plan,
    });
  }

  // One update per row — the new amount is per-registration, and each write is
  // guarded on the row still being repriceable so a payment landing mid-run
  // can't be overwritten.
  let updated = 0;
  for (const row of targets) {
    const res = await prisma.eventRegistration.updateMany({
      where: {
        id: row.id,
        clubId: session.user.clubId,
        status: { notIn: ["PAID", "SCHEDULED", "CANCELED", "AWAITING_CASH", "AWAITING_CHECK"] },
        transactionId: null,
      },
      data: { amountDue: row.expected > 0 ? row.expected : null },
    });
    updated += res.count;
  }

  await writeBillingAudit({
    clubId: session.user.clubId,
    memberId: null,
    actorUserId: session.user.id ?? null,
    action: "EVENT_REGISTRATIONS_REPRICED",
    before: { eventId: event.id, rows: targets.map((r) => ({ id: r.id, name: r.name, amountDue: r.current })) },
    after: {
      eventId: event.id,
      variable: plan.variable,
      perHead: plan.perHead,
      fixedPrice: plan.fixedPrice,
      rows: targets.map((r) => ({ id: r.id, name: r.name, amountDue: r.expected })),
    },
    note: `Repriced ${updated} registration(s) for ${event.name}. No money moved.`,
  });

  const after = await loadPlan(params.id, session.user.clubId);
  return NextResponse.json({ ok: true, updated, ...(after?.plan ?? plan) });
}
