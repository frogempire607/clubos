// POST /api/emails/personalization-preview
//
// Given a proposed subject + block body + a set of candidate member IDs,
// returns per-recipient interpolated preview + a global "missing tokens
// by member" report. Powers plan §3F's:
//   - "warn when a personalization field is unavailable for some recipients"
//   - "allow previewing the message as a specific recipient before sending"
//
// Response shape:
//   {
//     referencedTokens: [...],
//     tokenAvailability: { member_first_name: { available: 8, missing: 0 }, ... },
//     samples: [
//       { memberId, memberName, subject, blocks, missingTokens },
//       ...
//     ]
//   }

import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { validateEmailBlocks } from "@/lib/emailBlocks";
import {
  extractTokensFromBlocks,
  interpolateBlocks,
  interpolateString,
  resolveMemberPersonalization,
  PERSONALIZATION_TOKENS,
} from "@/lib/emailPersonalization";

const schema = z.object({
  subject: z.string().max(300).default(""),
  blocks: z.array(z.unknown()).min(1),
  memberIds: z.array(z.string().min(1)).min(1).max(50),
  context: z.object({
    eventName: z.string().nullable().optional(),
    className: z.string().nullable().optional(),
    coachName: z.string().nullable().optional(),
    registrationLink: z.string().nullable().optional(),
    paymentLink: z.string().nullable().optional(),
    overrides: z.record(z.string().nullable()).optional(),
  }).optional(),
});

export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requirePermission(session, "messages", "view");
  if (denied) return denied;

  let data: z.infer<typeof schema>;
  try {
    data = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  const blocksResult = validateEmailBlocks(data.blocks);
  if (!blocksResult.ok) {
    return NextResponse.json({ error: "Invalid blocks", details: blocksResult.errors }, { status: 400 });
  }

  // Collect the tokens the subject + body reference. Subject tokens are
  // deduped into the body set for a single per-member resolution pass.
  const bodyTokens = extractTokensFromBlocks(blocksResult.blocks);
  const subjectTokens = Array.from(new Set(
    Array.from((data.subject).matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)).map((m) => m[1]),
  ));
  const referencedTokens = Array.from(new Set([...bodyTokens, ...subjectTokens]));

  // Load member display names for the sample cards.
  const members = await prisma.member.findMany({
    where: { id: { in: data.memberIds }, clubId: session.user.clubId, deletedAt: null },
    select: { id: true, firstName: true, lastName: true, email: true, isMinor: true },
  });
  const memberById = new Map(members.map((m) => [m.id, m]));

  // Resolve per member.
  const samples: Array<{
    memberId: string;
    memberName: string;
    memberEmail: string | null;
    isMinor: boolean;
    subject: string;
    blocks: unknown[];
    missingTokens: string[];
  }> = [];
  const availability = new Map<string, { available: number; missing: number }>();
  for (const t of referencedTokens) {
    availability.set(t, { available: 0, missing: 0 });
  }

  for (const id of data.memberIds) {
    const m = memberById.get(id);
    if (!m) {
      samples.push({
        memberId: id,
        memberName: id,
        memberEmail: null,
        isMinor: false,
        subject: data.subject,
        blocks: blocksResult.blocks,
        missingTokens: referencedTokens,
      });
      for (const t of referencedTokens) availability.get(t)!.missing++;
      continue;
    }
    const resolved = await resolveMemberPersonalization({
      clubId: session.user.clubId,
      memberId: id,
      referencedTokens,
      context: data.context,
    });
    const rendered = interpolateBlocks(blocksResult.blocks, resolved.values as Record<string, string>);
    const renderedSubject = interpolateString(data.subject, resolved.values as Record<string, string>);
    samples.push({
      memberId: id,
      memberName: `${m.firstName} ${m.lastName}`.trim(),
      memberEmail: m.email,
      isMinor: m.isMinor,
      subject: renderedSubject,
      blocks: rendered,
      missingTokens: resolved.missingTokens,
    });
    for (const t of referencedTokens) {
      if (resolved.missingTokens.includes(t as never)) availability.get(t)!.missing++;
      else availability.get(t)!.available++;
    }
  }

  return NextResponse.json({
    referencedTokens,
    knownTokens: PERSONALIZATION_TOKENS,
    tokenAvailability: Object.fromEntries(availability),
    samples,
  });
}
