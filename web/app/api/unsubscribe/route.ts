import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";

// Public unsubscribe endpoint for announcement/broadcast emails.
// GET renders a confirmation page (and performs the opt-out — one click from
// the email footer). POST supports RFC 8058 one-click List-Unsubscribe.
// Transactional email (receipts, activation links, password resets) is not
// affected by this list.

async function optOut(req: Request): Promise<{ ok: boolean; clubName?: string; error?: string }> {
  const url = new URL(req.url);
  const clubId = url.searchParams.get("c") || "";
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";

  if (!clubId || !email || !token || !verifyUnsubscribeToken(clubId, email, token)) {
    return { ok: false, error: "This unsubscribe link is invalid or has expired." };
  }

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { name: true } });
  if (!club) return { ok: false, error: "This club no longer exists." };

  await prisma.emailOptOut.upsert({
    where: { clubId_email: { clubId, email } },
    create: { clubId, email },
    update: {},
  });

  return { ok: true, clubName: club.name };
}

function page(title: string, body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,sans-serif;background:#fafaf9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">
<div style="background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:40px;max-width:440px;text-align:center">
<h1 style="font-size:20px;color:#1c1917;margin:0 0 12px">${title}</h1>
<p style="font-size:14px;color:#57534e;line-height:1.6;margin:0">${body}</p>
</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export async function GET(req: Request) {
  const r = await optOut(req);
  if (!r.ok) return page("Link not valid", r.error || "Please use the link from a recent email.");
  return page(
    "You're unsubscribed",
    `You will no longer receive announcement emails from ${r.clubName}. You'll still receive essential account emails like receipts and booking confirmations. Unsubscribed by mistake? Ask your club to re-add you.`,
  );
}

// RFC 8058 one-click unsubscribe (List-Unsubscribe-Post).
export async function POST(req: Request) {
  const r = await optOut(req);
  return NextResponse.json(r.ok ? { ok: true } : { error: r.error }, { status: r.ok ? 200 : 400 });
}
