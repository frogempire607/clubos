import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { getOrCreateEventChat } from "@/lib/eventChat";

// POST /api/events/[id]/chat — owner/staff open (create if needed) the event's
// group chat. Requires messages:send so a staff member who can't message
// members can't spin up threads.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "send");
  if (denied) return denied;

  const result = await getOrCreateEventChat(params.id, session.user.clubId, session.user.id);
  if (!result) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  return NextResponse.json(result);
}
