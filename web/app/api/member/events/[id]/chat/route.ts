import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { memberCanMessage } from "@/lib/parentalControls";
import { getOrCreateEventChat, userCanAccessEventChat, ensureEventChatMember } from "@/lib/eventChat";

// POST /api/member/events/[id]/chat — a registered member (or the guardian of
// a registered child) opens the event's group chat, creating it on first use.
// Non-registered users get a 403; nothing about the chat leaks to them.
export async function POST(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.user.role !== "MEMBER") {
    return NextResponse.json({ error: "Member access only" }, { status: 403 });
  }

  // P4 — guardian-disabled messaging for a controlled minor.
  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(
      { error: "Messaging is managed by your guardian on this account.", code: "MESSAGING_DISABLED" },
      { status: 403 },
    );
  }

  const rl = rateLimit({ key: `event-chat:open:${session.user.id}`, limit: 20, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl);

  const allowed = await userCanAccessEventChat(session.user.id, session.user.clubId, params.id);
  if (!allowed) {
    return NextResponse.json(
      { error: "The event chat is only available to registered attendees." },
      { status: 403 },
    );
  }

  const result = await getOrCreateEventChat(params.id, session.user.clubId, session.user.id);
  if (!result) return NextResponse.json({ error: "Event not found" }, { status: 404 });
  await ensureEventChatMember(result.groupId, session.user.id);
  return NextResponse.json(result);
}
