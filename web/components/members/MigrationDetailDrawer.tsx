// Phase 4.5.8 — the migration detail drawer.
//
// ── Why a drawer and not a page ──────────────────────────────────────────────
// Staff work the migration queue with a filter applied — "never invited", or
// step 2. Navigating to a full page and back loses that filter, so the work
// becomes: filter, open, go back, re-filter, scroll, open the next one. The
// drawer keeps the queue and its filter behind it.
//
// ── The two things this screen exists to say ─────────────────────────────────
// 1. WHERE someone is, with the receipts: seven steps, each completed one
//    stamped with when it happened and who did it. "Invitation sent" with no
//    date is the reason staff re-send invitations people already have.
// 2. WHAT WE IMPORTED versus what is here now, side by side, so a wrong price
//    or a mangled name is visible rather than something you go looking for.
//    The "as imported" column is headed with the owner's OWN label for their
//    previous system — never a hardcoded vendor name.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Copy, ExternalLink, Lock, Send, X } from "lucide-react";
import { MembershipPill } from "@/components/members/MemberTracks";

type Meter = {
  step: number;
  total: number;
  applicable: boolean;
  waitingOn: "NOBODY" | "STAFF" | "MEMBER" | "BLOCKED";
  steps: { index: number; label: string; done: boolean; current: boolean }[];
};

type Payload = {
  member: Record<string, unknown> & {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    dateOfBirth: string | null;
    guardianName: string | null;
    guardianEmail: string | null;
    guardianPhone: string | null;
    profileImageUrl: string | null;
    legacyMemberId: string | null;
    legacyMembershipName: string | null;
    legacyMembershipPrice: string | number | null;
    legacyBillingFrequency: string | null;
    importedAt: string | null;
    migrationStatus: string | null;
    activationEmailSentAt: string | null;
    activationEmailSendCount: number | null;
  };
  activationUrl: string | null;
  sourceLabel: string | null;
  meter: Meter | null;
  events: { id: string; type: string; message: string | null; at: string; actor: string | null }[];
};

function fmt(v: string | null | undefined): string {
  if (!v) return "—";
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(v: string): string {
  return new Date(v).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** Which event type evidences which step. Ordinal, like the meter itself. */
const STEP_EVIDENCE: Record<number, string[]> = {
  1: ["IMPORTED"],
  3: ["ACTIVATION_SENT", "REMINDER_SENT"],
  5: ["ACTIVATED"],
  7: ["COMPLETED"],
};

export function MigrationDetailDrawer({
  memberId,
  canEdit,
  onClose,
  onChanged,
}: {
  memberId: string;
  canEdit: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const [d, setD] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch(`/api/members/migration/${memberId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not load this member");
        return r.json();
      })
      .then(setD)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load this member"));
  }, [memberId]);

  useEffect(() => load(), [load]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function resend() {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch(`/api/members/${memberId}/resend-invitation`, { method: "POST" });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "Could not send the invitation");
      setNote(j.isReminder ? "Reminder sent." : "Invitation sent.");
      load();
      onChanged?.();
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const m = d?.member;
  const meter = d?.meter;
  const asImportedHeader = d?.sourceLabel ? `As imported from ${d.sourceLabel}` : "As imported";

  // Field · as imported · in AthletixOS. Only rows where we actually HAVE an
  // imported value — an empty left column teaches nothing.
  const rows: { label: string; imported: string | null; current: string | null; locked?: boolean }[] = m
    ? [
        { label: "Name", imported: null, current: `${m.firstName} ${m.lastName}` },
        { label: "Legacy ID", imported: m.legacyMemberId, current: null },
        { label: "Email", imported: null, current: m.email },
        { label: "Phone", imported: null, current: m.phone },
        { label: "Birthday", imported: null, current: fmt(m.dateOfBirth), locked: true },
        { label: "Guardian", imported: null, current: m.guardianName },
        { label: "Guardian email", imported: null, current: m.guardianEmail },
        { label: "Plan", imported: m.legacyMembershipName, current: null },
        {
          label: "Price",
          imported: m.legacyMembershipPrice != null ? `$${Number(m.legacyMembershipPrice).toFixed(2)}` : null,
          current: null,
        },
        { label: "Billing", imported: m.legacyBillingFrequency, current: null },
      ].filter((r) => r.imported || r.current)
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col bg-surface md:max-w-[664px] md:rounded-l-[14px]"
        style={{ boxShadow: "0 18px 44px rgba(17,17,17,.13)" }}
      >
        {error ? (
          <div className="p-6">
            <p className="text-sm text-text-primary">{error}</p>
            <button onClick={onClose} className="mt-3 rounded-lg border border-app-border px-3 py-2 text-sm">
              Close
            </button>
          </div>
        ) : !d || !m ? (
          <div className="p-6 text-sm text-text-muted">Loading…</div>
        ) : (
          <>
            {/* ── Header ─────────────────────────────────────────────── */}
            <div className="flex items-start justify-between gap-3 border-b border-app-border p-4">
              <div className="flex min-w-0 gap-3">
                <div className="flex h-[38px] w-[38px] shrink-0 items-center justify-center overflow-hidden rounded-full bg-app-border text-[13px] font-semibold text-text-primary">
                  {m.profileImageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.profileImageUrl} alt="" className="h-full w-full object-cover" />
                  ) : (
                    `${m.firstName[0] ?? ""}${m.lastName[0] ?? ""}`.toUpperCase()
                  )}
                </div>
                <div className="min-w-0">
                  <h2 className="truncate text-[16px] font-semibold text-text-primary">
                    {m.firstName} {m.lastName}
                  </h2>
                  <p className="mt-0.5 text-[12px] text-text-muted">
                    {meter?.applicable ? `Step ${meter.step} of ${meter.total}` : "Not a migration member"}
                    {m.importedAt ? ` · imported ${fmt(m.importedAt)}` : ""}
                    {m.legacyMemberId ? ` · legacy ${m.legacyMemberId}` : ""}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <Link
                  href={`/dashboard/members/${m.id}`}
                  className="inline-flex min-h-[34px] items-center gap-1.5 rounded-lg border border-app-border px-2.5 text-[12.5px] text-text-primary hover:bg-app-bg"
                >
                  <ExternalLink className="h-3.5 w-3.5" /> Open full profile
                </Link>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-app-bg"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {note && (
                <p className="mb-3 rounded-lg px-3 py-2 text-[12.5px]" style={{ background: "var(--color-chip-surface)" }}>
                  {note}
                </p>
              )}

              {/* ── Progress timeline ────────────────────────────────── */}
              {meter?.applicable && (
                <section>
                  <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Progress</h3>
                  <ol className="flex flex-col">
                    {meter.steps.map((s, i) => {
                      const evidence = d.events.filter((e) => (STEP_EVIDENCE[s.index] ?? []).includes(e.type)).slice(-1)[0];
                      const isInvite = s.index === 3;
                      return (
                        <li key={s.index} className="flex gap-3">
                          <div className="flex flex-col items-center">
                            <span
                              className="mt-1 h-[11px] w-[11px] shrink-0 rounded-full"
                              style={
                                s.done
                                  ? { background: "var(--color-charcoal)" }
                                  : s.current
                                    ? {
                                        background: "#fff",
                                        border: "2px solid var(--color-orange-accent)",
                                        boxShadow: "0 0 0 3px rgba(255,106,0,.18)",
                                      }
                                    : { background: "#fff", border: "2px solid var(--color-app-border)" }
                              }
                            />
                            {i < meter.steps.length - 1 && (
                              <span
                                className="w-[2px] flex-1"
                                style={{
                                  background: s.done ? "var(--color-charcoal)" : "var(--color-app-border)",
                                  minHeight: 20,
                                }}
                              />
                            )}
                          </div>
                          <div className="min-w-0 flex-1 pb-4">
                            <div className={`text-[13px] ${s.done || s.current ? "text-text-primary" : "text-text-muted"}`}>
                              {s.index}. {s.label}
                            </div>
                            {/* Receipts on the done steps. A step marked done
                                with no date is what makes staff re-send. */}
                            {s.done && evidence && (
                              <div className="mt-0.5 text-[11.5px] text-text-muted">
                                {fmtDateTime(evidence.at)}
                                {evidence.actor ? ` · ${evidence.actor}` : ""}
                              </div>
                            )}
                            {!s.done && !s.current && (
                              <div className="mt-0.5 text-[11.5px] text-text-muted">
                                {s.index <= 3 ? "Hasn't happened yet." : "Happens after the earlier steps."}
                              </div>
                            )}
                            {/* Contextual actions live on the step they belong
                                to, not in a toolbar far from the thing. */}
                            {isInvite && canEdit && (
                              <div className="mt-1.5 flex flex-wrap gap-1.5">
                                <button
                                  onClick={resend}
                                  disabled={busy}
                                  className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-app-border px-2.5 text-[12px] text-text-primary hover:bg-app-bg disabled:opacity-60"
                                >
                                  <Send className="h-3 w-3" />
                                  {m.activationEmailSentAt ? "Resend now" : "Send now"}
                                </button>
                                {d.activationUrl && (
                                  <button
                                    onClick={() => {
                                      navigator.clipboard
                                        ?.writeText(d.activationUrl as string)
                                        .then(() => setNote("Invite link copied."))
                                        .catch(() => setNote("Could not copy the link."));
                                    }}
                                    className="inline-flex min-h-[32px] items-center gap-1.5 rounded-lg border border-app-border px-2.5 text-[12px] text-text-primary hover:bg-app-bg"
                                  >
                                    <Copy className="h-3 w-3" /> Copy invite link
                                  </button>
                                )}
                                <Link
                                  href={`/dashboard/members/${m.id}?edit=1`}
                                  className="inline-flex min-h-[32px] items-center rounded-lg border border-app-border px-2.5 text-[12px] text-text-primary hover:bg-app-bg"
                                >
                                  Send to a different email
                                </Link>
                                {m.activationEmailSendCount ? (
                                  <span className="self-center text-[11.5px] text-text-muted">
                                    sent {m.activationEmailSendCount}×
                                  </span>
                                ) : null}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </section>
              )}

              {/* ── Imported data ────────────────────────────────────── */}
              <section className="mt-4">
                <h3 className="mb-2 text-[13px] font-semibold text-text-primary">Imported data</h3>
                <div className="overflow-hidden rounded-[10px] border border-app-border">
                  <div
                    className="grid grid-cols-[110px_1fr] gap-x-3 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.05em] text-text-muted md:grid-cols-[118px_1fr_1fr]"
                    style={{ background: "var(--color-table-chrome)" }}
                  >
                    <span>Field</span>
                    <span className="truncate" title={asImportedHeader}>
                      {asImportedHeader}
                    </span>
                    <span className="hidden md:block">In AthletixOS</span>
                  </div>
                  {rows.map((r) => (
                    <div
                      key={r.label}
                      className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-0.5 border-t px-3 py-2 text-[12.5px] md:grid-cols-[118px_1fr_1fr]"
                      style={{ borderColor: "var(--color-hairline)" }}
                    >
                      <span className="text-text-muted">{r.label}</span>
                      <span className="min-w-0 break-words text-text-primary">{r.imported ?? "—"}</span>
                      <span className="col-start-2 min-w-0 break-words text-text-primary md:col-start-3">
                        {r.locked && <Lock className="mr-1 inline h-3 w-3 text-text-muted" />}
                        <span className="md:hidden text-text-muted">now: </span>
                        {r.current ?? "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>

            {/* ── Footer ─────────────────────────────────────────────── */}
            <div className="border-t border-app-border p-4">
              <p className="mb-2 text-[11.5px] text-text-muted">
                Nothing here charges anyone. Billing starts only when the member activates and an owner approves it.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/dashboard/members/${m.id}/billing`}
                  className="inline-flex min-h-[38px] items-center rounded-lg border border-app-border px-3 text-sm text-text-primary hover:bg-app-bg"
                >
                  Assign a different plan
                </Link>
                {canEdit && (
                  <button
                    onClick={resend}
                    disabled={busy}
                    className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg bg-brand px-3 text-sm font-medium text-white hover:bg-brand-hover disabled:opacity-60"
                  >
                    <Send className="h-4 w-4" /> {busy ? "Sending…" : "Resend invitation"}
                  </button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
