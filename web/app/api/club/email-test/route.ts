import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendEmail, isEmailConfigured, smtpMissingVars } from "@/lib/email";

const bodySchema = z.object({
  to: z.string().email().optional(),
});

// POST /api/club/email-test
// Owner-only. Sends a one-off email to either the supplied address or the
// owner's own login email so they can confirm their SMTP env vars work
// without firing a real invite/announcement. Returns:
//   { ok: true } on success
//   { ok: false, error } on failure (env missing, transport error, …)
export async function POST(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "OWNER") {
    return NextResponse.json({ error: "Owner access required" }, { status: 403 });
  }

  if (!isEmailConfigured()) {
    return NextResponse.json(
      { ok: false, error: `SMTP isn't configured. Missing: ${smtpMissingVars().join(", ")}` },
      { status: 400 },
    );
  }

  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await req.json().catch(() => ({})));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ ok: false, error: err.errors[0].message }, { status: 400 });
    }
    return NextResponse.json({ ok: false, error: "Bad request" }, { status: 400 });
  }
  const owner = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, firstName: true },
  });
  const to = body.to || owner?.email;
  if (!to) return NextResponse.json({ ok: false, error: "No recipient" }, { status: 400 });

  try {
    await sendEmail({
      to,
      subject: "AthletixOS email test",
      html: `<p>Hi ${owner?.firstName ?? "there"},</p>
             <p>This is a test email from AthletixOS. If you're reading it, your SMTP
             settings are working and staff invites, password resets, and announcement
             emails will deliver normally.</p>
             <p style="color:#777;font-size:12px">Sent at ${new Date().toISOString()}</p>`,
    });
    return NextResponse.json({ ok: true, to });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Email test failed:", err);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
