import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requirePermission } from "@/lib/apiGuard";
import { prisma } from "@/lib/prisma";
import { GUARDIAN_LINK_KIND } from "@/lib/guardianLink";

// Owner-side review of guardian-link requests for a single member.
//
//   GET  → list PENDING guardian-link requests for this member (with the
//          requesting user's name/email so the owner knows who's asking).
//   POST → APPROVE (creates the MemberGuardianUser access link) or DECLINE.
//
// This is the ONLY place a queued guardian link becomes real access. The
// member-facing link-child / signup routes never grant access on their own
// unless the owner already vouched (see lib/guardianLink.ts).

type Payload = {
  requestingUserId?: string;
  requestingUserEmail?: string | null;
  relationship?: string | null;
};

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "members", "view"); // owner or members:view staff
  if (denied) return denied;

  const rows = await prisma.pendingApproval.findMany({
    where: {
      clubId: session!.user.clubId,
      memberId: id,
      kind: GUARDIAN_LINK_KIND,
      status: "PENDING",
    },
    orderBy: { requestedAt: "desc" },
    select: { id: true, payload: true, requestedAt: true },
  });

  // Enrich with the requesting user's identity for the owner UI.
  const userIds = Array.from(
    new Set(rows.map((r) => (r.payload as Payload | null)?.requestingUserId).filter(Boolean) as string[]),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));

  return NextResponse.json({
    requests: rows.map((r) => {
      const p = (r.payload as Payload | null) ?? {};
      const u = p.requestingUserId ? byId.get(p.requestingUserId) : undefined;
      return {
        id: r.id,
        requestedAt: r.requestedAt,
        relationship: p.relationship ?? null,
        requestingUser: u
          ? { id: u.id, firstName: u.firstName, lastName: u.lastName, email: u.email }
          : { id: p.requestingUserId ?? null, email: p.requestingUserEmail ?? null },
      };
    }),
  });
}

const schema = z.object({
  approvalId: z.string().min(1),
  decision: z.enum(["APPROVE", "DECLINE"]),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const session = await getServerSession(authOptions);
  const denied = requirePermission(session, "members", "edit"); // owner or members:edit staff
  if (denied) return denied;

  let approvalId: string;
  let decision: "APPROVE" | "DECLINE";
  try {
    ({ approvalId, decision } = schema.parse(await req.json()));
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }

  // Scope the approval to THIS club + THIS member — blocks cross-tenant /
  // cross-member approval by a guessed id.
  const approval = await prisma.pendingApproval.findFirst({
    where: {
      id: approvalId,
      clubId: session!.user.clubId,
      memberId: id,
      kind: GUARDIAN_LINK_KIND,
      status: "PENDING",
    },
    select: { id: true, payload: true },
  });
  if (!approval) {
    return NextResponse.json({ error: "Request not found." }, { status: 404 });
  }

  const payload = (approval.payload as Payload | null) ?? {};
  if (!payload.requestingUserId) {
    // Malformed row — resolve it so it stops showing, but grant nothing.
    await prisma.pendingApproval.update({
      where: { id: approval.id },
      data: { status: "DECLINED", respondedAt: new Date(), respondedById: session!.user.id },
    });
    return NextResponse.json({ error: "Request was malformed and has been dismissed." }, { status: 409 });
  }

  if (decision === "APPROVE") {
    await prisma.$transaction([
      prisma.memberGuardianUser.upsert({
        where: { userId_memberId: { userId: payload.requestingUserId, memberId: id } },
        update: { relationship: payload.relationship ?? null },
        create: { userId: payload.requestingUserId, memberId: id, relationship: payload.relationship ?? null },
      }),
      prisma.pendingApproval.update({
        where: { id: approval.id },
        data: { status: "APPROVED", respondedAt: new Date(), respondedById: session!.user.id },
      }),
    ]);
    return NextResponse.json({ ok: true, approved: true });
  }

  await prisma.pendingApproval.update({
    where: { id: approval.id },
    data: { status: "DECLINED", respondedAt: new Date(), respondedById: session!.user.id },
  });
  return NextResponse.json({ ok: true, approved: false });
}
