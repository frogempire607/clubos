import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { invoiceSplitEnabled } from "@/lib/featureFlags";
import { INVOICE_SPLIT_KIND } from "@/lib/approvals";

// Invoice splitting (Client UX Phase 7, behind FEATURE_INVOICE_SPLIT).
//
// Lifecycle: guardian A proposes a % split → the OTHER guardian approves →
// staff give the final OK in the dashboard approvals queue → ACTIVE.
// Either guardian may revoke a non-terminal split. Guardian-only, scoped to
// a child both users are linked to; percentages always sum to 100. Every
// transition appends to the JSON audit trail.

const OPEN_STATUSES = ["PENDING_GUARDIAN", "PENDING_STAFF", "ACTIVE"] as const;

type GuardianLinkRow = {
  userId: string;
  user: { id: string; firstName: string; lastName: string; email: string | null };
};

async function loadContext(userId: string, memberId: string, clubId: string) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      clubId: true,
      firstName: true,
      lastName: true,
      guardianLinks: {
        orderBy: { createdAt: "asc" },
        select: {
          userId: true,
          user: { select: { id: true, firstName: true, lastName: true, email: true } },
        },
      },
    },
  });
  if (!member || member.clubId !== clubId) return null;
  if (!member.guardianLinks.some((l: GuardianLinkRow) => l.userId === userId)) return null;
  return member;
}

function splitView(
  split: {
    id: string;
    status: string;
    proposerUserId: string;
    responderUserId: string;
    proposerPercent: number;
    responderPercent: number;
    note: string | null;
    proposedAt: Date;
    guardianRespondedAt: Date | null;
    staffReviewedAt: Date | null;
  } | null,
  guardians: GuardianLinkRow[],
  viewerId: string,
) {
  if (!split) return null;
  const nameOf = (id: string) => {
    const g = guardians.find((l) => l.userId === id);
    return g ? `${g.user.firstName} ${g.user.lastName}`.trim() : "Former guardian";
  };
  return {
    id: split.id,
    status: split.status,
    proposer: { userId: split.proposerUserId, name: nameOf(split.proposerUserId), percent: split.proposerPercent },
    responder: { userId: split.responderUserId, name: nameOf(split.responderUserId), percent: split.responderPercent },
    note: split.note,
    proposedAt: split.proposedAt,
    guardianRespondedAt: split.guardianRespondedAt,
    staffReviewedAt: split.staffReviewedAt,
    viewerIsProposer: split.proposerUserId === viewerId,
    viewerIsResponder: split.responderUserId === viewerId,
  };
}

function audit(events: unknown, byUserId: string, action: string, note?: string | null) {
  const list = Array.isArray(events) ? [...events] : [];
  list.push({ at: new Date().toISOString(), byUserId, action, ...(note ? { note } : {}) });
  return list as Prisma.InputJsonValue;
}

// GET — current split (if any) + the co-guardian roster for the propose form.
export async function GET(_req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!invoiceSplitEnabled()) return NextResponse.json({ enabled: false });

  const member = await loadContext(session.user.id, params.memberId, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  const split = await prisma.invoiceSplit.findFirst({
    where: { memberId: member.id, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    enabled: true,
    split: splitView(split, member.guardianLinks, session.user.id),
    guardians: member.guardianLinks.map((l: GuardianLinkRow) => ({
      userId: l.userId,
      name: `${l.user.firstName} ${l.user.lastName}`.trim(),
      isYou: l.userId === session.user.id,
    })),
  });
}

const proposeSchema = z.object({
  responderUserId: z.string().min(1),
  proposerPercent: z.number().int().min(1).max(99),
  note: z.string().trim().max(500).nullable().optional(),
});

// POST — propose a split with another guardian of the same child.
export async function POST(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!invoiceSplitEnabled()) return NextResponse.json({ error: "Not available" }, { status: 404 });

  const member = await loadContext(session.user.id, params.memberId, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  let data: z.infer<typeof proposeSchema>;
  try {
    data = proposeSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  if (data.responderUserId === session.user.id) {
    return NextResponse.json({ error: "Pick the other guardian — you can't split with yourself." }, { status: 400 });
  }
  if (!member.guardianLinks.some((l: GuardianLinkRow) => l.userId === data.responderUserId)) {
    return NextResponse.json(
      { error: "That person isn't a guardian of this athlete yet. Invite them as a co-guardian first." },
      { status: 400 },
    );
  }

  const existing = await prisma.invoiceSplit.findFirst({
    where: { memberId: member.id, status: { in: [...OPEN_STATUSES] } },
    select: { id: true, status: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A split already exists for this athlete. Revoke it before proposing a new one." },
      { status: 409 },
    );
  }

  const split = await prisma.invoiceSplit.create({
    data: {
      clubId: session.user.clubId,
      memberId: member.id,
      proposerUserId: session.user.id,
      responderUserId: data.responderUserId,
      proposerPercent: data.proposerPercent,
      responderPercent: 100 - data.proposerPercent,
      note: data.note ?? null,
      status: "PENDING_GUARDIAN",
      events: audit([], session.user.id, "PROPOSED", data.note ?? null),
    },
  });

  return NextResponse.json({
    ok: true,
    split: splitView(split, member.guardianLinks, session.user.id),
    message: "Split proposed — waiting on the other guardian to approve.",
  });
}

const respondSchema = z.object({
  action: z.enum(["APPROVE", "DECLINE", "REVOKE"]),
});

// PATCH — responder approves/declines; either guardian may revoke.
export async function PATCH(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!invoiceSplitEnabled()) return NextResponse.json({ error: "Not available" }, { status: 404 });

  const member = await loadContext(session.user.id, params.memberId, session.user.clubId);
  if (!member) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  let data: z.infer<typeof respondSchema>;
  try {
    data = respondSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const split = await prisma.invoiceSplit.findFirst({
    where: { memberId: member.id, status: { in: [...OPEN_STATUSES] } },
    orderBy: { createdAt: "desc" },
  });
  if (!split) return NextResponse.json({ error: "No split to act on." }, { status: 404 });

  if (data.action === "REVOKE") {
    // Either party can withdraw; a pending staff review is expired with it.
    if (split.proposerUserId !== session.user.id && split.responderUserId !== session.user.id) {
      return NextResponse.json({ error: "Only the two guardians on the split can revoke it." }, { status: 403 });
    }
    const [updated] = await prisma.$transaction([
      prisma.invoiceSplit.update({
        where: { id: split.id },
        data: { status: "REVOKED", events: audit(split.events, session.user.id, "REVOKED") },
      }),
      prisma.pendingApproval.updateMany({
        where: {
          clubId: session.user.clubId,
          kind: INVOICE_SPLIT_KIND,
          status: "PENDING",
          payload: { path: ["splitId"], equals: split.id },
        },
        data: { status: "EXPIRED", respondedAt: new Date(), respondedById: session.user.id },
      }),
    ]);
    return NextResponse.json({
      ok: true,
      split: splitView(updated, member.guardianLinks, session.user.id),
      message: "Split revoked.",
    });
  }

  // APPROVE / DECLINE — only the responder, only while it's their turn.
  if (split.status !== "PENDING_GUARDIAN") {
    return NextResponse.json({ error: "This split isn't waiting on a guardian." }, { status: 409 });
  }
  if (split.responderUserId !== session.user.id) {
    return NextResponse.json({ error: "Only the other guardian can respond to this proposal." }, { status: 403 });
  }

  if (data.action === "DECLINE") {
    const updated = await prisma.invoiceSplit.update({
      where: { id: split.id },
      data: {
        status: "DECLINED",
        guardianRespondedAt: new Date(),
        events: audit(split.events, session.user.id, "DECLINED"),
      },
    });
    return NextResponse.json({
      ok: true,
      split: splitView(updated, member.guardianLinks, session.user.id),
      message: "Proposal declined.",
    });
  }

  const [updated] = await prisma.$transaction([
    prisma.invoiceSplit.update({
      where: { id: split.id },
      data: {
        status: "PENDING_STAFF",
        guardianRespondedAt: new Date(),
        events: audit(split.events, session.user.id, "GUARDIAN_APPROVED"),
      },
    }),
    // File the staff stage in the existing owner approvals queue.
    prisma.pendingApproval.create({
      data: {
        clubId: session.user.clubId,
        memberId: member.id,
        kind: INVOICE_SPLIT_KIND,
        payload: {
          splitId: split.id,
          requestingUserId: split.proposerUserId,
          responderUserId: split.responderUserId,
          proposerPercent: split.proposerPercent,
          responderPercent: split.responderPercent,
        },
      },
    }),
  ]);

  return NextResponse.json({
    ok: true,
    split: splitView(updated, member.guardianLinks, session.user.id),
    message: "Approved — your club reviews it next.",
  });
}
