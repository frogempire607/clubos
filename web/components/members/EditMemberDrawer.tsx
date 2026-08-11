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
//
// ── Session 4 ────────────────────────────────────────────────────────────────
// D-4: the field list is no longer defined here. It comes from
// `lib/memberEditableFields.ts`, shared with `MemberModal`, so the drawer can
// edit everything the modal can — address, gender, status, tags, notes, custom
// fields, photo — and cannot silently fall behind when a field is added.
//
// D-0: when the member owns their own portal login, changing the email MOVES
// THAT LOGIN. That is a different act from correcting a contact address and the
// drawer says which one is about to happen, before save, naming the current
// sign-in address.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { History, KeyRound, Lock, X } from "lucide-react";
import ImageUpload from "@/components/ImageUpload";
import {
  MEMBER_EDITABLE_FIELDS,
  MEMBER_FIELD_GROUPS,
  type MemberEditableField,
} from "@/lib/memberEditableFields";

export type EditableCustomField = { id: string; label: string; fieldType: string; options: string };

export type EditableMember = {
  id: string;
  /** Bespoke: rendered by the upload widget, not the shared field renderer. */
  profileImageUrl: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  gender?: string | null;
  streetAddress?: string | null;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  status?: string | null;
  tags?: string | null;
  notes?: string | null;
  customFieldValues?: string | null;
  guardianName: string | null;
  guardianEmail: string | null;
  guardianPhone: string | null;
  guardianRelationship?: string | null;
  isMinor: boolean;
  /** Values that arrived in the import, so a correction can be shown + reverted. */
  imported?: Record<string, { value: string; correctedBy?: string; correctedAt?: string }>;
  midMigration: boolean;
  hasPendingInvitation: boolean;
  /**
   * D-0. The address this person actually signs in with, or null when they have
   * no login of their own — which is the normal case for a minor whose guardian
   * holds the account. `Member.userId` is the member's OWN login and nothing
   * else; a guardian is linked through `MemberGuardianUser`. So "no own login"
   * genuinely means an email edit here cannot touch anybody's sign-in.
   */
  loginEmail?: string | null;
  /** Who holds the account when the member does not (for the copy below). */
  accountHolderName?: string | null;
};

export function EditMemberDrawer({
  member,
  staffName,
  customFields = [],
  saving,
  error,
  onClose,
  onSave,
  onSendReset,
  onCopyPortalLink,
}: {
  member: EditableMember;
  staffName: string;
  customFields?: EditableCustomField[];
  saving?: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (patch: Record<string, unknown>) => void;
  onSendReset: () => void;
  onCopyPortalLink: () => void;
}) {
  const asRecord = member as unknown as Record<string, unknown>;

  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const d: Record<string, string> = {};
    for (const f of MEMBER_EDITABLE_FIELDS) {
      const v = asRecord[f.key];
      d[f.key] = v == null ? "" : String(v);
    }
    return d;
  });
  const [isMinor, setIsMinor] = useState(member.isMinor);
  // `profileImageUrl` is listed in MEMBER_BESPOKE_FIELDS as "needs an upload
  // widget" — it was declared there and then never rendered, so the one field
  // that list exists to stop being forgotten was forgotten. It is part of
  // "everything except birthday and password".
  const [photo, setPhoto] = useState<string>(member.profileImageUrl ?? "");
  const [customValues, setCustomValues] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(member.customFieldValues || "{}");
    } catch {
      return {};
    }
  });

  // ── Losing typed edits to a stray click ─────────────────────────────────
  //
  // Reported as "the edit drawer disappears when I try to edit a field", and
  // reproduced in a browser: this is a right-hand panel inside a FULL-SCREEN
  // backdrop, so at 1280px the leftmost 720px — 56% of the window — closes it.
  // Reaching for a field and landing slightly wide discarded everything typed,
  // with no warning and nothing to undo it. Esc did the same.
  //
  // Typing itself was never the trigger; programmatic input and real keystrokes
  // across text, select and textarea all left the drawer mounted. It was always
  // the click that missed.
  //
  // Closing is still one click. It just asks first, and only when there is
  // something to lose, so open-look-close is unchanged.
  const dirty =
    MEMBER_EDITABLE_FIELDS.some((f) => {
      const original = asRecord[f.key];
      return (draft[f.key] ?? "") !== (original == null ? "" : String(original));
    }) ||
    isMinor !== member.isMinor ||
    photo !== (member.profileImageUrl ?? "") ||
    JSON.stringify(customValues) !==
      JSON.stringify((() => { try { return JSON.parse(member.customFieldValues || "{}"); } catch { return {}; } })());

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm("Discard your unsaved changes to this member?")) return;
    onClose();
  }, [dirty, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [requestClose]);

  const emailChanged = (draft.email || "") !== (member.email || "");
  const ownsLogin = !!member.loginEmail;

  // Everything except the locked block, always.
  //
  // The first cut gated this on the club's `memberFormConfig`, and browser
  // testing immediately showed why that is wrong: the default config enables
  // only athlete-name and email, so the drawer rendered three fields and Julian
  // still could not edit an address. That config describes what the INTAKE form
  // asks a new member for. It is not a statement about what a staffer may
  // repair on an existing record — and a field switched off after import is
  // exactly the one holding data nobody can otherwise reach.
  //
  // `minorOnly` is the only filter, because guardian fields on an adult are
  // meaningless rather than merely unasked-for.
  const visible = useMemo(
    () => MEMBER_EDITABLE_FIELDS.filter((f) => !(f.minorOnly && !isMinor)),
    [isMinor],
  );

  function set(k: string, v: string) {
    setDraft((d) => ({ ...d, [k]: v }));
  }

  function submit() {
    const patch: Record<string, unknown> = {};
    for (const f of MEMBER_EDITABLE_FIELDS) {
      if (f.minorOnly && !isMinor) continue;
      const before = asRecord[f.key];
      const original = before == null ? "" : String(before);
      const next = draft[f.key] ?? "";
      // `tags` is a non-null column with a "" default — sending null 400s.
      if (next !== original) patch[f.key] = next === "" ? (f.key === "tags" ? "" : null) : next;
    }
    if (isMinor !== member.isMinor) patch.isMinor = isMinor;
    if (photo !== (member.profileImageUrl ?? "")) patch.profileImageUrl = photo || null;
    const originalCustom = (() => {
      try {
        return JSON.stringify(JSON.parse(member.customFieldValues || "{}"));
      } catch {
        return "{}";
      }
    })();
    if (JSON.stringify(customValues) !== originalCustom) patch.customFieldValues = customValues;
    onSave(patch);
  }

  const age = member.dateOfBirth ? ageOf(member.dateOfBirth) : null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={requestClose} role="dialog" aria-modal="true">
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
          <button onClick={requestClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center rounded-lg hover:bg-app-bg">
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

          {MEMBER_FIELD_GROUPS.map((g) => {
            const fields = visible.filter((f) => f.group === g.id);
            if (!fields.length) return null;
            return (
              <Group key={g.id} title={g.title}>
                {g.id === "identity" && (
                  <div>
                    <span className="mb-[5px] block text-[12px] font-medium text-text-primary">Photo</span>
                    <ImageUpload label="" value={photo || null} onChange={(url) => setPhoto(url ?? "")} />
                  </div>
                )}
                {fields.map((f) => (
                  <FieldRow
                    key={f.key}
                    f={f}
                    value={draft[f.key] ?? ""}
                    imported={member.imported?.[f.key]}
                    onChange={set}
                  />
                ))}

                {/* ── D-0: which address is about to change ───────────────── */}
                {g.id === "contact" && emailChanged && (
                  <EmailConsequence
                    ownsLogin={ownsLogin}
                    loginEmail={member.loginEmail ?? null}
                    accountHolderName={member.accountHolderName ?? null}
                    firstName={member.firstName}
                    nextEmail={draft.email ?? ""}
                    hasPendingInvitation={member.hasPendingInvitation}
                  />
                )}

                {/* The minor toggle gates the relationship group, so it belongs
                    at the end of Identity where it is read before that group. */}
                {g.id === "identity" && (
                  <label className="flex min-h-[44px] cursor-pointer items-center gap-2.5 text-[13px] text-text-primary">
                    <input
                      type="checkbox"
                      checked={isMinor}
                      onChange={(e) => setIsMinor(e.target.checked)}
                      className="h-4 w-4 accent-current"
                    />
                    Minor — guardian details required
                    {member.dateOfBirth && (
                      <span className="text-[11.5px] text-text-muted">
                        (date of birth decides this on save)
                      </span>
                    )}
                  </label>
                )}
              </Group>
            );
          })}

          {customFields.length > 0 && (
            <Group title="Custom fields">
              {customFields.map((cf) => (
                <label key={cf.id} className="block">
                  <span className="mb-[5px] block text-[12px] font-medium text-text-primary">{cf.label}</span>
                  {cf.fieldType === "SELECT" ? (
                    <select
                      value={customValues[cf.id] ?? ""}
                      onChange={(e) => setCustomValues({ ...customValues, [cf.id]: e.target.value })}
                      className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
                    >
                      <option value="">—</option>
                      {(cf.options || "").split(",").map((o) => o.trim()).filter(Boolean).map((o) => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={cf.fieldType === "NUMBER" ? "number" : cf.fieldType === "DATE" ? "date" : "text"}
                      value={customValues[cf.id] ?? ""}
                      onChange={(e) => setCustomValues({ ...customValues, [cf.id]: e.target.value })}
                      className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                  )}
                </label>
              ))}
            </Group>
          )}

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
              <button onClick={onSendReset} className="mt-2 inline-flex min-h-[44px] items-center gap-1.5 rounded-lg border border-app-border px-3 text-[12.5px] text-text-primary">
                <KeyRound className="h-3.5 w-3.5" />
                Send password reset link
              </button>
            </div>
          </div>

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
            <button onClick={requestClose} className="min-h-[44px] flex-1 rounded-lg border border-app-border px-4 text-sm text-text-primary sm:min-h-[38px] sm:flex-none">
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

/**
 * D-0 — say which address is about to change, before the save.
 *
 * Two genuinely different acts share one input:
 *
 *  · The member owns their login → the contact address and the sign-in address
 *    are the same address, and changing it moves sign-in. Both the old and the
 *    new address are emailed about it.
 *  · A guardian holds the account → this is contact information only. Moving
 *    the guardian's login from a child's profile would change the address the
 *    parent signs in with and, because one guardian holds several children,
 *    would do it from a page that names only one of them. Never.
 */
function EmailConsequence({
  ownsLogin,
  loginEmail,
  accountHolderName,
  firstName,
  nextEmail,
  hasPendingInvitation,
}: {
  ownsLogin: boolean;
  loginEmail: string | null;
  accountHolderName: string | null;
  firstName: string;
  nextEmail: string;
  hasPendingInvitation: boolean;
}) {
  if (ownsLogin) {
    return (
      <p
        className="rounded-lg p-2.5 text-[12px] leading-relaxed"
        style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}
      >
        {firstName} signs in with <strong>{loginEmail}</strong>. Saving moves their sign-in to{" "}
        <strong>{nextEmail || "the new address"}</strong> as well as their contact details — their password does not
        change, and we email both addresses so they know.
      </p>
    );
  }
  return (
    <p className="rounded-lg p-2.5 text-[12px] leading-relaxed" style={{ background: "var(--color-info-surface)" }}>
      This is {firstName}&rsquo;s contact email only. {accountHolderName ?? "Their guardian"} holds the portal account,
      so this does <strong>not</strong> change how anyone signs in.
      {hasPendingInvitation && " Their pending invitation will now point at this address — it will not be re-sent."}
    </p>
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
  f: MemberEditableField;
  value: string;
  imported?: { value: string; correctedBy?: string; correctedAt?: string };
  onChange: (k: string, v: string) => void;
}) {
  const corrected = imported && imported.value !== value;
  const cls =
    "min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand";
  return (
    <label className="block">
      <span className="mb-[5px] block text-[12px] font-medium text-text-primary">{f.label}</span>
      {f.input === "select" ? (
        <select value={value} onChange={(e) => onChange(f.key, e.target.value)} className={cls}>
          {(f.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      ) : f.input === "textarea" ? (
        <textarea rows={3} value={value} onChange={(e) => onChange(f.key, e.target.value)} className={cls} />
      ) : (
        <input type={f.input} value={value} onChange={(e) => onChange(f.key, e.target.value)} className={cls} />
      )}
      {f.helper && <span className="mt-1 block text-[11px] text-text-muted">{f.helper}</span>}
      {corrected && (
        // The corrected-field affordance. Showing the original is what lets a
        // second staffer tell a typo fix from a data-entry mistake.
        <span className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-text-muted">
          <History className="h-3 w-3" />
          Imported as &ldquo;{imported!.value}&rdquo;
          {imported!.correctedBy && <> · corrected by {imported!.correctedBy}</>}
          {imported!.correctedAt && <> {imported!.correctedAt}</>}
          <button
            onClick={(e) => { e.preventDefault(); onChange(f.key, imported!.value); }}
            className="min-h-[24px] text-brand underline"
          >
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
