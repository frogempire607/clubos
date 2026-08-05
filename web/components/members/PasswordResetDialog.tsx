// Phase 4.5.5 — password reset, three states.
//
// ── The copy is FINAL ────────────────────────────────────────────────────────
// The handoff says "Copy is final; use verbatim." It is reproduced here word
// for word, and scripts/member-ui-tests.ts asserts the key sentences render.
// If you are tempted to reword something, the sentence is doing work:
//
//   "It works once and expires in 60 minutes"  — pre-empts the #1 support call
//   "You won't see the new password"           — staff ask; the answer is never
//   "this doesn't change ... membership,
//    bookings or migration status"             — the actual fear behind the ask
//   "Sent as <staff> and recorded"             — attribution, said out loud
//
// ── What this component does NOT do ──────────────────────────────────────────
// It never sets a password and never displays one. It calls the existing
// /api/auth/reset-password machinery, which is single-use by construction —
// this sub-phase is UI-only per plan.md 4.5.5.

"use client";

import { useEffect, useState } from "react";
import { Check, KeyRound, MailX, X } from "lucide-react";

export type ResetState = "confirm" | "sending" | "sent" | "no-email" | "error";

export function PasswordResetDialog({
  state,
  memberName,
  email,
  isGuardianEmail,
  staffName,
  sentAt,
  cooldownSeconds = 60,
  bounceHistory,
  errorMessage,
  onClose,
  onSend,
  onUseDifferentEmail,
  onAddEmail,
  onLinkGuardian,
}: {
  state: ResetState;
  memberName: string;
  email: string | null;
  /** True when the address belongs to a guardian rather than the member. */
  isGuardianEmail?: boolean;
  staffName: string;
  sentAt?: Date;
  cooldownSeconds?: number;
  bounceHistory?: { at: string; address: string; reason: string }[];
  errorMessage?: string;
  onClose: () => void;
  onSend: () => void;
  onUseDifferentEmail?: () => void;
  onAddEmail?: () => void;
  onLinkGuardian?: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full rounded-t-2xl bg-surface p-5 sm:max-w-[412px] sm:rounded-[14px]"
        style={{ boxShadow: "0 18px 44px rgba(17,17,17,.13)" }}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <IconTile state={state} />
          <button onClick={onClose} aria-label="Close" className="-mr-1 -mt-1 flex h-9 w-9 items-center justify-center rounded-lg hover:bg-app-bg">
            <X className="h-4 w-4" />
          </button>
        </div>

        {state === "no-email" ? (
          <NoEmail
            memberName={memberName}
            bounceHistory={bounceHistory}
            onAddEmail={onAddEmail}
            onLinkGuardian={onLinkGuardian}
            onClose={onClose}
          />
        ) : state === "sent" ? (
          <Sent
            email={email}
            sentAt={sentAt}
            cooldownSeconds={cooldownSeconds}
            onUseDifferentEmail={onUseDifferentEmail}
            onSend={onSend}
            onClose={onClose}
          />
        ) : (
          <Confirm
            state={state}
            memberName={memberName}
            email={email}
            isGuardianEmail={isGuardianEmail}
            staffName={staffName}
            errorMessage={errorMessage}
            onClose={onClose}
            onSend={onSend}
          />
        )}
      </div>
    </div>
  );
}

function IconTile({ state }: { state: ResetState }) {
  if (state === "sent") {
    return (
      <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px]" style={{ background: "var(--color-success-surface)" }}>
        <Check className="h-5 w-5" style={{ color: "var(--color-success-icon)" }} strokeWidth={2.5} />
      </div>
    );
  }
  if (state === "no-email") {
    return (
      <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px]" style={{ background: "var(--color-danger-surface)" }}>
        <MailX className="h-5 w-5" style={{ color: "var(--color-danger-text)" }} />
      </div>
    );
  }
  return (
    <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px]" style={{ background: "rgba(109,93,246,.10)" }}>
      <KeyRound className="h-5 w-5 text-brand" />
    </div>
  );
}

function Confirm({
  state,
  memberName,
  email,
  isGuardianEmail,
  staffName,
  errorMessage,
  onClose,
  onSend,
}: {
  state: ResetState;
  memberName: string;
  email: string | null;
  isGuardianEmail?: boolean;
  staffName: string;
  errorMessage?: string;
  onClose: () => void;
  onSend: () => void;
}) {
  return (
    <>
      <h2 className="text-[15px] font-semibold text-text-primary">Send password reset link?</h2>
      <p className="mt-1.5 text-[13px] text-text-muted">
        We&rsquo;ll email a secure link to <strong className="font-medium text-text-primary">{email}</strong>
        {isGuardianEmail && <> &mdash; {memberName}&rsquo;s guardian</>}. It works once and expires in 60 minutes.
      </p>
      <p className="mt-3 rounded-lg p-2.5 text-[12.5px] text-text-muted" style={{ background: "var(--color-table-chrome)" }}>
        You won&rsquo;t see the new password, and this doesn&rsquo;t change {memberName}&rsquo;s membership, bookings or
        migration status. Sent as <strong className="font-medium text-text-primary">{staffName}</strong> and recorded in
        their activity log.
      </p>
      {state === "error" && errorMessage && (
        <p className="mt-2 rounded-lg p-2.5 text-[12.5px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
          {errorMessage}
        </p>
      )}
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button onClick={onClose} className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm text-text-primary sm:min-h-[38px]">
          Cancel
        </button>
        <button
          onClick={onSend}
          disabled={state === "sending"}
          className="min-h-[44px] rounded-lg bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60 sm:min-h-[38px]"
        >
          {state === "sending" ? "Sending…" : "Send link"}
        </button>
      </div>
    </>
  );
}

function Sent({
  email,
  sentAt,
  cooldownSeconds,
  onUseDifferentEmail,
  onSend,
  onClose,
}: {
  email: string | null;
  sentAt?: Date;
  cooldownSeconds: number;
  onUseDifferentEmail?: () => void;
  onSend: () => void;
  onClose: () => void;
}) {
  // Live countdown. Starts from the prop so a server render shows the initial
  // value rather than 0 — the disabled state has to be legible immediately.
  const [left, setLeft] = useState(cooldownSeconds);
  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setLeft((n) => (n <= 1 ? 0 : n - 1)), 1000);
    return () => clearInterval(t);
  }, [left]);

  const at = sentAt ?? new Date();
  const expires = new Date(at.getTime() + 60 * 60 * 1000);
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const mm = String(Math.floor(left / 60));
  const ss = String(left % 60).padStart(2, "0");

  return (
    <>
      <h2 className="text-[15px] font-semibold text-text-primary">Password reset email sent successfully</h2>
      <p className="mt-1.5 text-[13px] text-text-muted">
        Sent to <strong className="font-medium text-text-primary">{email}</strong> at {time(at)}. The link expires at{" "}
        {time(expires)}.
      </p>
      <p className="mt-3 rounded-lg p-2.5 text-[12.5px] text-text-muted" style={{ background: "var(--color-table-chrome)" }}>
        If it hasn&rsquo;t arrived in a few minutes, ask them to check spam. You can also{" "}
        <button onClick={onUseDifferentEmail} className="text-brand underline">
          send to a different email
        </button>
        .
      </p>
      <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          disabled={left > 0}
          onClick={onSend}
          className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm text-text-primary transition-colors disabled:cursor-not-allowed disabled:text-[#9CA3AF] sm:min-h-[38px]"
        >
          {left > 0 ? `Resend in ${mm}:${ss}` : "Resend"}
        </button>
        <button onClick={onClose} className="min-h-[44px] rounded-lg bg-brand px-4 text-sm font-medium text-white sm:min-h-[38px]">
          Done
        </button>
      </div>
    </>
  );
}

function NoEmail({
  memberName,
  bounceHistory,
  onAddEmail,
  onLinkGuardian,
  onClose,
}: {
  memberName: string;
  bounceHistory?: { at: string; address: string; reason: string }[];
  onAddEmail?: () => void;
  onLinkGuardian?: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <h2 className="text-[15px] font-semibold text-text-primary">This member does not have an email address on file</h2>
      <p className="mt-1.5 text-[13px] text-text-muted">
        {memberName} has no email, and no guardian is linked to their account &mdash; so there&rsquo;s nowhere to send a
        reset link.
      </p>
      {bounceHistory && bounceHistory.length > 0 && (
        <div
          className="mt-3 max-h-40 overflow-y-auto rounded-lg p-2.5 text-[12.5px]"
          style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}
        >
          <div className="mb-1 font-medium">Previous attempts</div>
          <ul className="space-y-0.5">
            {bounceHistory.map((b, i) => (
              <li key={i}>
                {b.at} · {b.address} · {b.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-4 flex flex-col gap-2">
        <button onClick={onAddEmail} className="min-h-[44px] rounded-lg bg-brand px-4 text-sm font-medium text-white">
          Add an email address
        </button>
        <button onClick={onLinkGuardian} className="min-h-[44px] rounded-lg border border-app-border px-4 text-sm text-text-primary">
          Link a guardian
        </button>
        <button onClick={onClose} className="min-h-[44px] rounded-lg px-4 text-sm text-text-muted">
          Close
        </button>
      </div>
    </>
  );
}
