import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { rateLimit, rateLimitedResponse } from "@/lib/ratelimit";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { memberCanMessage } from "@/lib/parentalControls";
import { findOrAutoLinkMember } from "@/lib/memberLink";

const MESSAGING_DISABLED = {
  error:
    "Messaging is managed by your guardian on this account. Ask them if you need to send a message.",
  code: "MESSAGING_DISABLED",
};

// Resolve the viewer's own member id + the children they guardian, so we can
// validate/scope the `about` (subject) of a thread.
async function resolveSubjects(userId: string, clubId: string, email: string | null) {
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      memberProfile: { select: { id: true } },
      guardianOf: { select: { member: { select: { id: true, firstName: true, lastName: true } } } },
    },
  });
  let selfMemberId = me?.memberProfile?.id ?? null;
  if (!selfMemberId && email) {
    const linked = await findOrAutoLinkMember(userId, clubId, email);
    selfMemberId = linked?.id ?? null;
  }
  const children = new Map<string, { id: string; firstName: string; lastName: string }>();
  for (const g of me?.guardianOf ?? []) children.set(g.member.id, g.member);
  return { selfMemberId, children };
}

// Build the subject filter: a specific child, or "self" (null / own id).
function subjectWhere(about: string | null, selfMemberId: string | null, isChild: boolean) {
  if (about && isChild) return { subjectMemberId: about };
  return {
    OR: [{ subjectMemberId: null }, ...(selfMemberId ? [{ subjectMemberId: selfMemberId }] : [])],
  };
}

// GET /api/member/messages/dm/[userId]?about=<memberId>
export async function GET(req: Request, context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  const other = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, role: true },
  });
  if (!other) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const about = new URL(req.url).searchParams.get("about");
  const { selfMemberId, children } = await resolveSubjects(
    session.user.id,
    session.user.clubId,
    session.user.email ?? null,
  );
  const isChild = !!about && children.has(about) && about !== selfMemberId;
  if (about && !isChild && about !== selfMemberId) {
    return NextResponse.json({ error: "You can't view that athlete's messages." }, { status: 403 });
  }
  const subj = subjectWhere(about, selfMemberId, isChild);

  const where = {
    clubId: session.user.clubId,
    AND: [
      {
        OR: [
          { senderId: session.user.id, recipientId: params.userId },
          { senderId: params.userId, recipientId: session.user.id },
        ],
      },
      subj,
    ],
  } as Prisma.MessageWhereInput;

  const messages = await prisma.message.findMany({
    where,
    include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: "asc" },
  });

  await prisma.message.updateMany({
    where: {
      clubId: session.user.clubId,
      AND: [{ senderId: params.userId, recipientId: session.user.id, readAt: null }, subj],
    } as Prisma.MessageWhereInput,
    data: { readAt: new Date() },
  });

  const forMember = isChild ? children.get(about!) ?? null : null;
  // no-store: this GET is also the mark-read write. iOS WebKit (Capacitor
  // shell) caches GET fetches without this, so on mobile the server never ran
  // the updateMany above and threads stayed unread.
  return NextResponse.json(
    { other, messages, forMember, about: about ?? null },
    { headers: { "Cache-Control": "no-store" } },
  );
}

const sendSchema = z.object({ body: z.string().min(1), about: z.string().optional().nullable() });

// POST /api/member/messages/dm/[userId]
// Members may DM staff/owners freely (and start the thread). Member-to-member
// still requires an existing thread. The optional `about` tags the thread with
// a child the viewer guardians (or their own profile).
export async function POST(req: Request, context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!(await memberCanMessage(session.user.id, session.user.clubId))) {
    return NextResponse.json(MESSAGING_DISABLED, { status: 403 });
  }

  const rl = rateLimit({ key: `messages:dm:${session.user.id}`, limit: 60, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitedResponse(rl, "You're messaging too quickly. Slow down and try again in a moment.");

  const other = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, role: true },
  });
  if (!other) return NextResponse.json({ error: "Recipient not found" }, { status: 404 });

  if (other.role === "MEMBER") {
    const existing = await prisma.message.findFirst({
      where: { clubId: session.user.clubId, senderId: params.userId, recipientId: session.user.id },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json(
        { error: "You can only reply to existing conversations with other members." },
        { status: 403 },
      );
    }
  }

  try {
    const { body, about } = sendSchema.parse(await req.json());
    const { selfMemberId, children } = await resolveSubjects(
      session.user.id,
      session.user.clubId,
      session.user.email ?? null,
    );
    // Tag with the child only if the viewer guardians them; otherwise it's a
    // self thread (stored null).
    const subjectMemberId = about && children.has(about) && about !== selfMemberId ? about : null;

    const message = await prisma.message.create({
      data: {
        clubId: session.user.clubId,
        senderId: session.user.id,
        recipientId: params.userId,
        body,
        subjectMemberId,
      } as Prisma.MessageUncheckedCreateInput,
      include: { sender: { select: { id: true, firstName: true, lastName: true } } },
    });
    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors }, { status: 400 });
    console.error(err);
    return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
