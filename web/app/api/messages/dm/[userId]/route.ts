import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const messages = await prisma.message.findMany({
    where: {
      clubId: session.user.clubId,
      OR: [
        { senderId: session.user.id, recipientId: params.userId },
        { senderId: params.userId, recipientId: session.user.id },
      ],
    },
    include: {
      sender: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // Mark incoming messages as read
  await prisma.message.updateMany({
    where: {
      clubId: session.user.clubId,
      senderId: params.userId,
      recipientId: session.user.id,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  return NextResponse.json(messages);
}

const sendSchema = z.object({ body: z.string().min(1) });

/**
 * Find the User accounts that should be looped in when DMing a member.
 * - When the recipient User is linked to a minor Member, return guardian User IDs:
 *   1. Guardian.userId (the guardian's own portal account, if linked)
 *   2. MemberGuardianUser.userId (any extra parent accounts that explicitly claimed this child)
 */
async function getCcUserIdsForMinor(recipientUserId: string, clubId: string): Promise<string[]> {
  const recipient = await prisma.user.findFirst({
    where: { id: recipientUserId, clubId, deletedAt: null },
    include: { memberProfile: { include: { guardian: true } } },
  });
  if (!recipient?.memberProfile?.isMinor) return [];

  const ccIds = new Set<string>();
  if (recipient.memberProfile.guardian?.userId) {
    ccIds.add(recipient.memberProfile.guardian.userId);
  }

  const links = await prisma.memberGuardianUser.findMany({
    where: { memberId: recipient.memberProfile.id },
    select: { userId: true },
  });
  for (const l of links) ccIds.add(l.userId);

  // Don't duplicate the recipient or sender on the cc.
  ccIds.delete(recipientUserId);
  return [...ccIds];
}

export async function POST(
  req: Request,
  { params }: { params: { userId: string } }
) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const recipient = await prisma.user.findFirst({
    where: { id: params.userId, clubId: session.user.clubId, deletedAt: null },
    include: { memberProfile: { include: { guardian: true } } },
  });
  if (!recipient) return NextResponse.json({ error: "User not found" }, { status: 404 });

  try {
    const { body } = sendSchema.parse(await req.json());

    const isMinor = !!recipient.memberProfile?.isMinor;
    const ccUserIds = isMinor
      ? await getCcUserIdsForMinor(recipient.id, session.user.clubId)
      : [];

    // Spec: never message a minor without guardian visibility. If the minor has
    // no linked guardian portal account at all, refuse — it's the staff member's
    // cue to add a guardian first.
    if (isMinor && ccUserIds.length === 0 && recipient.id !== session.user.id) {
      return NextResponse.json(
        {
          error:
            "This member is a minor and no guardian account is linked yet. Add a guardian portal account before sending a direct message.",
          code: "MINOR_GUARDIAN_REQUIRED",
        },
        { status: 400 },
      );
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

    // Mirror to each guardian User account (skipping the sender themselves).
    for (const ccId of ccUserIds) {
      if (ccId === session.user.id) continue;
      await prisma.message.create({
        data: {
          clubId: session.user.clubId,
          senderId: session.user.id,
          recipientId: ccId,
          body,
        },
      });
    }

    return NextResponse.json(message, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors }, { status: 400 });
    }
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
