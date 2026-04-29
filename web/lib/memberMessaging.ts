import { prisma } from "@/lib/prisma";

type MemberMessageTarget = {
  recipientIds: string[];
  athleteIncluded: boolean;
  guardianIncluded: boolean;
  missingGuardianReason?: string;
};

export async function getMemberMessageTargets(memberId: string, clubId: string): Promise<MemberMessageTarget | null> {
  const member = await prisma.member.findFirst({
    where: { id: memberId, clubId, deletedAt: null },
    include: {
      user: { select: { id: true } },
      guardian: { select: { userId: true, email: true } },
      guardianLinks: { select: { userId: true } },
    },
  });

  if (!member) return null;

  const ids = new Set<string>();
  let athleteIncluded = false;
  let guardianIncluded = false;

  if (!member.isMinor) {
    if (member.userId) {
      ids.add(member.userId);
      athleteIncluded = true;
    }
    return { recipientIds: [...ids], athleteIncluded, guardianIncluded: false };
  }

  if (member.userId) {
    ids.add(member.userId);
    athleteIncluded = true;
  }

  const guardianIds = new Set<string>();
  if (member.guardian?.userId) guardianIds.add(member.guardian.userId);
  for (const link of member.guardianLinks) guardianIds.add(link.userId);

  const guardianEmail = (member.guardian?.email || member.guardianEmail || "").trim().toLowerCase();
  if (guardianEmail) {
    const guardianUser = await prisma.user.findFirst({
      where: { clubId, email: guardianEmail, deletedAt: null },
      select: { id: true },
    });
    if (guardianUser) guardianIds.add(guardianUser.id);
  }

  for (const id of guardianIds) {
    ids.add(id);
    guardianIncluded = true;
  }

  return {
    recipientIds: [...ids],
    athleteIncluded,
    guardianIncluded,
    missingGuardianReason: guardianIncluded ? undefined : "Minor members need a linked guardian portal account before direct messages can be sent.",
  };
}

export async function sendMemberMessage(params: {
  clubId: string;
  senderId: string;
  memberId: string;
  body: string;
}) {
  const targets = await getMemberMessageTargets(params.memberId, params.clubId);
  if (!targets) {
    return { ok: false as const, status: 404, error: "Member not found" };
  }

  if (targets.recipientIds.length === 0) {
    return {
      ok: false as const,
      status: 400,
      error: targets.missingGuardianReason || "This member does not have a linked portal account for direct messages.",
    };
  }

  if (targets.missingGuardianReason) {
    return { ok: false as const, status: 400, error: targets.missingGuardianReason };
  }

  const uniqueRecipients = targets.recipientIds.filter((id) => id !== params.senderId);
  if (uniqueRecipients.length === 0) {
    return { ok: false as const, status: 400, error: "No eligible recipient account was found for this message." };
  }

  const messages = await prisma.$transaction(
    uniqueRecipients.map((recipientId) =>
      prisma.message.create({
        data: {
          clubId: params.clubId,
          senderId: params.senderId,
          recipientId,
          body: params.body,
        },
        include: { recipient: { select: { id: true, firstName: true, lastName: true, role: true } } },
      })
    )
  );

  return {
    ok: true as const,
    messages,
    sentCount: messages.length,
    athleteIncluded: targets.athleteIncluded,
    guardianIncluded: targets.guardianIncluded,
  };
}
