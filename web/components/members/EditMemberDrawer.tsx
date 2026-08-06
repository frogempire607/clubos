// Phase 4.5.4 — the edit-member drawer.
//
// ── Three rules from the handoff, all of them load-bearing ───────────────────
//
// 1. Editing an email RE-POINTS the pending invitation, never silently
//    re-sends. Staff fixing a typo do not expect to spam the parent, and an
//    invisible send burns a delivery the Blocked derivation is counting.
// 2. Edits never reset migration progress. The info strip says so out loud,
//    because the fear that "fixing the import will make them start over" is
//    exactly what stopped staff from fixing anything.
// 3. Every write is attributed. Footer says whose name it lands under before
//    you press save, not after.
//
// ── The locked block ─────────────────────────────────────────────────────────
// Birthday and password sit in a visually distinct, dashed, non-editable block
// headed NOT EDITABLE BY ANYONE AT THE CLUB. Greying the fields out was not
// enough on its own — staff read a grey field as "I lack permission" and filed
// a ticket. Naming who CAN change it, and where, ends that.

"use client";

import { useEffect, useState } from "react";
import { History, Lock, X } from "lucide-react";

export type EditableMember = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  isMinor: boolean;
  /** Values that arrived in the import, so a correction can be shown + reverted. */
  imported?: Record<string, { value: string; correctedBy?: string; correctedAt?: string }>;
  midMigration: boolean;
  hasPendingInvitation: boolean;
};

type Field = { key: keyof EditableMember & string; label: string; type?: string; helper?: string };

const IDENTITY: Field[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
];
const CONTACT: Field[] = [
  { key: "email", label: "Email", type: "email", helper: "Changing this re-points any pending invitation. It does not re-send it." },
  { key: "phone", label: "Phone", type: "tel" },
];
const RELATIONSHIP: Field[] = [
  { key: "guardianName", label: "Guardian name" },
  { key: "guardianEmail", label: "Guardian email", type: "email" },
  { key: "guardianPhone", label: "Guardian phone", type: "tel" },
];

export function EditMemberDrawer({
  member,
  staffName,
  saving,
  error,
  onClose,
  onSave,
  onSendReset,
  onCopyPortalLink,
}: {
  member: EditableMember;
  staffName: string;
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (patch: Record<string, string | null>) => void;
  onSendReset: () => void;
  onCopyPortalLink: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>(() => ({
    firstName: member.firstName ?? "",
    lastName: member.lastName ?? "",
    email: member.email ?? "",
    phone: member.phone ?? "",
    guardianName: member.guardianName ?? "",
    guardianEmail: member.guardianEmail ?? "",
    guardianPhone: member.guardianPhone ?? "",
  }));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const emailChanged = (draft.email || "") !== (member.email || "");

  function set(k: string, v: string) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function submit() {
    const patch: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(draft)) {
      const original = (member as unknown as Record<string, string | null>)[k] ?? "";
      if (v !== original) patch[k] = v === "" ? null : v;
    }
    onSave(patch);
  }

  const age = member.dateOfBirth ? ageOf(member.dateOfBirth) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose} role="dialog" aria-modal="true">
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full flex-col bg-surface md:max-w-[560px] md:rounded-l-[14px]"
        style={{ boxShadow: "var(--shadow-panel)" }}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-app-border p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-text-primary">
              Edit {member.firstName} {member.lastName}
            </h2>
            <p className="text-[12.5px] text-text-muted">Corrections save straight away and are logged against you.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-app-bg">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {member.midMigration && (
            <div className="mb-5 rounded-lg p-3 text-[12.5px] leading-relaxed" style={{ background: "var(--color-info-surface)" }}>
              <strong className="font-medium text-text-primary">{member.firstName}</strong> is{" "}
              <strong className="font-medium text-text-primary">mid-migration</strong>. Fix anything that came over wrong
              in the import — it saves straight away and won&rsquo;t restart their setup. Every change is attributed to
              you in migration activity.
            </div>
          )}

          <Group title="Identity">
            {IDENTITY.map((f) => (
              <FieldRow key={f.key} f={f} value={draft[f.key] ?? ""} imported={member.imported?.[f.key]} onChange={set} />
            ))}
          </Group>

          <Group title="Contact">
            {CONTACT.map((f) => (
              <FieldRow key={f.key} f={f} value={draft[f.key] ?? ""} imported={member.imported?.[f.key]} onChange={set} />
            ))}
            {emailChanged && member.hasPendingInvitation && (
              <p className="rounded-lg p-2.5 text-[12px]" style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}>
                Their pending invitation will now point at this address. It will <strong>not</strong> be re-sent — use
                Resend when you want it to go out.
              </p>
            )}
          </Group>

          {/* ── Locked block ─────────────────────────────────────────── */}
          <div className="mb-5 rounded-[10px] p-3.5" style={{ background: "var(--color-table-chrome)", border: "1px solid var(--color-inset-border)" }}>
            <div className="mb-2.5 flex items-center gap-1.5">
              <Lock className="h-3.5 w-3.5 text-text-muted" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">
                Not editable by anyone at the club
              </span>
            </div>

            <div className="mb-3">
              <div className="mb-1 text-[12px] font-medium text-text-primary">Birthday</div>
              <div
                className="flex min-h-[48px] items-center justify-between gap-2 rounded-lg px-3 py-2"
                style={{ background: "var(--color-inset-surface)", border: "1px dashed var(--color-inset-dashed)" }}
              >
                <span className="inline-flex items-center gap-2 text-[13px] text-text-primary">
                  <Lock className="h-3.5 w-3.5 text-text-muted" />
                  {member.dateOfBirth ? fmtDate(member.dateOfBirth) : "Not set"}
                </span>
                {age != null && <span className="text-[12px] text-text-muted">{age} years old</span>}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-muted">
                Birthdays set age brackets, waivers and minor rules.{" "}
                {member.guardianName ?? "Their guardian"} updates it in the member portal under Profile → Personal
                details.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={onCopyPortalLink} className="min-h-[44px] rounded-lg border border-app-border px-3 text-[12.5px] text-text-primary">
                  Copy portal link
                </button>
              </div>
            </div>

            <div>
              <div className="mb-1 text-[12px] font-medium text-text-primary">Password</div>
              <div
                className="flex min-h-[48px] items-center rounded-lg px-3 py-2 tracking-[0.3em] text-text-muted"
                style={{ background: "var(--color-inset-surface)", border: "1px dashed var(--color-inset-dashed)" }}
              >
                ••••••••
              </div>
              <p className="mt-1.5 text-[11.5px] text-text-muted">Never visible or settable by staff.</p>
              <button onClick={onSendReset} className="mt-2 min-h-[44px] rounded-lg border border-app-border px-3 text-[12.5px] text-text-primary">
                Send password reset link
              </button>
            </div>
          </div>

          <Group title="Relationship">
            {RELATIONSHIP.map((f) => (
              <FieldRow key={f.key} f={f} value={draft[f.key] ?? ""} imported={member.imported?.[f.key]} onChange={set} />
            ))}
          </Group>

          {error && (
            <p className="rounded-lg p-2.5 text-[12.5px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
              {error}
            </p>
          )}
        </div>

        {/* Footer */}
        <div
          className="flex flex-col gap-2 border-t border-app-border p-4 sm:flex-row sm:items-center sm:justify-between"
          style={{ background: "var(--color-table-chrome)", paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
        >
          <span className="text-[11.5px] text-text-muted">
            Saved as <strong className="font-medium text-text-primary">{staffName}</strong> · logged to migration activity
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="min-h-[44px] flex-1 rounded-lg border border-app-border px-4 text-sm text-text-primary sm:min-h-[38px] sm:flex-none">
              Cancel
            </button>
            <button
              onClick={submit}
              disabled={saving}
              className="min-h-[44px] flex-1 rounded-lg bg-brand px-4 text-sm font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-60 sm:min-h-[38px] sm:flex-none"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-text-muted">{title}</div>
      <div className="flex flex-col gap-3">{children}</div>
    </div>
  );
}

function FieldRow({
  f,
  value,
  imported,
  onChange,
}: {
  f: Field;
  value: string;
  imported?: { value: string; correctedBy?: string; correctedAt?: string };
  onChange: (k: string, v: string) => void;
}) {
  const corrected = imported && imported.value !== value;
  return (
    <label className="block">
      <span className="mb-[5px] block text-[12px] font-medium text-text-primary">{f.label}</span>
      <input
        type={f.type ?? "text"}
        value={value}
        onChange={(e) => onChange(f.key, e.target.value)}
        className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
      />
      {f.helper && <span className="mt-1 block text-[11px] text-text-muted">{f.helper}</span>}
      {corrected && (
        // The corrected-field affordance. Showing the original is what lets a
        // second staffer tell a typo fix from a data-entry mistake.
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
          <History className="h-3 w-3" />
          Imported as &ldquo;{imported!.value}&rdquo;
          {imported!.correctedBy && <> · corrected by {imported!.correctedBy}</>}
          {imported!.correctedAt && <> {imported!.correctedAt}</>}
          <button onClick={() => onChange(f.key, imported!.value)} className="min-h-[24px] text-brand underline">
            Revert
          </button>
        </span>
      )}
    </label>
  );
}

function fmtDate(v: string): string {
  return new Date(v).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function ageOf(dob: string): number | null {
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let a = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) a--;
  return a < 0 ? null : a;
}
