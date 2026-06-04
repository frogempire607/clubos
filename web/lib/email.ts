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

// ── Club-branded email layout ────────────────────────────────────────────────
//
// Privates emails (coach pre-notification + outside-partner invite) carry the
// CLUB'S brand, not AthletixOS's — these are messages "from the club" to a
// coach or member, not platform housekeeping. We swap in the club logo, the
// club's primaryColor on the CTA + header accent, and use the club name as
// the visual identity. Falls back gracefully to a single-letter avatar +
// the AthletixOS purple if logo / color are missing.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clubBrandedLayout({
  clubName,
  clubLogoUrl,
  clubPrimaryColor,
  content,
}: {
  clubName: string;
  clubLogoUrl?: string | null;
  clubPrimaryColor?: string | null;
  content: string;
}): string {
  const brand = clubPrimaryColor && /^#[0-9a-fA-F]{6}$/.test(clubPrimaryColor)
    ? clubPrimaryColor
    : "#534AB7";
  const safeName = escapeHtml(clubName);
  const initial = (clubName.trim()[0] || "C").toUpperCase();
  const logoBlock = clubLogoUrl
    ? `<img src="${escapeHtml(clubLogoUrl)}" alt="${safeName}" style="width:56px;height:56px;border-radius:14px;object-fit:cover;display:block;margin:0 auto 12px" />`
    : `<div style="width:56px;height:56px;border-radius:14px;background:rgba(255,255,255,0.18);color:#fff;font-weight:700;font-size:22px;display:flex;align-items:center;justify-content:center;margin:0 auto 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${initial}</div>`;
  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;max-width:560px;margin:0 auto;background:#F5F3EE;padding:24px">
      <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #E7E5E4">
        <div style="background:${brand};padding:24px 24px 20px;text-align:center">
          ${logoBlock}
          <p style="color:rgba(255,255,255,0.92);font-size:14px;margin:0;font-weight:600;letter-spacing:0.01em">${safeName}</p>
        </div>
        <div style="padding:24px">${content}</div>
        <div style="padding:12px 24px;border-top:1px solid #E7E5E4;background:#fafaf9;text-align:center">
          <p style="color:#a8a29e;font-size:11px;margin:0">
            Sent on behalf of <strong style="color:#78716C">${safeName}</strong> · powered by AthletixOS
          </p>
        </div>
      </div>
    </div>`;
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
  clubLogoUrl,
  clubPrimaryColor,
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
  clubLogoUrl?: string | null;
  clubPrimaryColor?: string | null;
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
    .map((s) => `<li style="color:#44403c;font-size:14px;margin:0 0 6px;line-height:1.5">${escapeHtml(fmtSlot(s))}</li>`)
    .join("");
  const brand = clubPrimaryColor && /^#[0-9a-fA-F]{6}$/.test(clubPrimaryColor)
    ? clubPrimaryColor
    : "#534AB7";

  const athlete = `${memberFirstName} ${memberLastName}`.trim();
  const safeAthlete = escapeHtml(athlete);
  const safeLessonTitle = escapeHtml(lessonTitle);
  const safeCoach = escapeHtml(coachFirstName);
  const safeNotes = notes ? escapeHtml(notes.trim()) : null;

  await sendEmail({
    to,
    subject: `New private request from ${athlete} — ${lessonTitle}`,
    fromName,
    replyTo,
    html: clubBrandedLayout({
      clubName,
      clubLogoUrl,
      clubPrimaryColor,
      content: `
        <h2 style="color:#1c1917;margin:0 0 6px;font-size:20px;font-weight:700">
          New private request
        </h2>
        <p style="color:#57534e;line-height:1.6;margin:0 0 18px;font-size:14px">
          Hi ${safeCoach}, <strong>${safeAthlete}</strong> just requested a private
          lesson with you.
        </p>
        <div style="background:#F5F3EE;border-radius:10px;padding:16px;margin:0 0 20px">
          <p style="color:#1c1917;margin:0 0 8px;font-weight:600;font-size:15px">
            ${safeLessonTitle}
          </p>
          <p style="color:#a8a29e;margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;font-weight:600">
            Requested times
          </p>
          <ul style="margin:0;padding:0 0 0 18px">${slotItems}</ul>
          ${safeNotes ? `<p style="color:#57534e;margin:14px 0 0;font-size:13px;line-height:1.5"><strong style="color:#1c1917">Note from athlete:</strong> ${safeNotes}</p>` : ""}
        </div>
        <a href="${dashboardUrl}" style="display:inline-block;background:${brand};color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.01em">
          Review request
        </a>
        <p style="color:#a8a29e;font-size:12px;margin:18px 0 0;line-height:1.5">
          You can approve, propose another time, or decline from your dashboard.
        </p>
      `,
    }),
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
  clubLogoUrl,
  clubPrimaryColor,
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
  clubLogoUrl?: string | null;
  clubPrimaryColor?: string | null;
  lessonTitle: string;
  confirmedStartAt: Date | null;
  inviteUrl: string;
  fromName?: string | null;
  replyTo?: string | null;
}) {
  const whenLabel = confirmedStartAt
    ? `${confirmedStartAt.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })} at ${confirmedStartAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : null;
  const safePartnerName = partnerName ? escapeHtml(partnerName.trim()) : null;
  const greeting = safePartnerName ? `Hi ${safePartnerName}` : "Hi there";
  const safeBooker = escapeHtml(bookerName);
  const safeLessonTitle = escapeHtml(lessonTitle);
  const brand = clubPrimaryColor && /^#[0-9a-fA-F]{6}$/.test(clubPrimaryColor)
    ? clubPrimaryColor
    : "#534AB7";

  await sendEmail({
    to,
    subject: `${bookerName} invited you to train at ${clubName}`,
    fromName,
    replyTo,
    html: clubBrandedLayout({
      clubName,
      clubLogoUrl,
      clubPrimaryColor,
      content: `
        <h2 style="color:#1c1917;margin:0 0 6px;font-size:20px;font-weight:700">
          You're invited to a private lesson
        </h2>
        <p style="color:#57534e;line-height:1.6;margin:0 0 18px;font-size:14px">
          ${greeting} — <strong>${safeBooker}</strong> has invited you to join them
          for a private lesson at <strong>${escapeHtml(clubName)}</strong>.
        </p>
        <div style="background:#F5F3EE;border-radius:10px;padding:16px;margin:0 0 20px">
          <p style="color:#1c1917;margin:0 0 6px;font-weight:600;font-size:15px">
            ${safeLessonTitle}
          </p>
          ${
            whenLabel
              ? `<p style="color:#57534e;margin:0;font-size:14px;line-height:1.5">${escapeHtml(whenLabel)}</p>`
              : `<p style="color:#a8a29e;margin:0;font-size:13px;line-height:1.5">Your time will be confirmed once you accept the invite.</p>`
          }
        </div>
        <a href="${inviteUrl}" style="display:inline-block;background:${brand};color:#ffffff;padding:13px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px;letter-spacing:0.01em">
          Confirm &amp; add your info
        </a>
        <p style="color:#a8a29e;font-size:12px;margin:18px 0 0;line-height:1.5">
          We'll ask for a few quick details (name, phone, waiver acknowledgement)
          so the club has what they need on the day.
        </p>
      `,
    }),
  });
}
