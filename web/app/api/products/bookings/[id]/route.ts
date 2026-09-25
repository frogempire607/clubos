import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermissionLive } from "@/lib/apiGuard";
import { staffBookingAction } from "@/lib/productBookingServer";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("approve") }),
  z.object({ action: z.literal("decline"), reason: z.string().max(500).optional().nullable(), refund: z.boolean().optional() }),
  z.object({ action: z.literal("cancel"), refund: z.boolean().optional() }),
  z.object({ action: z.literal("record_payment"), amount: z.number().positive() }),
]);

// POST /api/products/bookings/[id] — approve · decline · cancel · take the
// balance in cash. A refund happens only when the owner ticks it.
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = await requirePermissionLive(session, "events", "edit");
  if (denied) return denied;
  try {
    const act = schema.parse(await req.json());
    if ((act.action === "decline" || act.action === "cancel") && act.refund) {
      const money = await requirePermissionLive(session, "finances", "edit");
      if (money) return money;
    }
    const res = await staffBookingAction({ clubId: session.user.clubId, bookingId: id, actorUserId: session.user.id ?? null, act });
    if (!res.ok) return NextResponse.json({ error: res.message }, { status: res.status });
    return NextResponse.json({ ok: true, message: res.message });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
