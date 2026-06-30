import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getTierFeatures } from "@/lib/tier";
import { sendMemberMessage } from "@/lib/memberMessaging";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";

// Read subjectMemberId off a message row without depending on the cached Prisma
// type (the column is newer than the generated client in some builds).
function subjectOf(m: unknown): string | null {
  return (m as { subjectMemberId?: string | null })?.subjectMemberId ?? null;
}

async function requireGrowth(clubId: string) {
  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { tier: true } });
  const features = getTierFeatures(club?.tier ?? "growth");
  if (!features.directMessaging) {
    return NextResponse.json(
      {
        error: "Direct messaging requires a Growth plan or higher.",
        code: "UPGRADE_REQUIRED",
        upgradeRequired: "growth",
      },
      { status: 403 }
    );
  }
  return null;
}

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  const uid = session.user.id;
  const messages = await prisma.message.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [{ senderId: uid }, { recipientId: uid }],
    },
    include: {
      sender:    { select: { id: true, firstName: true, lastName: true, role: true } },
      recipient: { select: { id: true, firstName: true, lastName: true, role: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  // A message can be "about" a specific athlete (subjectMemberId) — e.g. a
  // parent messaging a coach about their kid. Split conversations by
  // (other party, subject) and resolve the athlete's name, so a parent's
  // message about a child shows as its own "For {child}" thread instead of
  // collapsing behind the parent's own thread (the "message went missing" bug).
  const subjectIds = Array.from(
    new Set(messages.map(subjectOf).filter((s): s is string => !!s)),
  );
  const subjectMembers = subjectIds.length
    ? await prisma.member.findMany({
        where: { id: { in: subjectIds }, clubId: session.user.clubId },
        select: { id: true, firstName: true, lastName: true },
      })
    : [];
  const subjectById = new Map(subjectMembers.map((m) => [m.id, m]));

  const seen = new Set<string>();
  const conversations: any[] = [];
  for (const m of messages) {
    const otherId = m.senderId === uid ? m.recipientId : m.senderId;
    const about = subjectOf(m);
    const key = `${otherId}:${about ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const other = m.senderId === uid ? m.recipient : m.sender;
    const unread = messages.filter(
      (x) =>
        x.senderId === otherId &&
        x.recipientId === uid &&
        !x.readAt &&
        (subjectOf(x) ?? "") === (about ?? ""),
    ).length;
    conversations.push({
      user: other,
      forMember: about ? subjectById.get(about) ?? null : null,
      about: about ?? null,
      lastMessage: m,
      unread,
    });
  }

  return NextResponse.json(conversations);
}

const dmBodySchema = z.object({
  memberId: z.string().min(1, "memberId is required"),
  body: z.string().trim().min(1, "Message body is required.").max(5000, "Message too long (max 5000 chars)."),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || (session.user.role !== "OWNER" && session.user.role !== "STAFF")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Rate limit: 30 messages per minute per sender (owner/staff). Keeps a
  // runaway script from spamming the entire club roster.
  const rl = rateLimit({
    key: `messages:owner-dm:${session.user.id}`,
    limit: 30,
    windowMs: 60_000,
  });
  if (!rl.allowed) return rateLimitedResponse(rl, "Slow down — too many messages sent. Try again in a moment.");

  const gate = await requireGrowth(session.user.clubId);
  if (gate) return gate;

  const raw = await req.json().catch(() => ({}));
  const parsed = dmBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.errors[0]?.message || "Invalid request body." },
      { status: 400 }
    );
  }

  const result = await sendMemberMessage({
    clubId: session.user.clubId,
    senderId: session.user.id,
    memberId: parsed.data.memberId,
    body: parsed.data.body,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  return NextResponse.json(result, { status: 201 });
}
