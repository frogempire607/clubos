import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendMemberMessage } from "@/lib/memberMessaging";

export async function GET(
  req: Request,
  context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Scope to a single thread: a specific athlete ("about") or the self thread
  // (no subject). Mirrors the member portal so a parent↔coach thread about a
  // kid stays separate from the parent's own thread.
  const about = new URL(req.url).searchParams.get("about");
  const subj = (about
    ? { subjectMemberId: about }
    : { subjectMemberId: null }) as Prisma.MessageWhereInput;

  const messages = await prisma.message.findMany({
    where: {
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
    } as Prisma.MessageWhereInput,
    include: {
      sender: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Mark incoming messages as read (scoped to this subject)
  await prisma.message.updateMany({
    where: {
      clubId: session.user.clubId,
      AND: [
        { senderId: params.userId, recipientId: session.user.id, readAt: null },
        subj,
      ],
    } as Prisma.MessageWhereInput,
    data: { readAt: new Date() },
  });

  return NextResponse.json(messages);
}

const sendSchema = z.object({ body: z.string().min(1), about: z.string().optional().nullable() });

export async function POST(
  req: Request,
  context: { params: Promise<{ userId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const recipient = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    include: { memberProfile: { include: { guardian: true } } },
  });
  if (!recipient) return NextResponse.json({ error: "User not found" }, { status: 404 });

  try {
    const { body, about } = sendSchema.parse(await req.json());

    // Reply on a child-subject thread: message the same participant, tagged
    // about that athlete, so the "For {child}" thread stays coherent.
    if (about) {
      const subjMember = await prisma.member.findFirst({
        where: { id: about, clubId: session.user.clubId, deletedAt: null },
        select: { id: true },
      });
      if (!subjMember) {
        return NextResponse.json({ error: "Unknown athlete for this thread." }, { status: 400 });
      }
      const message = await prisma.message.create({
        data: {
          clubId: session.user.clubId,
          senderId: session.user.id,
          recipientId: params.userId,
          body,
          subjectMemberId: about,
        } as Prisma.MessageUncheckedCreateInput,
        include: { sender: { select: { id: true, firstName: true, lastName: true } } },
      });
      return NextResponse.json(message, { status: 201 });
    }

    if (recipient.memberProfile) {
      const result = await sendMemberMessage({
        clubId: session.user.clubId,
        senderId: session.user.id,
        memberId: recipient.memberProfile.id,
        body,
      });

      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }

      return NextResponse.json(result.messages[0], { status: 201 });
    }

    const message = await prisma.message.create({
      data: {
        clubId: session.user.clubId,
        senderId: session.user.id,
        recipientId: params.userId,
        body,
      },
      include: {
        sender: { select: { id: true, firstName: true, lastName: true } },
      },
    });

    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
