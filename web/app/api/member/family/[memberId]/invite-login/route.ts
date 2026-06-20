import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { inviteChildLogin } from "@/lib/childLogin";

// Confirm the signed-in user is the guardian of `memberId` and load the fields
// the child-login flow needs. Mirrors /controls' loadGuardianChild gate.
async function loadGuardianChild(userId: string, memberId: string, clubId: string) {
  const link = await prisma.memberGuardianUser.findFirst({
    where: { userId, memberId, member: { clubId, deletedAt: null } },
    select: {
      member: {
        select: {
          id: true, clubId: true, firstName: true, lastName: true,
          isMinor: true, userId: true, guardianEmail: true, email: true,
        },
      },
    },
  });
  return link?.member ?? null;
}

const schema = z.object({
  email: z.string().email(),
  requirePaymentApproval: z.boolean().optional(),
  allowOwnMessaging: z.boolean().optional(),
  allowPackagePurchase: z.boolean().optional(),
});

// POST /api/member/family/[memberId]/invite-login
// Guardian gives a linked child their own portal login (optional). The guardian
// keeps the guardian link + billing; parentControls govern what the child can do.
export async function POST(req: Request, context: { params: Promise<{ memberId: string }> }) {
  const { memberId } = await context.params;
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const child = await loadGuardianChild(session.user.id, memberId, session.user.clubId);
  if (!child) return NextResponse.json({ error: "Not a linked child" }, { status: 403 });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) return NextResponse.json({ error: err.errors[0].message }, { status: 400 });
    throw err;
  }

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: { name: true, slug: true },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  const result = await inviteChildLogin({
    member: child,
    childEmail: body.email,
    controls: {
      requirePaymentApproval: body.requirePaymentApproval,
      allowOwnMessaging: body.allowOwnMessaging,
      allowPackagePurchase: body.allowPackagePurchase,
    },
    club,
    actorUserId: session.user.id,
  });

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    resent: result.resent,
    message: result.resent
      ? `Re-sent the login setup email to ${body.email}.`
      : `Sent ${child.firstName} a login setup email at ${body.email}.`,
  });
}
