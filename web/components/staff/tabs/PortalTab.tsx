"use client";

// B21 — Portal profile tab: what members see about this staff member in the
// member portal. One Save.
//   · the staff member themself → PATCH /api/me/portal-profile
//   · a manager with canEditRecord → PATCH /api/staff/<id>
//   · anyone else → read-only.
import { useEffect, useMemo, useState } from "react";
import { Lock, Mail, Phone } from "lucide-react";
import ImageUpload from "@/components/ImageUpload";
import type { StaffTabProps } from "@/components/staff/types";

type Draft = { photoUrl: string; bio: string; publicEmail: string; publicPhone: string; showOnPortal: boolean };

function errorText(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw.map((x) => (typeof x === "string" ? x : (x as { message?: string })?.message)).filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return fallback;
}

const inputCls =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-app-bg disabled:text-text-muted md:min-h-[38px]";

export default function PortalTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const isSelf = viewer.isSelf;
  const canEdit = isSelf || viewer.canEditRecord;

  const initial: Draft = useMemo(
    () => ({
      photoUrl: staff.photoUrl ?? "",
      bio: staff.bio ?? "",
      publicEmail: staff.publicEmail ?? "",
      publicPhone: staff.publicPhone ?? "",
      showOnPortal: !!staff.showOnPortal,
    }),
    [staff.photoUrl, staff.bio, staff.publicEmail, staff.publicPhone, staff.showOnPortal],
  );
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A reload after save hands us a fresh `initial`; start from it.
  useEffect(() => setDraft(initial), [initial]);

  const dirty = (Object.keys(initial) as (keyof Draft)[]).some((k) => draft[k] !== initial[k]);
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  function set<K extends keyof Draft>(k: K, v: Draft[K]) {
    setSaved(false);
    setDraft((d) => ({ ...d, [k]: v }));
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const body = {
      photoUrl: draft.photoUrl || null,
      bio: draft.bio.trim() || null,
      publicEmail: draft.publicEmail.trim() || null,
      publicPhone: draft.publicPhone.trim() || null,
      showOnPortal: draft.showOnPortal,
    };
    const res = await fetch(isSelf ? "/api/me/portal-profile" : `/api/staff/${staff.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(errorText(d?.error, "Couldn't save. Please try again."));
      return;
    }
    setDirty(false);
    setSaved(true);
    await reload();
  }

  const name = `${staff.firstName} ${staff.lastName}`.trim();
  const initials = `${staff.firstName[0] ?? ""}${staff.lastName[0] ?? ""}`.toUpperCase();
  const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";

  return (
    <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
      <section className="min-w-0 rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">Member portal profile</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          What members see about {isSelf ? "you" : staff.firstName || "this staff member"} in the member portal.
        </p>

        {!canEdit && (
          <p className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-3 py-2 text-[12.5px] text-text-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            You can see this profile but not change it.
          </p>
        )}

        <div className="mt-4 space-y-4">
          {/* Show-on-portal switch */}
          <div className="flex items-start justify-between gap-4 rounded-lg border border-app-border p-3">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium text-text-primary">Show in the member portal</div>
              <div className="text-[12.5px] text-text-muted">
                {draft.showOnPortal ? "Members can see this profile." : "Hidden — members don't see this profile."}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={draft.showOnPortal}
              aria-label="Show in the member portal"
              disabled={!canEdit}
              onClick={() => set("showOnPortal", !draft.showOnPortal)}
              className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center disabled:opacity-60 md:min-h-0"
            >
              <span
                className={`relative inline-block h-6 w-11 rounded-full transition-colors motion-reduce:transition-none ${draft.showOnPortal ? "bg-brand" : "bg-app-border"}`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform motion-reduce:transition-none ${draft.showOnPortal ? "translate-x-[22px]" : "translate-x-0.5"}`}
                />
              </span>
            </button>
          </div>

          <div>
            <span className="mb-2 block text-[13px] font-medium text-text-primary">Photo</span>
            {canEdit ? (
              <ImageUpload value={draft.photoUrl || null} onChange={(url) => set("photoUrl", url)} shape="circle" />
            ) : draft.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.photoUrl} alt="" className="h-[72px] w-[72px] rounded-full object-cover" />
            ) : (
              <p className="text-[13px] text-text-muted">No photo.</p>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Bio</span>
            <textarea
              value={draft.bio}
              disabled={!canEdit}
              maxLength={2000}
              rows={5}
              onChange={(e) => set("bio", e.target.value)}
              placeholder="A few lines about their coaching background and what they teach."
              className="w-full rounded-lg border border-app-border bg-surface px-3 py-2 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-app-bg disabled:text-text-muted"
            />
            <span className="mt-0.5 block text-right text-[12px] text-text-muted">{draft.bio.length}/2000</span>
          </label>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Public email</span>
              <input type="email" className={inputCls} value={draft.publicEmail} disabled={!canEdit} onChange={(e) => set("publicEmail", e.target.value)} />
            </label>
            <label className="block">
              <span className="mb-1 block text-[13px] font-medium text-text-primary">Public phone</span>
              <input type="tel" className={inputCls} value={draft.publicPhone} disabled={!canEdit} onChange={(e) => set("publicPhone", e.target.value)} />
            </label>
          </div>
          <p className="text-[12.5px] text-text-muted">
            Members see these. The sign-in email and private phone are never shown in the portal.
          </p>

          {error && (
            <div role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
              {error}
            </div>
          )}

          {canEdit && (
            <div className="flex flex-col-reverse items-stretch gap-2 border-t border-app-border pt-4 sm:flex-row sm:items-center sm:justify-end">
              {saved && !dirty && (
                <span role="status" className="text-[13px] sm:mr-auto" style={{ color: "var(--color-success-text)" }}>
                  Saved.
                </span>
              )}
              {dirty && (
                <button type="button" onClick={() => setDraft(initial)} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
                  Discard
                </button>
              )}
              <button type="button" onClick={save} disabled={!dirty || saving} className={`${btn} bg-brand text-white hover:bg-brand-hover disabled:opacity-50`}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      </section>

      {/* Preview — how members see it */}
      <section className="min-w-0 self-start rounded-xl border border-app-border bg-surface p-[18px] sm:p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">What members see</h2>
        {!draft.showOnPortal ? (
          <p className="mt-2 text-[13px] text-text-muted">Nothing — this profile is hidden from the member portal.</p>
        ) : (
          <div className="mt-3 rounded-xl border border-app-border bg-app-bg p-4">
            <div className="flex items-center gap-3">
              {draft.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={draft.photoUrl} alt="" className="h-14 w-14 shrink-0 rounded-full object-cover" />
              ) : (
                <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-app-border text-[15px] font-semibold text-text-primary">
                  {initials}
                </span>
              )}
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold text-text-primary">{name}</div>
                {staff.title && <div className="truncate text-[13px] text-text-muted">{staff.title}</div>}
              </div>
            </div>
            {draft.bio.trim() && <p className="mt-3 whitespace-pre-line break-words text-[13px] text-text-primary">{draft.bio.trim()}</p>}
            {(draft.publicEmail.trim() || draft.publicPhone.trim()) && (
              <div className="mt-3 space-y-1 text-[13px] text-text-muted">
                {draft.publicEmail.trim() && (
                  <div className="flex items-center gap-1.5 break-all"><Mail className="h-3.5 w-3.5 shrink-0" aria-hidden />{draft.publicEmail.trim()}</div>
                )}
                {draft.publicPhone.trim() && (
                  <div className="flex items-center gap-1.5"><Phone className="h-3.5 w-3.5 shrink-0" aria-hidden />{draft.publicPhone.trim()}</div>
                )}
              </div>
            )}
          </div>
        )}
        {dirty && <p className="mt-2 text-[12px] text-text-muted">Preview includes unsaved changes.</p>}
      </section>
    </div>
  );
}
