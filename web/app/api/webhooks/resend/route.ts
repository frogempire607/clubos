import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

// POST /api/webhooks/resend
//
// Receives Resend delivery-lifecycle events (Svix-signed) and applies them
// to the matching EmailSend row via providerMessageId. This is the ONLY
// path that lands delivered/opened/clicked/bounced/complained on
// EmailSend, so a member's Communications tab and campaign-level analytics
// can distinguish "we shipped it" from "the inbox actually got it".
//
// Signature verification follows Svix's spec — Resend proxies through
// Svix, so the same algorithm applies:
//   base = `${svix-id}.${svix-timestamp}.${rawBody}`
//   sig  = base64(HMAC_SHA256(secret_bytes, base))
//   header = "v1,<sig1> v1,<sig2> ..." — accept if any signature matches
// The secret is base64-encoded in the Svix dashboard prefixed with
// `whsec_`; we strip the prefix and base64-decode before HMAC.
//
// Missing/invalid signatures return 401. Unknown event types return 200
// so Resend doesn't retry a payload we deliberately ignore. Unknown
// providerMessageId returns 200 too — a webhook that arrives before the
// EmailSend row is committed (impossibly rare given sendClubEmail inserts
// FIRST) or that references a foreign message shouldn't hard-fail
// Resend's retry loop.
//
// Idempotency: every lifecycle transition compares before-writing so a
// double delivery of the same event doesn't reset counters or backfill an
// earlier state (e.g. bounced → delivered is impossible; delivered stays
// once set). Not strictly required — Resend deduplicates internally — but
// costs nothing and closes the door on a replay.

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(req: Request) {
  const secretEnv = process.env.RESEND_WEBHOOK_SECRET;
  if (!secretEnv) {
    console.error("[resend-webhook] RESEND_WEBHOOK_SECRET is not set — rejecting webhook.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }

  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json({ error: "Missing Svix headers" }, { status: 401 });
  }

  const raw = await req.text();
  if (!verifySvixSignature(secretEnv, svixId, svixTimestamp, raw, svixSignature)) {
    return NextResponse.json({ error: "Bad signature" }, { status: 401 });
  }

  let parsed: ResendWebhookEvent;
  try {
    parsed = JSON.parse(raw) as ResendWebhookEvent;
  } catch {
    return NextResponse.json({ error: "Malformed JSON" }, { status: 400 });
  }

  const providerMessageId = parsed?.data?.email_id;
  if (!providerMessageId) {
    // Nothing to match against. Not an error — Resend may add event
    // shapes we don't recognize.
    return NextResponse.json({ ok: true, ignored: "no email_id" });
  }

  const send = await prisma.emailSend.findFirst({
    where: { providerMessageId },
    select: { id: true, status: true, deliveredAt: true, bouncedAt: true, openedAt: true, openCount: true, clickedAt: true, clickCount: true },
  });
  if (!send) {
    // Webhook for a message we didn't send — foreign account key, or
    // arrived before our EmailSend row was inserted (impossibly rare;
    // sendClubEmail inserts first, then dispatches). Ack and move on.
    return NextResponse.json({ ok: true, ignored: "unknown providerMessageId" });
  }

  const eventAt = parsed?.created_at ? new Date(parsed.created_at) : new Date();
  const patch = deriveLifecyclePatch(parsed.type, eventAt, send);
  if (!patch) {
    return NextResponse.json({ ok: true, ignored: `unhandled event: ${parsed.type}` });
  }

  await prisma.emailSend.update({
    where: { id: send.id },
    data: { ...patch, updatedAt: new Date() },
  });

  return NextResponse.json({ ok: true, applied: parsed.type });
}

// ── Svix signature ────────────────────────────────────────────────────────

function verifySvixSignature(
  secretEnv: string,
  svixId: string,
  svixTimestamp: string,
  payload: string,
  signatureHeader: string,
): boolean {
  const secretBytes = decodeSvixSecret(secretEnv);
  if (!secretBytes) return false;

  const base = `${svixId}.${svixTimestamp}.${payload}`;
  const expected = createHmac("sha256", secretBytes).update(base).digest("base64");
  const expectedBuf = Buffer.from(expected);

  // Header: "v1,<sig1> v1,<sig2> ..." — accept if any v1 signature matches.
  for (const part of signatureHeader.split(" ")) {
    const [version, sig] = part.split(",", 2);
    if (version !== "v1" || !sig) continue;
    const provided = Buffer.from(sig);
    if (provided.length !== expectedBuf.length) continue;
    try {
      if (timingSafeEqual(provided, expectedBuf)) return true;
    } catch {
      // fall through
    }
  }
  return false;
}

function decodeSvixSecret(raw: string): Buffer | null {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.startsWith("whsec_") ? trimmed.slice("whsec_".length) : trimmed;
  try {
    const buf = Buffer.from(withoutPrefix, "base64");
    return buf.length ? buf : null;
  } catch {
    return null;
  }
}

// ── Lifecycle mapping ────────────────────────────────────────────────────

interface ResendWebhookEvent {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    [k: string]: unknown;
  };
}

type SendSnapshot = {
  status: string;
  deliveredAt: Date | null;
  bouncedAt: Date | null;
  openedAt: Date | null;
  openCount: number;
  clickedAt: Date | null;
  clickCount: number;
};

// Never regress a terminal state: once a row is BOUNCED, a later
// out-of-order `delivered` won't overwrite. Once DELIVERED, `sent` won't
// re-set. openCount/clickCount monotonically increase.
function deriveLifecyclePatch(
  type: string | undefined,
  eventAt: Date,
  snap: SendSnapshot,
): Record<string, unknown> | null {
  switch (type) {
    case "email.sent":
      // SENT means Resend accepted the request. sendClubEmail already
      // wrote status=SENT on success, so this event is usually a no-op.
      // If somehow we're still in QUEUED (SMTP path never fires this),
      // upgrade to SENT.
      if (snap.status === "QUEUED") {
        return { status: "SENT", sentAt: eventAt };
      }
      return null;

    case "email.delivered":
      if (snap.deliveredAt) return null; // already delivered
      // Terminal-ish: don't overwrite BOUNCED/FAILED/COMPLAINED.
      if (["BOUNCED", "FAILED", "COMPLAINED"].includes(snap.status)) return null;
      return {
        status: "DELIVERED",
        deliveredAt: eventAt,
      };

    case "email.bounced":
      if (snap.bouncedAt) return null;
      return {
        status: "BOUNCED",
        bouncedAt: eventAt,
      };

    case "email.complained":
      // Recipient reported spam — a strong opt-out signal.
      return {
        status: "COMPLAINED",
      };

    case "email.opened": {
      // openedAt = first open; openCount always increments.
      return {
        openedAt: snap.openedAt ?? eventAt,
        openCount: (snap.openCount ?? 0) + 1,
      };
    }

    case "email.clicked": {
      return {
        clickedAt: snap.clickedAt ?? eventAt,
        clickCount: (snap.clickCount ?? 0) + 1,
      };
    }

    case "email.failed":
      // Resend surfaces this for permanent send-side failures.
      return {
        status: "FAILED",
        error: "Provider reported permanent failure",
      };

    case "email.delivery_delayed":
      // Informational — don't change status; a subsequent delivered/bounced
      // will resolve it.
      return null;

    default:
      return null;
  }
}
