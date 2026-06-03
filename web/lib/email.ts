import nodemailer from "nodemailer";

const REQUIRED_SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS"] as const;

/**
 * Check whether SMTP is configured. Returns the list of missing env var names
 * (empty array means ready to send). Use this when an admin action depends on
 * email actually going out — we want a real error, not a silent no-op.
 */
export function smtpMissingVars(): string[] {
  return REQUIRED_SMTP_VARS.filter((name) => !process.env[name]);
}

export function isEmailConfigured(): boolean {
  return smtpMissingVars().length === 0;
}

export async function sendEmail({
  to,
  subject,
  html,
  fromName,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  // Friendly "From" name members see (e.g. the club's name). The actual
  // sending address still comes from EMAIL_FROM (the configured SMTP
  // mailbox) — only the display name is overridden, which keeps DKIM/SPF
  // valid for deliverability.
  fromName?: string | null;
  // Where member replies go (e.g. the club's contact email).
  replyTo?: string | null;
}) {
  if (!process.env.SMTP_HOST) {
    console.log(`[Email – no SMTP configured] To: ${to} | Subject: ${subject}`);
    return;
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const baseFrom = process.env.EMAIL_FROM || "AthletixOS <no-reply@clubos.app>";
  let from = baseFrom;
  if (fromName) {
    const addr = baseFrom.match(/<([^>]+)>/)?.[1] || baseFrom;
    from = `${fromName.replace(/["<>]/g, "")} <${addr}>`;
  }

  await transporter.sendMail({
    from,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
}

// ── Email templates ──────────────────────────────────────────────────────────

function baseLayout(content: string): string {
  return `
    <div style="font-family:Inter,sans-serif;max-width:540px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #E7E5E4">
      <div style="background:#1C1917;padding:20px 28px;display:flex;align-items:center;gap:10px">
        <div style="width:28px;height:28px;border-radius:8px;background:#534AB7;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:13px">C</div>
        <span style="color:#fff;font-weight:600;font-size:15px">AthletixOS</span>
      </div>
      <div style="padding:28px">${content}</div>
      <div style="padding:16px 28px;border-top:1px solid #E7E5E4;background:#F5F3EE">
        <p style="color:#a8a29e;font-size:12px;margin:0">Sent via AthletixOS · <a href="https://clubos.app" style="color:#78716C">clubos.app</a></p>
      </div>
    </div>
  `;
}

export async function sendWelcomeEmail({
  to,
  firstName,
  clubName,
  loginUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  loginUrl: string;
}) {
  await sendEmail({
    to,
    subject: `Welcome to ${clubName}!`,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">Welcome, ${firstName}!</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 20px">
        You've been added to <strong>${clubName}</strong> on AthletixOS.
        You can log in to view your schedule, documents, and more.
      </p>
      <a href="${loginUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Access your member portal
      </a>
      <p style="color:#a8a29e;font-size:13px;margin:20px 0 0">
        If you have any questions, contact your club directly.
      </p>
    `),
  });
}

export async function sendPasswordResetEmail({
  to,
  firstName,
  clubName,
  resetUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  resetUrl: string;
}) {
  await sendEmail({
    to,
    subject: "Reset your AthletixOS password",
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">Reset your password</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 4px">Hi ${firstName},</p>
      <p style="color:#57534e;line-height:1.6;margin:0 0 20px">
        We received a request to reset your password for <strong>${clubName}</strong> on AthletixOS.
      </p>
      <a href="${resetUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Reset password
      </a>
      <p style="color:#a8a29e;font-size:13px;margin:20px 0 0">
        This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
      </p>
    `),
  });
}

export async function sendStaffInviteEmail({
  to,
  firstName,
  clubName,
  inviterName,
  loginUrl,
  tempPassword,
  setupUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  inviterName: string;
  loginUrl: string;
  tempPassword?: string;
  // When provided, the email becomes a "Set up your account" invite that
  // points the recipient at the password-setup page instead of handing
  // out a temporary password. tempPassword is ignored if setupUrl is set.
  setupUrl?: string;
}) {
  const ctaUrl = setupUrl || loginUrl;
  const ctaLabel = setupUrl ? "Set up your account" : "Sign in";
  await sendEmail({
    to,
    subject: setupUrl
      ? `Finish setting up your staff account at ${clubName}`
      : `You've been added as staff at ${clubName}`,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">Welcome to the team, ${firstName}!</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 12px">
        ${inviterName} added you as staff at <strong>${clubName}</strong> on AthletixOS.
        ${setupUrl
          ? "Click below to create your password and finish activating your account. The link expires in 14 days."
          : "You can now sign in to manage members, classes, and more."}
      </p>
      ${!setupUrl && tempPassword ? `
        <div style="background:#F5F3EE;border-radius:8px;padding:14px;margin:0 0 16px">
          <p style="color:#57534e;margin:0 0 4px;font-size:13px">Your temporary password:</p>
          <p style="font-family:monospace;font-size:15px;color:#1c1917;margin:0">${tempPassword}</p>
          <p style="color:#a8a29e;font-size:12px;margin:8px 0 0">Change it after your first login from Settings.</p>
        </div>
      ` : ""}
      <a href="${ctaUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        ${ctaLabel}
      </a>
    `),
  });
}

export async function sendBookingConfirmationEmail({
  to,
  firstName,
  clubName,
  eventName,
  startsAt,
  endsAt,
  location,
  coveredByMembership,
  amountPaid,
  portalUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  eventName: string;
  startsAt: Date;
  endsAt?: Date | null;
  location?: string | null;
  coveredByMembership?: boolean;
  amountPaid?: string;
  portalUrl: string;
}) {
  const fmtDate = startsAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const fmtTime = startsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const endTime = endsAt ? ` – ${endsAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : "";

  await sendEmail({
    to,
    subject: `Booking confirmed: ${eventName}`,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">You're confirmed, ${firstName}!</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 16px">
        Your spot at <strong>${eventName}</strong> with ${clubName} is locked in.
      </p>
      <div style="background:#F5F3EE;border-radius:8px;padding:16px;margin:0 0 16px">
        <p style="color:#1c1917;margin:0 0 4px;font-weight:600">${eventName}</p>
        <p style="color:#57534e;margin:0;font-size:14px">${fmtDate}</p>
        <p style="color:#57534e;margin:0;font-size:14px">${fmtTime}${endTime}</p>
        ${location ? `<p style="color:#a8a29e;margin:6px 0 0;font-size:13px">${location}</p>` : ""}
        ${coveredByMembership
          ? `<p style="color:#65A30D;margin:8px 0 0;font-size:13px;font-weight:500">Covered by your membership</p>`
          : amountPaid
            ? `<p style="color:#57534e;margin:8px 0 0;font-size:13px">Paid: <strong>${amountPaid}</strong></p>`
            : ""}
      </div>
      <a href="${portalUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        View in your portal
      </a>
    `),
  });
}

export async function sendMembershipActivatedEmail({
  to,
  firstName,
  clubName,
  membershipName,
  amountPaid,
  endDate,
  portalUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  membershipName: string;
  amountPaid?: string;
  endDate?: Date | null;
  portalUrl: string;
}) {
  await sendEmail({
    to,
    subject: `Welcome to ${membershipName} at ${clubName}`,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">You're in, ${firstName}!</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 16px">
        Your <strong>${membershipName}</strong> membership at ${clubName} is now active.
      </p>
      <div style="background:#F5F3EE;border-radius:8px;padding:16px;margin:0 0 16px">
        <p style="color:#1c1917;margin:0 0 4px;font-weight:600">${membershipName}</p>
        ${amountPaid ? `<p style="color:#57534e;margin:0;font-size:14px">Paid: <strong>${amountPaid}</strong></p>` : ""}
        ${endDate ? `<p style="color:#57534e;margin:4px 0 0;font-size:14px">Renews ${endDate.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>` : ""}
      </div>
      <a href="${portalUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Go to your portal
      </a>
      <p style="color:#a8a29e;font-size:13px;margin:20px 0 0">
        You can manage your membership and payment method any time from the portal.
      </p>
    `),
  });
}

export async function sendPaymentFailedEmail({
  to,
  firstName,
  clubName,
  amount,
  loginUrl,
}: {
  to: string;
  firstName: string;
  clubName: string;
  amount: string;
  loginUrl: string;
}) {
  await sendEmail({
    to,
    subject: `Payment issue with your ${clubName} membership`,
    html: baseLayout(`
      <h2 style="color:#A32D2D;margin:0 0 8px">Payment failed</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 4px">Hi ${firstName},</p>
      <p style="color:#57534e;line-height:1.6;margin:0 0 20px">
        We weren't able to process your payment of <strong>${amount}</strong> for your membership at
        <strong>${clubName}</strong>. Please update your payment method to keep your membership active.
      </p>
      <a href="${loginUrl}" style="display:inline-block;background:#A32D2D;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Update payment method
      </a>
      <p style="color:#a8a29e;font-size:13px;margin:20px 0 0">
        If you need help, reply to this email or contact ${clubName} directly.
      </p>
    `),
  });
}

// Branded migration activation email — a "membership card reveal". Used by the
// Member Migration wizard for the first invite AND reminders. Never asks for
// card details in the email; the CTA links to the secure activation page only.
export async function sendMemberMigrationActivationEmail({
  to,
  athleteName,
  clubName,
  clubLogoUrl,
  membershipName,
  nextBillingDate,
  activationUrl,
  isReminder = false,
  fromName,
  replyTo,
}: {
  to: string;
  athleteName: string;
  clubName: string;
  clubLogoUrl?: string | null;
  membershipName?: string | null;
  nextBillingDate?: string | null;
  activationUrl: string;
  isReminder?: boolean;
  fromName?: string | null;
  replyTo?: string | null;
}) {
  const subject = isReminder
    ? `Reminder: activate your ${clubName} membership`
    : `Your ${clubName} membership is ready to continue`;

  const logoBlock = clubLogoUrl
    ? `<img src="${clubLogoUrl}" alt="${clubName}" style="width:56px;height:56px;border-radius:14px;object-fit:cover;display:block;margin:0 auto 14px" />`
    : `<div style="width:56px;height:56px;border-radius:14px;background:rgba(255,255,255,0.18);color:#fff;font-weight:700;font-size:22px;display:flex;align-items:center;justify-content:center;margin:0 auto 14px">${clubName.charAt(0).toUpperCase()}</div>`;

  const html = `
  <div style="font-family:Inter,Segoe UI,sans-serif;max-width:560px;margin:0 auto;background:#F5F3EE;padding:24px">
    <div style="background:#fff;border-radius:16px;overflow:hidden;border:1px solid #E7E5E4">
      <!-- Envelope / reveal header -->
      <div style="background:linear-gradient(135deg,#534AB7 0%,#3F3796 100%);padding:32px 28px;text-align:center">
        ${logoBlock}
        <p style="color:rgba(255,255,255,0.85);font-size:13px;margin:0 0 4px;letter-spacing:0.04em;text-transform:uppercase">${clubName}</p>
        <h1 style="color:#fff;font-size:22px;margin:0;font-weight:700">Your membership is ready to continue</h1>
      </div>

      <div style="padding:28px">
        <p style="color:#57534e;line-height:1.65;margin:0 0 18px">
          Hi ${athleteName}, <strong>${clubName}</strong> has moved to AthletixOS. We've prepared
          your account using the email from your previous club software. Activate your account and
          securely add your billing method to continue your membership without interruption.
        </p>

        <!-- Digital membership card -->
        <div style="background:#1C1917;border-radius:14px;padding:20px 22px;margin:0 0 22px">
          <p style="color:#a8a29e;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin:0 0 10px">Membership</p>
          <p style="color:#fff;font-size:18px;font-weight:700;margin:0 0 14px">${membershipName || "Your membership"}</p>
          <div style="display:flex;justify-content:space-between">
            <div>
              <p style="color:#a8a29e;font-size:11px;margin:0 0 2px">MEMBER</p>
              <p style="color:#fff;font-size:14px;margin:0">${athleteName}</p>
            </div>
            <div style="text-align:right">
              <p style="color:#a8a29e;font-size:11px;margin:0 0 2px">NEXT BILLING</p>
              <p style="color:#fff;font-size:14px;margin:0">${nextBillingDate || "After activation"}</p>
            </div>
          </div>
        </div>

        <div style="text-align:center;margin:0 0 20px">
          <a href="${activationUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:14px 32px;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px">
            Activate My Membership
          </a>
        </div>

        <div style="background:#F5F3EE;border-radius:10px;padding:14px 16px;margin:0 0 8px">
          <p style="color:#78716C;font-size:12.5px;line-height:1.6;margin:0">
            You won't be charged until you add a payment method and accept autopay, and billing
            continues on your existing date${nextBillingDate ? ` (${nextBillingDate})` : ""} — not today.
            We never ask for card details by email; the button above opens your secure AthletixOS page.
          </p>
        </div>
      </div>

      <div style="padding:14px 28px;border-top:1px solid #E7E5E4;background:#fff;text-align:center">
        <p style="color:#a8a29e;font-size:11px;margin:0">Powered by <strong style="color:#78716C">AthletixOS</strong> · <a href="https://clubos.app" style="color:#78716C;text-decoration:none">clubos.app</a></p>
      </div>
    </div>
  </div>`;

  await sendEmail({ to, subject, html, fromName, replyTo });
}

// Coach pre-notification: fires when a member submits a private lesson
// request that assigns this coach. Pairs with the in-app DM so coaches
// notice the request even if they don't open the portal regularly.
// Best-effort: caller wraps in try/catch so a transport failure never
// breaks the booking-create flow.
export async function sendPrivateLessonRequestedEmail({
  to,
  coachFirstName,
  clubName,
  memberFirstName,
  memberLastName,
  lessonTitle,
  requestedSlots,
  notes,
  dashboardUrl,
  fromName,
  replyTo,
}: {
  to: string;
  coachFirstName: string;
  clubName: string;
  memberFirstName: string;
  memberLastName: string;
  lessonTitle: string;
  // [{ date: "YYYY-MM-DD", startTime: "HH:mm", endTime: "HH:mm" }, ...]
  requestedSlots: { date: string; startTime: string; endTime: string }[];
  notes?: string | null;
  dashboardUrl: string;
  fromName?: string | null;
  replyTo?: string | null;
}) {
  // Render requested slots in the same "Thu, Jun 15 · 2:30 PM – 3:30 PM"
  // shape the athlete sees in the portal — coaches and athletes refer to
  // the same times in messages.
  const fmtSlot = (s: { date: string; startTime: string; endTime: string }) => {
    const d = new Date(`${s.date}T${s.startTime || "00:00"}`);
    if (Number.isNaN(d.getTime())) return `${s.date} ${s.startTime} – ${s.endTime}`;
    const dateLabel = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const startLabel = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const endDate = new Date(`${s.date}T${s.endTime || "00:00"}`);
    const endLabel = Number.isNaN(endDate.getTime())
      ? s.endTime
      : endDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    return `${dateLabel} · ${startLabel} – ${endLabel}`;
  };

  const slotItems = requestedSlots
    .map((s) => `<li style="color:#57534e;font-size:14px;margin:0 0 4px">${fmtSlot(s)}</li>`)
    .join("");

  await sendEmail({
    to,
    subject: `New private lesson request — ${lessonTitle}`,
    fromName,
    replyTo,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">New private request, ${coachFirstName}</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 16px">
        <strong>${memberFirstName} ${memberLastName}</strong> has requested a private lesson
        at ${clubName}.
      </p>
      <div style="background:#F5F3EE;border-radius:8px;padding:16px;margin:0 0 16px">
        <p style="color:#1c1917;margin:0 0 6px;font-weight:600">${lessonTitle}</p>
        <p style="color:#a8a29e;margin:0 0 6px;font-size:12px;text-transform:uppercase;letter-spacing:0.04em">Requested times</p>
        <ul style="margin:0;padding:0 0 0 18px">${slotItems}</ul>
        ${notes ? `<p style="color:#57534e;margin:10px 0 0;font-size:13px"><em>Note from athlete:</em> ${notes.replace(/[<>]/g, "")}</p>` : ""}
      </div>
      <a href="${dashboardUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Review request
      </a>
      <p style="color:#a8a29e;font-size:12px;margin:18px 0 0">
        You'll also see this in your private lessons dashboard. Approve to confirm a time
        or propose a different slot.
      </p>
    `),
  });
}

// OUTSIDE partner invite — fires when a coach accepts a multi-athlete
// private lesson and the booker provided their outside partner's email
// at request time. The link points to the public partner-token page
// where the partner fills in their info to confirm participation.
// Best-effort: caller wraps in try/catch; if no email was collected
// at booking time, no email is sent (the booker shares the link
// manually as before).
export async function sendPartnerInviteEmail({
  to,
  partnerName,
  bookerName,
  clubName,
  lessonTitle,
  confirmedStartAt,
  inviteUrl,
  fromName,
  replyTo,
}: {
  to: string;
  partnerName: string | null; // may be unknown if booker only typed an email
  bookerName: string;
  clubName: string;
  lessonTitle: string;
  confirmedStartAt: Date | null;
  inviteUrl: string;
  fromName?: string | null;
  replyTo?: string | null;
}) {
  const whenLabel = confirmedStartAt
    ? `${confirmedStartAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at ${confirmedStartAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : null;
  const greeting = partnerName ? `Hi ${partnerName}` : "Hi there";

  await sendEmail({
    to,
    subject: `${bookerName} invited you to a private lesson at ${clubName}`,
    fromName,
    replyTo,
    html: baseLayout(`
      <h2 style="color:#1c1917;margin:0 0 8px">${greeting},</h2>
      <p style="color:#57534e;line-height:1.6;margin:0 0 16px">
        <strong>${bookerName}</strong> has invited you to join a private lesson at ${clubName}.
      </p>
      <div style="background:#F5F3EE;border-radius:8px;padding:16px;margin:0 0 16px">
        <p style="color:#1c1917;margin:0 0 4px;font-weight:600">${lessonTitle}</p>
        ${whenLabel ? `<p style="color:#57534e;margin:0;font-size:14px">${whenLabel}</p>` : `<p style="color:#a8a29e;margin:0;font-size:13px">Time will be confirmed once you accept.</p>`}
      </div>
      <a href="${inviteUrl}" style="display:inline-block;background:#534AB7;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px">
        Confirm and add your info
      </a>
      <p style="color:#a8a29e;font-size:12px;margin:18px 0 0">
        We'll ask for a few details (name, phone, waiver acknowledgement) so the club has what
        they need on the day.
      </p>
    `),
  });
}
