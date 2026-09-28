"use client";

// B21 — Personal info tab. Read view of the staff member's identity fields;
// "Edit" opens a Sheet (bottom sheet on phones) with ONE Save.
//
// Who saves where (the API enforces the same split):
//   · the staff member themself → PATCH /api/me/profile  (first, last, private phone)
//     — sign-in email and title are the owner's to change.
//   · a manager with canEditRecord → PATCH /api/staff/<id> (first, last, email, title, phone)
//   · anyone else → read-only.
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Lock, Pencil, RefreshCw } from "lucide-react";
import Sheet from "@/components/Sheet";
import type { StaffTabProps } from "@/components/staff/types";

type Draft = { firstName: string; lastName: string; email: string; title: string; phone: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorText(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => (typeof x === "string" ? x : (x as { message?: string })?.message)).filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return fallback;
}

function Row({
  label,
  value,
  icon,
  note,
}: {
  label: string;
  value: React.ReactNode;
  icon: "edit" | "shared" | "lock" | null;
  note?: React.ReactNode;
}) {
  const Icon = icon === "edit" ? Pencil : icon === "shared" ? RefreshCw : icon === "lock" ? Lock : null;
  return (
    <div className="flex flex-col gap-0.5 border-b py-3 last:border-b-0 sm:flex-row sm:gap-4" style={{ borderColor: "var(--color-hairline)" }}>
      <dt className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-text-muted sm:w-[200px]">
        {Icon && <Icon className="h-3 w-3" aria-hidden />}
        {label}
      </dt>
      <dd className="min-w-0 break-words text-[13.5px] text-text-primary">
        {value}
        {note && <div className="mt-0.5 text-[12px] text-text-muted">{note}</div>}
      </dd>
    </div>
  );
}

const inputCls =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-app-bg disabled:text-text-muted md:min-h-[38px]";

/** id of the member-portal card ProfileTab renders under this one. */
export const PORTAL_CARD_ID = "staff-portal-profile";

export default function PersonalTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const isSelf = viewer.isSelf;
  const canEdit = isSelf || viewer.canEditRecord;

  const initial: Draft = useMemo(
    () => ({
      firstName: staff.firstName ?? "",
      lastName: staff.lastName ?? "",
      email: staff.email ?? "",
      title: staff.title ?? "",
      phone: staff.phone ?? "",
    }),
    [staff.firstName, staff.lastName, staff.email, staff.title, staff.phone],
  );

  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const dirty =
    open &&
    (draft.firstName !== initial.firstName ||
      draft.lastName !== initial.lastName ||
      draft.phone !== initial.phone ||
      (!isSelf && (draft.email !== initial.email || draft.title !== initial.title)));

  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  const emailChanged = !isSelf && draft.email.trim().toLowerCase() !== initial.email.toLowerCase();
  const emailValid = EMAIL_RE.test(draft.email.trim());
  const canSave =
    dirty && !saving && draft.firstName.trim().length > 0 && draft.lastName.trim().length > 0 && (isSelf || emailValid);

  function openEditor() {
    setDraft(initial);
    setError(null);
    setSavedNote(null);
    setOpen(true);
  }
  function close() {
    setOpen(false);
    setError(null);
    setDirty(false);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const phone = draft.phone.trim() || null;
    const res = isSelf
      ? await fetch("/api/me/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), phone }),
        })
      : await fetch(`/api/staff/${staff.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            firstName: draft.firstName.trim(),
            lastName: draft.lastName.trim(),
            email: draft.email.trim().toLowerCase(),
            title: draft.title.trim() || null,
            phone,
          }),
        });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(errorText(d?.error, "Couldn't save. Please try again."));
      return;
    }
    setOpen(false);
    setDirty(false);
    setSavedNote(emailChanged ? `Saved. ${draft.firstName.trim()} now signs in with ${draft.email.trim().toLowerCase()}.` : "Saved.");
    await reload();
  }

  const who = isSelf ? "you" : staff.firstName || "they";
  const btn =
    "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";

  return (
    <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
      <section className="min-w-0 rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="text-[15px] font-semibold text-text-primary">Contact &amp; identity</h2>
          {canEdit && (
            <button type="button" onClick={openEditor} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Edit
            </button>
          )}
        </div>
        <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-muted">
          <span className="inline-flex items-center gap-1"><Pencil className="h-3 w-3" aria-hidden /> you can edit</span>
          <span className="inline-flex items-center gap-1"><RefreshCw className="h-3 w-3" aria-hidden /> the staff member can edit too</span>
          <span className="inline-flex items-center gap-1"><Lock className="h-3 w-3" aria-hidden /> locked</span>
        </div>

        {savedNote && (
          <div role="status" className="mt-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-success-surface)", color: "var(--color-success-text)" }}>
            {savedNote}
          </div>
        )}

        <dl className="mt-1">
          <Row label="First name" value={staff.firstName || "—"} icon={canEdit ? (isSelf ? "edit" : "shared") : null} />
          <Row label="Last name" value={staff.lastName || "—"} icon={canEdit ? (isSelf ? "edit" : "shared") : null} />
          <Row
            label="Sign-in email"
            value={staff.email}
            icon={viewer.canEditRecord ? "edit" : "lock"}
            note={isSelf ? "Ask the owner to change your sign-in email or title." : undefined}
          />
          <Row label="Title" value={staff.title || "—"} icon={viewer.canEditRecord ? "edit" : "lock"} />
          <Row
            label="Private phone"
            value={staff.phone || "—"}
            icon={canEdit ? (isSelf ? "edit" : "shared") : null}
            note="Only staff managers see this."
          />
          <Row
            label="Public phone"
            value={staff.publicPhone || "—"}
            icon={null}
            note={
              <>
                Shown in the member portal.{" "}
                <button
                  type="button"
                  onClick={() => document.getElementById(PORTAL_CARD_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  className="inline-flex min-h-[44px] items-center font-medium text-brand hover:underline md:min-h-0"
                >
                  Change it in Member portal profile below
                </button>
              </>
            }
          />
        </dl>

        <div
          className="mt-3 rounded-lg p-3"
          style={{ background: "var(--color-table-chrome)", border: "1px solid var(--color-inset-border)" }}
        >
          <div className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 text-text-muted" aria-hidden />
            <span className="text-[13px] font-medium text-text-primary">Password</span>
            <span className="rounded px-1.5 py-px text-[12px] font-semibold uppercase" style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}>
              Locked
            </span>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-muted">
            Password — only the staff member can change this, from their own account.
            {isSelf && (
              <>
                {" "}
                <Link href="/dashboard/my-account" className="inline-flex min-h-[44px] items-center font-medium text-brand hover:underline md:min-h-0">
                  Change your password
                </Link>
              </>
            )}
          </p>
        </div>
      </section>

      <section className="min-w-0 rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">Who can change what</h2>
        <ul className="mt-2 space-y-2 text-[13px] text-text-muted">
          <li>
            <strong className="font-medium text-text-primary">Name and private phone</strong> — {isSelf ? "you" : "staff managers"}
            {isSelf ? " and staff managers." : ` and ${staff.firstName || "the staff member"} from their own profile.`}
          </li>
          <li>
            <strong className="font-medium text-text-primary">Sign-in email and title</strong> — staff managers only. Changing the
            sign-in email moves where {who} sign{isSelf ? "" : "s"} in.
          </li>
          <li>
            <strong className="font-medium text-text-primary">Password</strong> — only {isSelf ? "you" : staff.firstName || "the staff member"}.
          </li>
        </ul>
        {!canEdit && (
          <p className="mt-3 flex items-start gap-2 text-[12.5px] text-text-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            You can see these details but not change them.
          </p>
        )}
      </section>

      <Sheet
        open={open}
        onClose={close}
        title={isSelf ? "Edit your info" : `Edit ${staff.firstName || "staff"}'s info`}
        description={isSelf ? "Saved under your name in Recent activity." : "Saved under your name in their Recent activity."}
        footer={
          <>
            <button type="button" onClick={close} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Cancel
            </button>
            <button type="button" onClick={save} disabled={!canSave} className={`${btn} bg-brand text-white hover:bg-brand-hover disabled:opacity-50`}>
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        }
      >
        <form
          className="space-y-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">First name</span>
              <input className={inputCls} value={draft.firstName} autoComplete="given-name" onChange={(e) => setDraft({ ...draft, firstName: e.target.value })} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Last name</span>
              <input className={inputCls} value={draft.lastName} autoComplete="family-name" onChange={(e) => setDraft({ ...draft, lastName: e.target.value })} />
            </label>
          </div>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Sign-in email</span>
            <input
              type="email"
              className={inputCls}
              value={draft.email}
              disabled={isSelf}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
            {!isSelf && draft.email.trim() !== "" && !emailValid && (
              <span className="mt-1 block text-[12px]" style={{ color: "var(--color-danger-text)" }}>Enter a valid email address.</span>
            )}
          </label>
          {emailChanged && emailValid && (
            <div className="rounded-lg px-3 py-2.5 text-[13px]" style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)", border: "1px solid var(--color-warn-border)" }}>
              {draft.firstName.trim() || staff.firstName} will sign in with the new address from now on. The old one stops working.
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Title</span>
            <input
              className={inputCls}
              value={draft.title}
              disabled={isSelf}
              placeholder="Head Coach, Front Desk…"
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
          </label>
          {isSelf && <p className="text-[12.5px] text-text-muted">Ask the owner to change your sign-in email or title.</p>}

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Private phone — only staff managers see this</span>
            <input
              type="tel"
              className={inputCls}
              value={draft.phone}
              autoComplete="tel"
              onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
            />
          </label>

          {error && (
            <div role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
              {error}
            </div>
          )}
        </form>
      </Sheet>
    </div>
  );
}
