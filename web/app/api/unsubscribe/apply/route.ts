// POST /api/unsubscribe/apply?c=…&e=…&t=…
//   body: application/x-www-form-urlencoded, scope=MARKETING|ALL|SUBSCRIBE
//
// The public unsubscribe panel POSTs here. Same token guard as
// /api/unsubscribe so a random browser can't apply a scope for someone
// else. Renders a small confirmation page with a link back to the
// panel — mail clients that preview forms won't render this route
// (no GET handler) so it can't be triggered by scanners.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { writeOptOutAudit } from "@/lib/optOutAudit";

type Scope = "MARKETING" | "ALL";

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function confirmationPage(title: string, body: string, backLink: string | null): NextResponse {
  const back = backLink
    ? `<p style="margin-top:24px"><a href="${escape(backLink)}" style="color:#78716c;text-decoration:underline">Change preferences again</a></p>`
    : "";
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title></head>
<body style="font-family:-apple-system,sans-serif;background:#fafaf9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">
<div style="background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:40px;max-width:440px;text-align:center">
<h1 style="font-size:20px;color:#1c1917;margin:0 0 12px">${escape(title)}</h1>
<p style="font-size:14px;color:#57534e;line-height:1.6;margin:0">${body}</p>${back}
</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function POST(req: Request) {
  const url = new URL(req.url);
  const clubId = url.searchParams.get("c") || "";
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";
  if (!clubId || !email || !token || !verifyUnsubscribeToken(clubId, email, token)) {
    return confirmationPage("Link not valid", "Please use the link from a recent email.", null);
  }

  const form = await req.formData();
  const rawScope = String(form.get("scope") || "MARKETING").toUpperCase();
  const scope: Scope | "SUBSCRIBE" = rawScope === "ALL" ? "ALL" : rawScope === "SUBSCRIBE" ? "SUBSCRIBE" : "MARKETING";

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
  if (!club) return confirmationPage("Link not valid", "This club no longer exists.", null);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") || undefined;
  const ua = req.headers.get("user-agent") ?? undefined;
  const context = { ip, userAgent: ua };

  const user = await prisma.user.findFirst({
    where: { clubId, email, deletedAt: null },
    select: { id: true },
  });

  const existing = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId, email } },
    select: { scope: true, userId: true },
  });

  const backLink = `/api/unsubscribe?c=${encodeURIComponent(clubId)}&e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;

  if (scope === "SUBSCRIBE") {
    if (!existing) return confirmationPage("You're subscribed", `You'll receive email from ${escape(club.name)} — including marketing.`, backLink);
    await prisma.emailOptOut.delete({ where: { clubId_email: { clubId, email } } });
    await writeOptOutAudit({
      clubId, email, userId: existing.userId,
      scope: "MARKETING", action: "SUBSCRIBE", source: "UNSUBSCRIBE_LINK",
      actorUserId: null, actorRole: "ANONYMOUS", context,
    });
    return confirmationPage("You're resubscribed", `You'll receive email from ${escape(club.name)} again — including marketing.`, backLink);
  }

  await prisma.emailOptOut.upsert({
    where: { clubId_email: { clubId, email } },
    create: { clubId, email, userId: user?.id ?? null, scope, source: "UNSUBSCRIBE_LINK" },
    update: { scope, source: "UNSUBSCRIBE_LINK", updatedAt: new Date() },
  });

  if (!existing || existing.scope !== scope) {
    await writeOptOutAudit({
      clubId, email, userId: user?.id ?? existing?.userId ?? null,
      scope, action: "UNSUBSCRIBE", source: "UNSUBSCRIBE_LINK",
      actorUserId: null, actorRole: "ANONYMOUS", context,
    });
  }

  const title = scope === "ALL" ? "Unsubscribed from all non-essential email" : "Unsubscribed from marketing";
  const body =
    scope === "ALL"
      ? `You will only receive receipts, password resets, and account-security notices from ${escape(club.name)}.`
      : `You will not receive newsletters or promotional email from ${escape(club.name)}. Receipts and account emails still come through.`;
  return confirmationPage(title, body, backLink);
}
