import { NextResponse } from "next/server";
import { z } from "zod";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { requireOwner } from "@/lib/apiGuard";
import { isEmailConfigured, smtpMissingVars } from "@/lib/email";

// GET /api/club/email-settings — owner-only.
// Tells the owner whether outgoing email is actually connected and lets them
// set the friendly "From" name + reply-to address members will see.
export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  const club = await prisma.club.findUnique({
    where: { id: session.user.clubId },
    select: {
      name: true,
      contactEmail: true,
      emailFromName: true,
      emailReplyTo: true,
    },
  });
  if (!club) return NextResponse.json({ error: "Club not found" }, { status: 404 });

  return NextResponse.json({
    configured: isEmailConfigured(),
    missingVars: smtpMissingVars(),
    sendingAddress: process.env.EMAIL_FROM || "AthletixOS <no-reply@athletix-os.com>",
    fromName: club.emailFromName || club.name,
    replyTo: club.emailReplyTo || club.contactEmail || "",
    defaultFromName: club.name,
  });
}

const schema = z.object({
  fromName: z.string().max(60).optional().nullable(),
  replyTo: z
    .string()
    .email("Enter a valid reply-to email")
    .optional()
    .nullable()
    .or(z.literal("")),
});

export async function PATCH(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const denied = requireOwner(session);
  if (denied) return denied;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.errors[0]?.message || "Invalid input" }, { status: 400 });
    }
    throw err;
  }

  await prisma.club.update({
    where: { id: session.user.clubId },
    data: {
      emailFromName: body.fromName?.trim() || null,
      emailReplyTo: body.replyTo?.trim() || null,
    },
  });

  return NextResponse.json({ ok: true });
}
