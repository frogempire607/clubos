import { NextResponse } from "next/server";
import { z } from "zod";
import { formatZodError } from "@/lib/zodErrors";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { hasPermissionLive, requirePermissionLive } from "@/lib/apiGuard";
import { selfRule, SELF_DENY_MESSAGE } from "@/lib/staffSelf";
import { actorFrom } from "@/lib/staffActivity";
import { recordPayChange } from "@/lib/payLedgerApi";
import { syncPayLines } from "@/lib/payLedgerServer";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// What a coach is paid for a private lesson, per lesson type: a flat amount
// per lesson, or a percentage of what the family paid. Since Branch 3 the pay
// ledger turns each finished private lesson into a pay line from these rates
// (lib/payLedgerServer.ts); a lesson type with no rate becomes a "needs
// review" line — never a guessed amount.
//   GET     finances:view, or the coach themself (read-only)
//   POST    finances:full, never your own pay
//   DELETE  finances:full, never your own pay
// Every handler confirms the staff member (and the lesson type) belong to the
// signed-in club before touching anything.
async function staffInClub(clubId: string, id: string) {
  return prisma.user.findFirst({ where: { id, clubId, role: { in: ["OWNER", "STAFF"] }, deletedAt: null }, select: { id: true } });
}
function rateText(payType: string, payValue: number): string {
  return payType === "PERCENT" ? `${payValue}% of the lesson price` : `$${payValue.toFixed(2)} per lesson`;
}

export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const isSelf = selfRule(session.user.role, session.user.id, params.id, "view_pay") === "allow";
  const denied = isSelf ? null : await requirePermissionLive(session, "finances", "view");
  if (denied) return denied;
  const clubId = session.user.clubId;
  if (!(await staffInClub(clubId, params.id))) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [rates, lessonTypes, canFull] = await Promise.all([
    prisma.privateLessonPayRate.findMany({
      where: { userId: params.id, clubId },
      select: { lessonTypeId: true, payType: true, payValue: true },
    }),
    prisma.privateLessonType.findMany({
      where: { clubId },
      select: { id: true, title: true, basePrice: true, active: true },
      orderBy: { title: "asc" },
    }),
    hasPermissionLive(session, "finances", "full"),
  ]);
  const editSelfDenied = selfRule(session.user.role, session.user.id, params.id, "edit_pay") === "deny";
  return NextResponse.json({
    rates: rates.map((r) => ({ lessonTypeId: r.lessonTypeId, payType: r.payType, payValue: Number(r.payValue) })),
    lessonTypes: lessonTypes.map((t) => ({ id: t.id, title: t.title, basePrice: Number(t.basePrice ?? 0), active: t.active })),
    viewer: { canEdit: canFull && !editSelfDenied },
  });
}

const schema = z.object({
  lessonTypeId: z.string().min(1),
  payType:      z.enum(["FLAT", "PERCENT"]),
  payValue:     z.number().nonnegative().max(100000),
}).strict().refine((d) => d.payType !== "PERCENT" || d.payValue <= 100, { message: "A percentage can't be more than 100." });

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, params.id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  try {
    const data = schema.parse(await req.json());
    const [user, lessonType] = await Promise.all([
      staffInClub(clubId, params.id),
      prisma.privateLessonType.findFirst({ where: { id: data.lessonTypeId, clubId }, select: { id: true, title: true } }),
    ]);
    if (!user || !lessonType) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const before = await prisma.privateLessonPayRate.findFirst({
      where: { clubId, userId: params.id, lessonTypeId: data.lessonTypeId },
      select: { payType: true, payValue: true },
    });
    const rate = await prisma.privateLessonPayRate.upsert({
      where: { userId_lessonTypeId: { userId: params.id, lessonTypeId: data.lessonTypeId } },
      update: { payType: data.payType, payValue: data.payValue },
      create: { clubId, userId: params.id, lessonTypeId: data.lessonTypeId, payType: data.payType, payValue: data.payValue },
      select: { lessonTypeId: true, payType: true, payValue: true },
    });
    await recordPayChange({
      clubId, staffUserId: params.id, ...actorFrom(session), action: "PRIVATE_PAY_RATE_SET",
      summary: `Set private lesson pay for "${lessonType.title}" to ${rateText(data.payType, data.payValue)}`,
      before: before ? { payType: before.payType, payValue: Number(before.payValue) } : null,
      after: { lessonTypeId: data.lessonTypeId, payType: data.payType, payValue: data.payValue },
    });
    // Unpaid lessons this rate now covers get their amount straight away (paid lines never change).
    await syncPayLines(clubId, { userIds: [params.id] }).catch(() => undefined);
    return NextResponse.json({ lessonTypeId: rate.lessonTypeId, payType: rate.payType, payValue: Number(rate.payValue) }, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: formatZodError(err) }, { status: 400 });
    console.error(err); return NextResponse.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (selfRule(session.user.role, session.user.id, params.id, "edit_pay") === "deny") {
    return NextResponse.json({ error: SELF_DENY_MESSAGE.edit_pay }, { status: 403 });
  }
  const denied = await requirePermissionLive(session, "finances", "full");
  if (denied) return denied;
  const clubId = session.user.clubId;

  const { searchParams } = new URL(req.url);
  const lessonTypeId = searchParams.get("lessonTypeId");
  if (!lessonTypeId) return NextResponse.json({ error: "lessonTypeId required" }, { status: 400 });

  const existing = await prisma.privateLessonPayRate.findFirst({
    where: { userId: params.id, lessonTypeId, clubId },
    select: { id: true, payType: true, payValue: true, lessonType: { select: { title: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.privateLessonPayRate.deleteMany({ where: { id: existing.id, clubId } });
  await recordPayChange({
    clubId, staffUserId: params.id, ...actorFrom(session), action: "PRIVATE_PAY_RATE_REMOVED",
    summary: `Removed private lesson pay for "${existing.lessonType.title}"`,
    before: { lessonTypeId, payType: existing.payType, payValue: Number(existing.payValue) },
  });
  await syncPayLines(clubId, { userIds: [params.id] }).catch(() => undefined);
  return new NextResponse(null, { status: 204 });
}
