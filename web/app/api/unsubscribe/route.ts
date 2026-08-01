// Public unsubscribe endpoint for announcement / broadcast emails.
//
// GET  — render a landing page. Current state + three actions:
//        "Just marketing" (default), "All email except account security",
//        "Resubscribe". A one-click flow from the email footer opts the
//        recipient out of MARKETING immediately (so the RFC-8058
//        List-Unsubscribe-Post header still works with a single click),
//        and shows the granular controls on the confirmation page.
// POST — RFC 8058 one-click List-Unsubscribe (marketing scope).
// PATCH — recipient changes their scope from the landing page.
//         Applies the same signed-token guard so a POST from a random
//         browser can't opt someone else out of transactional email.
//
// Every mutation writes an EmailOptOutAudit row (plan §3I). The audit
// records: action (SUBSCRIBE / UNSUBSCRIBE), scope, source
// (UNSUBSCRIBE_LINK), IP + UA in context. Anonymous — the actor is the
// recipient themself, not a logged-in owner/staff.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifyUnsubscribeToken } from "@/lib/unsubscribe";
import { writeOptOutAudit } from "@/lib/optOutAudit";

type Scope = "MARKETING" | "ALL";

async function parseToken(url: URL): Promise<{ ok: true; clubId: string; email: string } | { ok: false; error: string }> {
  const clubId = url.searchParams.get("c") || "";
  const email = (url.searchParams.get("e") || "").trim().toLowerCase();
  const token = url.searchParams.get("t") || "";
  if (!clubId || !email || !token || !verifyUnsubscribeToken(clubId, email, token)) {
    return { ok: false, error: "This unsubscribe link is invalid or has expired." };
  }
  return { ok: true, clubId, email };
}

async function contextFromRequest(req: Request): Promise<Record<string, unknown>> {
  const ip =
    (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() ||
    req.headers.get("x-real-ip") ||
    undefined;
  const ua = req.headers.get("user-agent") ?? undefined;
  return { ip, userAgent: ua };
}

async function applyScope(
  args: {
    clubId: string;
    email: string;
    scope: Scope;
    context: Record<string, unknown>;
  },
): Promise<{ ok: true; clubName: string } | { ok: false; error: string }> {
  const club = await prisma.club.findUnique({
    where: { id: args.clubId }, select: { name: true },
  });
  if (!club) return { ok: false, error: "This club no longer exists." };

  const existing = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId: args.clubId, email: args.email } },
    select: { scope: true },
  });

  // Match against the userId when we have one — a member may have
  // signed up after unsubscribing under the same address.
  const user = await prisma.user.findFirst({
    where: { clubId: args.clubId, email: args.email, deletedAt: null },
    select: { id: true },
  });

  await prisma.emailOptOut.upsert({
    where: { clubId_email: { clubId: args.clubId, email: args.email } },
    create: {
      clubId: args.clubId,
      email: args.email,
      userId: user?.id ?? null,
      scope: args.scope,
      source: "UNSUBSCRIBE_LINK",
    },
    update: {
      scope: args.scope,
      userId: user?.id ?? existing ? undefined : null,
      source: "UNSUBSCRIBE_LINK",
      updatedAt: new Date(),
    },
  });

  // Audit — only when the scope actually changed. A re-click of the
  // same link doesn't need to accumulate identical rows.
  if (!existing || existing.scope !== args.scope) {
    await writeOptOutAudit({
      clubId: args.clubId,
      email: args.email,
      userId: user?.id ?? null,
      scope: args.scope,
      action: "UNSUBSCRIBE",
      source: "UNSUBSCRIBE_LINK",
      actorUserId: null,
      actorRole: "ANONYMOUS",
      context: args.context,
    });
  }
  return { ok: true, clubName: club.name };
}

async function resubscribe(args: {
  clubId: string;
  email: string;
  context: Record<string, unknown>;
}): Promise<{ ok: true; clubName: string } | { ok: false; error: string }> {
  const club = await prisma.club.findUnique({
    where: { id: args.clubId }, select: { name: true },
  });
  if (!club) return { ok: false, error: "This club no longer exists." };

  const existing = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId: args.clubId, email: args.email } },
    select: { scope: true, userId: true },
  });
  if (!existing) {
    // Already subscribed — no state to change, no audit row (nothing changed).
    return { ok: true, clubName: club.name };
  }

  await prisma.emailOptOut.delete({
    where: { clubId_email: { clubId: args.clubId, email: args.email } },
  });
  await writeOptOutAudit({
    clubId: args.clubId,
    email: args.email,
    userId: existing.userId,
    scope: "MARKETING", // resubscribe = "opt back in", scope is what they returned to
    action: "SUBSCRIBE",
    source: "UNSUBSCRIBE_LINK",
    actorUserId: null,
    actorRole: "ANONYMOUS",
    context: args.context,
  });
  return { ok: true, clubName: club.name };
}

function page(title: string, body: string): NextResponse {
  return new NextResponse(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="font-family:-apple-system,sans-serif;background:#fafaf9;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px">
<div style="background:#fff;border:1px solid #e7e5e4;border-radius:16px;padding:40px;max-width:520px;width:100%">
<h1 style="font-size:20px;color:#1c1917;margin:0 0 12px">${title}</h1>
${body}
</div></body></html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function renderChoicePanel(args: {
  clubName: string;
  clubId: string;
  email: string;
  token: string;
  currentScope: Scope | "SUBSCRIBED";
}): string {
  const { clubName, clubId, email, token, currentScope } = args;
  const params = `c=${encodeURIComponent(clubId)}&e=${encodeURIComponent(email)}&t=${encodeURIComponent(token)}`;
  // Server-rendered <form> so no client JS required — mail clients that
  // preview links (privacy-hardened Outlook) still work.
  return `
    <p style="font-size:14px;color:#57534e;line-height:1.6;margin:0 0 16px">
      You're managing email preferences for
      <strong>${escape(email)}</strong> with <strong>${escape(clubName)}</strong>.
    </p>
    <p style="font-size:13px;color:#57534e;margin:0 0 20px">
      Current: <strong>${
        currentScope === "SUBSCRIBED" ? "receiving all email" :
        currentScope === "MARKETING" ? "unsubscribed from marketing" :
        "unsubscribed from all non-essential email"
      }</strong>.
    </p>
    <form method="POST" action="/api/unsubscribe/apply?${params}" style="display:flex;flex-direction:column;gap:8px">
      <label style="display:flex;align-items:flex-start;gap:8px;padding:12px;border:1px solid #e7e5e4;border-radius:12px;cursor:pointer">
        <input type="radio" name="scope" value="MARKETING" ${currentScope === "MARKETING" ? "checked" : ""} style="margin-top:3px" />
        <span>
          <strong style="font-size:14px;color:#1c1917">Unsubscribe from marketing</strong><br/>
          <span style="font-size:12px;color:#78716c">You will not receive newsletters or promotional emails. You will still get receipts, booking confirmations, password resets, and other essential account emails.</span>
        </span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:8px;padding:12px;border:1px solid #e7e5e4;border-radius:12px;cursor:pointer">
        <input type="radio" name="scope" value="ALL" ${currentScope === "ALL" ? "checked" : ""} style="margin-top:3px" />
        <span>
          <strong style="font-size:14px;color:#1c1917">Unsubscribe from all non-essential email</strong><br/>
          <span style="font-size:12px;color:#78716c">Only receipts, password resets, and account-security notices will be delivered. Everything else — including class updates and cancellations — is silenced.</span>
        </span>
      </label>
      <label style="display:flex;align-items:flex-start;gap:8px;padding:12px;border:1px solid #e7e5e4;border-radius:12px;cursor:pointer">
        <input type="radio" name="scope" value="SUBSCRIBE" ${currentScope === "SUBSCRIBED" ? "checked" : ""} style="margin-top:3px" />
        <span>
          <strong style="font-size:14px;color:#1c1917">Resubscribe</strong><br/>
          <span style="font-size:12px;color:#78716c">Receive all email from ${escape(clubName)} — including marketing.</span>
        </span>
      </label>
      <button type="submit" style="margin-top:12px;padding:12px 20px;background:#1c1917;color:#fff;border:0;border-radius:12px;font-size:14px;font-weight:600;cursor:pointer">Save preferences</button>
    </form>`;
}

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function currentScopeFor(clubId: string, email: string): Promise<Scope | "SUBSCRIBED"> {
  const row = await prisma.emailOptOut.findUnique({
    where: { clubId_email: { clubId, email } },
    select: { scope: true },
  });
  if (!row) return "SUBSCRIBED";
  return row.scope === "ALL" ? "ALL" : "MARKETING";
}

// GET — landing page. The historical one-click behavior (opt out of
// marketing immediately) is preserved so we don't regress the
// List-Unsubscribe UX in Gmail: hitting the link toggles you off
// marketing, then shows the granular panel.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const parsed = await parseToken(url);
  if (!parsed.ok) return page("Link not valid", `<p style="font-size:14px;color:#57534e;line-height:1.6;margin:0">${escape(parsed.error)}</p>`);

  // Apply MARKETING opt-out immediately on GET so the traditional
  // one-click flow still Just Works. If the visitor prefers a
  // different scope they change it in the panel below.
  const ctx = await contextFromRequest(req);
  const applied = await applyScope({ clubId: parsed.clubId, email: parsed.email, scope: "MARKETING", context: ctx });
  if (!applied.ok) return page("Link not valid", `<p style="font-size:14px;color:#57534e;line-height:1.6;margin:0">${escape(applied.error)}</p>`);
  const scope = await currentScopeFor(parsed.clubId, parsed.email);
  return page(
    "Email preferences",
    renderChoicePanel({
      clubName: applied.clubName,
      clubId: parsed.clubId,
      email: parsed.email,
      token: url.searchParams.get("t") ?? "",
      currentScope: scope,
    }),
  );
}

// RFC 8058 one-click unsubscribe. Marketing scope only (existing
// contract). Audit row still written.
export async function POST(req: Request) {
  const url = new URL(req.url);
  const parsed = await parseToken(url);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const ctx = await contextFromRequest(req);
  const applied = await applyScope({ clubId: parsed.clubId, email: parsed.email, scope: "MARKETING", context: ctx });
  if (!applied.ok) return NextResponse.json({ error: applied.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
