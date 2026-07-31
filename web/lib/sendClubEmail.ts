// The single entrypoint for every club email send in Phase 3+.
//
// Dispatch layering:
//   1. Resend (when RESEND_API_KEY is set) — populates providerMessageId +
//      lands lifecycle callbacks (delivered/opened/clicked/bounced) via
//      /api/webhooks/resend.
//   2. SMTP fallback (nodemailer via lib/email.ts) — no lifecycle callbacks;
//      status stays 'SENT' forever after.
//   3. Dev fallback (neither configured) — logs a warning and marks the
//      EmailSend row 'SKIPPED' with skippedReason='NO_PROVIDER'. Never
//      throws so a local dev without email creds doesn't 500 the caller.
//
// Every send writes exactly one EmailSend row. The row is inserted BEFORE
// dispatch (status='QUEUED') and updated after — so a crash between insert
// and dispatch leaves a QUEUED row the cron worker will pick up and retry.
// The (sendBatchId, dedupeKey) partial unique index makes a retry attempt
// with the same dedupeKey a unique-violation, which is what stops
// double-sends after a partial batch.
//
// Marketing vs transactional:
//   - kind='MARKETING' | 'ANNOUNCEMENT' | 'BULK' | 'TEMPLATE' → respect
//     EmailOptOut(scope='MARKETING' | 'ALL'). Recipients on the list get
//     status='SKIPPED', skippedReason='OPTED_OUT'.
//   - kind='TRANSACTIONAL' → NEVER checks opt-outs. Receipts, password
//     resets, booking confirmations, security notices always send.
//   Scope='ALL' opts out of BOTH — the recipient explicitly asked for zero
//   email. We honor it even on transactional (with an audit note when we do).

import { prisma } from "@/lib/prisma";
import { sendEmail as smtpSend, isEmailConfigured } from "@/lib/email";
import { sanitizeRichHtml } from "@/lib/sanitizeHtml";
import { Resend } from "resend";

export type EmailKind =
  | "MARKETING"
  | "TRANSACTIONAL"
  | "ANNOUNCEMENT"
  | "BULK"
  | "TEMPLATE";

const MARKETING_KINDS: EmailKind[] = ["MARKETING", "ANNOUNCEMENT", "BULK", "TEMPLATE"];

export interface SendClubEmailInput {
  clubId: string;
  kind: EmailKind;
  recipientEmail: string;
  recipientUserId?: string | null;
  recipientMemberId?: string | null;

  subject: string;
  bodyHtml: string;             // already rendered + sanitized (from lib/emailRender.ts)
  bodyText?: string | null;
  bodyJson?: unknown;           // canonical EmailBlock[] snapshot

  fromName?: string | null;     // display name — actual From address is EMAIL_FROM
  fromEmail?: string | null;    // Resend-only override (must be on your verified domain)
  replyTo?: string | null;

  // Set for grouped sends (announcement blast / bulk / template). The
  // (sendBatchId, dedupeKey) partial unique index is the double-send guard.
  sendBatchId?: string | null;
  dedupeKey?: string | null;
  idempotencyKey?: string | null;

  announcementId?: string | null;
  campaignId?: string | null;
  templateId?: string | null;

  // Freeform personalization snapshot for 3G history.
  personalization?: unknown;

  // One-click unsubscribe link (marketing sends only; enforced at dispatch).
  listUnsubscribeUrl?: string | null;
}

export interface SendClubEmailResult {
  emailSendId: string;
  status: "SENT" | "SKIPPED" | "FAILED" | "DUPLICATE";
  providerMessageId?: string | null;
  skippedReason?: string | null;
  error?: string | null;
}

let _resend: Resend | null = null;
function resend(): Resend | null {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  _resend = new Resend(key);
  return _resend;
}

// The one function every send in the app should call. Individual template
// helpers in lib/email.ts will be retrofitted in Phase 3.5 to route through
// here; new code MUST use this from day one.
export async function sendClubEmail(input: SendClubEmailInput): Promise<SendClubEmailResult> {
  const recipientEmail = input.recipientEmail.trim().toLowerCase();

  // Opt-out check — marketing kinds only. TRANSACTIONAL bypasses (except
  // scope='ALL', which is the hard-stop).
  const optOut = await prisma.emailOptOut.findFirst({
    where: { clubId: input.clubId, email: recipientEmail },
    select: { scope: true },
  });
  const isMarketingKind = MARKETING_KINDS.includes(input.kind);
  if (optOut && (optOut.scope === "ALL" || (isMarketingKind && optOut.scope === "MARKETING"))) {
    const row = await writeEmailSend(input, recipientEmail, "SKIPPED", { skippedReason: "OPTED_OUT" });
    return { emailSendId: row.id, status: "SKIPPED", skippedReason: "OPTED_OUT" };
  }

  // Insert EmailSend row FIRST. This is where the (sendBatchId, dedupeKey)
  // partial unique index catches a duplicate re-send from a page refresh
  // or job restart. A unique-violation here returns DUPLICATE without
  // hitting the provider — exactly the guarantee we want.
  let row: { id: string };
  try {
    row = await writeEmailSend(input, recipientEmail, "QUEUED");
  } catch (err) {
    if (isUniqueViolation(err)) {
      return {
        emailSendId: "",
        status: "DUPLICATE",
        skippedReason: "DUPLICATE_IN_BATCH",
      };
    }
    throw err;
  }

  // Choose dispatcher: Resend when configured, SMTP otherwise, dev-log last.
  const dispatcher = resend() ? "resend" : isEmailConfigured() ? "smtp" : "none";

  if (dispatcher === "none") {
    console.warn(`[sendClubEmail] No email provider configured. Skipping send to ${recipientEmail}. ` +
      `Set RESEND_API_KEY (preferred) or SMTP_HOST/USER/PASS.`);
    await prisma.emailSend.update({
      where: { id: row.id },
      data: {
        status: "SKIPPED",
        skippedReason: "NO_PROVIDER",
        updatedAt: new Date(),
      },
    });
    return { emailSendId: row.id, status: "SKIPPED", skippedReason: "NO_PROVIDER" };
  }

  // Sanitization: bodyHtml comes from lib/emailRender.ts which already
  // sanitizes, but caller-supplied HTML (retrofits of lib/email.ts helpers)
  // may not. Cheap belt-and-suspenders.
  const safeHtml = sanitizeRichHtml(input.bodyHtml);

  try {
    if (dispatcher === "resend") {
      const client = resend()!;
      const from = buildResendFrom(input.fromName, input.fromEmail);
      const result = await client.emails.send({
        from,
        to: recipientEmail,
        subject: input.subject,
        html: safeHtml,
        text: input.bodyText || undefined,
        replyTo: input.replyTo || undefined,
        headers: input.listUnsubscribeUrl && isMarketingKind
          ? {
              "List-Unsubscribe": `<${input.listUnsubscribeUrl}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            }
          : undefined,
      });
      if (result.error) {
        await prisma.emailSend.update({
          where: { id: row.id },
          data: { status: "FAILED", error: String(result.error.message || result.error), updatedAt: new Date() },
        });
        return { emailSendId: row.id, status: "FAILED", error: String(result.error.message || result.error) };
      }
      const providerMessageId = result.data?.id ?? null;
      await prisma.emailSend.update({
        where: { id: row.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId,
          updatedAt: new Date(),
        },
      });
      return { emailSendId: row.id, status: "SENT", providerMessageId };
    }

    // SMTP path — reuses lib/email.ts sendEmail() so environment behavior
    // stays consistent. No lifecycle callbacks; status stops at SENT.
    await smtpSend({
      to: recipientEmail,
      subject: input.subject,
      html: safeHtml,
      fromName: input.fromName ?? null,
      replyTo: input.replyTo ?? null,
      listUnsubscribeUrl: isMarketingKind ? (input.listUnsubscribeUrl ?? null) : null,
    });
    await prisma.emailSend.update({
      where: { id: row.id },
      data: { status: "SENT", sentAt: new Date(), updatedAt: new Date() },
    });
    return { emailSendId: row.id, status: "SENT" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await prisma.emailSend.update({
      where: { id: row.id },
      data: { status: "FAILED", error: msg, updatedAt: new Date() },
    });
    return { emailSendId: row.id, status: "FAILED", error: msg };
  }
}

// ── Internals ─────────────────────────────────────────────────────────────

interface WriteExtras {
  skippedReason?: string;
}

async function writeEmailSend(
  input: SendClubEmailInput,
  recipientEmailLower: string,
  status: "QUEUED" | "SKIPPED",
  extras: WriteExtras = {},
) {
  return prisma.emailSend.create({
    data: {
      clubId: input.clubId,
      kind: input.kind,
      announcementId: input.announcementId ?? null,
      campaignId: input.campaignId ?? null,
      templateId: input.templateId ?? null,
      recipientEmail: recipientEmailLower,
      recipientUserId: input.recipientUserId ?? null,
      recipientMemberId: input.recipientMemberId ?? null,
      subject: input.subject,
      bodyJson: (input.bodyJson ?? undefined) as never,
      bodyHtml: input.bodyHtml,
      bodyText: input.bodyText ?? null,
      fromName: input.fromName ?? null,
      fromEmail: input.fromEmail ?? null,
      replyTo: input.replyTo ?? null,
      personalization: (input.personalization ?? undefined) as never,
      status,
      skippedReason: extras.skippedReason ?? null,
      sendBatchId: input.sendBatchId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    select: { id: true },
  });
}

function buildResendFrom(fromName: string | null | undefined, fromEmailOverride: string | null | undefined): string {
  const baseAddr = fromEmailOverride
    || (process.env.EMAIL_FROM?.match(/<([^>]+)>/)?.[1] ?? process.env.EMAIL_FROM)
    || "noreply@athletix-os.com";
  if (fromName) {
    const clean = fromName.replace(/["<>]/g, "");
    return `${clean} <${baseAddr}>`;
  }
  return String(baseAddr);
}

function isUniqueViolation(err: unknown): boolean {
  // Prisma raises P2002 for unique-constraint violations.
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}
