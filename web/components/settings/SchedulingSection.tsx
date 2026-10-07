"use client";

// Settings → Scheduling (owner only; the whole Settings area is).
//   1. Turn the new coach scheduling on — preview first (a dry run that writes
//      nothing), then confirm. POST /api/settings/schedule/switch-on.
//   2. Who hears when a class needs coverage, and how.
//   3. Who is told by default when a class day is canceled.
// 2 and 3 are one form with ONE Save (PUT /api/settings/schedule).
import { useCallback, useEffect, useMemo, useState } from "react";
import Sheet from "@/components/Sheet";
import { CLASS_STAFF_ROLES, type CancelAudience } from "@/lib/classStaff";
import { audienceOptions, switchOnLine, switchOnSentence, switchStatusText, type SwitchOnClassLine } from "@/lib/classStaffUi";

type Settings = {
  coverageNotifyOwners: boolean;
  coverageNotifyManagers: boolean;
  coverageNotifyClassStaff: boolean;
  coverageNotifyRoleNames: string[];
  coverageNotifyUserIds: string[];
  coverageChannels: string[];
  classCancelNotifyDefault: CancelAudience;
};
type Loaded = Settings & { assignmentsStartOn: string | null; options?: { staff?: { id: string; name: string; role: string }[] } };
type Preview = { date: string; classes: (SwitchOnClassLine & { classId: string })[]; totals: { classes: number; coachAssignments: number; classDays: number } };

const btn =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";
const ghost = `${btn} border border-app-border text-text-primary hover:bg-app-bg`;
const primary = `${btn} bg-brand text-white hover:bg-brand-hover`;
const check = "flex min-h-[44px] cursor-pointer items-start gap-3 py-1.5 text-[14px] text-text-primary";
const legend = "mb-1 text-[13px] font-semibold text-text-primary";
const dangerBox = { background: "var(--color-danger-surface)", color: "var(--color-danger-text)" };
const okBox = { background: "var(--color-success-surface)", color: "var(--color-success-text)" };
const STANDARD_ROLES: string[] = CLASS_STAFF_ROLES.map((r) => r.label);

const pick = (d: Loaded): Settings => ({
  coverageNotifyOwners: !!d.coverageNotifyOwners,
  coverageNotifyManagers: !!d.coverageNotifyManagers,
  coverageNotifyClassStaff: !!d.coverageNotifyClassStaff,
  coverageNotifyRoleNames: d.coverageNotifyRoleNames ?? [],
  coverageNotifyUserIds: d.coverageNotifyUserIds ?? [],
  coverageChannels: d.coverageChannels ?? ["IN_APP", "EMAIL"],
  classCancelNotifyDefault: d.classCancelNotifyDefault ?? "BOOKED",
});
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const same = (a: Settings, b: Settings) =>
  a.coverageNotifyOwners === b.coverageNotifyOwners && a.coverageNotifyManagers === b.coverageNotifyManagers &&
  a.coverageNotifyClassStaff === b.coverageNotifyClassStaff && a.classCancelNotifyDefault === b.classCancelNotifyDefault &&
  sameSet(a.coverageNotifyRoleNames, b.coverageNotifyRoleNames) && sameSet(a.coverageNotifyUserIds, b.coverageNotifyUserIds) &&
  sameSet(a.coverageChannels, b.coverageChannels);

async function errorOf(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : fallback;
}

export default function SchedulingSection() {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [startOn, setStartOn] = useState<string | null>(null);
  const [staff, setStaff] = useState<{ id: string; name: string }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/schedule", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await errorOf(res, "Couldn't load the scheduling settings."));
        return;
      }
      const d = (await res.json()) as Loaded;
      setLoadError(null);
      setSaved(pick(d));
      setForm(pick(d));
      setStartOn(d.assignmentsStartOn ?? null);
      setStaff(d.options?.staff ?? []);
    } catch {
      setLoadError("Couldn't reach the server. Check your connection and try again.");
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  // ── switch on ─────────────────────────────────────────────────────────────
  const [preview, setPreview] = useState<Preview | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function switchOn(apply: boolean) {
    setSwitchBusy(true);
    setSwitchError(null);
    let res: Response;
    try {
      res = await fetch("/api/settings/schedule/switch-on", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Applying uses the exact date that was previewed.
        body: JSON.stringify(apply && preview ? { apply: true, date: preview.date } : { apply: false }),
      });
    } catch {
      setSwitchBusy(false);
      setSwitchError("Couldn't reach the server. Check your connection and try again.");
      return;
    }
    if (!res.ok) {
      setSwitchBusy(false);
      setConfirming(false);
      setSwitchError(await errorOf(res, apply ? "Couldn't turn it on. Nothing was changed." : "Couldn't prepare the preview."));
      return;
    }
    const d = await res.json();
    setSwitchBusy(false);
    if (!apply) {
      setPreview({ date: d.date, classes: d.classes ?? [], totals: d.totals });
      return;
    }
    setConfirming(false);
    setPreview(null);
    setStartOn(d.assignmentsStartOn ?? null);
    setSwitchNote("New coach scheduling is on. Open Staff → Schedule and tap a class to set roles, substitutes and cancellations.");
  }

  // ── notification settings ─────────────────────────────────────────────────
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [roleDraft, setRoleDraft] = useState("");
  const dirty = !!form && !!saved && !same(form, saved);
  const set = (patch: Partial<Settings>) => {
    setSaveNote(null);
    setSaveError(null);
    setForm((cur) => (cur ? { ...cur, ...patch } : cur));
  };
  const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const customRoles = useMemo(() => (form?.coverageNotifyRoleNames ?? []).filter((r) => !STANDARD_ROLES.includes(r)), [form]);
  const activeChannels = (form?.coverageChannels ?? []).filter((c) => c === "IN_APP" || c === "EMAIL");

  function addRole() {
    const t = roleDraft.trim().slice(0, 60);
    if (!t || !form) return;
    if (!form.coverageNotifyRoleNames.some((r) => r.toLowerCase() === t.toLowerCase())) set({ coverageNotifyRoleNames: [...form.coverageNotifyRoleNames, t] });
    setRoleDraft("");
  }
  async function save() {
    if (!form) return;
    if (activeChannels.length === 0) {
      setSaveError("Pick at least one way to notify: in the app or by email.");
      return;
    }
    setSaving(true);
    setSaveError(null);
    let res: Response;
    try {
      res = await fetch("/api/settings/schedule", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    } catch {
      setSaving(false);
      setSaveError("Couldn't reach the server. Nothing was saved.");
      return;
    }
    if (!res.ok) {
      setSaving(false);
      setSaveError(await errorOf(res, "Couldn't save. Nothing was changed."));
      return;
    }
    const d = (await res.json()) as Loaded;
    setSaving(false);
    setSaved(pick(d));
    setForm(pick(d));
    setSaveNote("Saved");
  }

  if (loadError) {
    return (
      <div className="rounded-xl border border-app-border bg-surface p-6">
        <p role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>{loadError}</p>
        <button type="button" onClick={load} className={`${ghost} mt-3`}>Try again</button>
      </div>
    );
  }
  if (!form) {
    return <div className="rounded-xl border border-app-border bg-surface p-6 text-[13px] text-text-muted">Loading…</div>;
  }

  return (
    <div className="space-y-4">
      {/* ── 1. Switch on ─────────────────────────────────────────────────── */}
      <div className="rounded-xl border border-app-border bg-surface p-6">
        <h2 className="text-base font-semibold text-text-primary">Coach scheduling</h2>
        <p className="mt-2 text-[14px] font-medium text-text-primary">{switchStatusText(startOn)}</p>
        {startOn ? (
          <p className="mt-1 text-[13px] text-text-muted">
            Coach changes are tracked per class day from that date: roles, substitutes, call-outs and canceled days. Earlier class days stay as they were recorded.
          </p>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-text-muted">
              Turning it on gives each class day its own coach list — with roles, call-outs that ask for coverage, substitutes, and canceled days that record who was told and whether coaches are paid. Until then everything works as it does today.
            </p>
            {!preview ? (
              <button type="button" onClick={() => switchOn(false)} disabled={switchBusy} className={`${ghost} mt-3`}>
                {switchBusy ? "Preparing…" : "Preview switch-on"}
              </button>
            ) : (
              <div className="mt-3 rounded-lg border border-app-border p-3">
                <p className="text-[13px] font-medium text-text-primary">What turning it on would set up — nothing has been changed yet</p>
                {preview.classes.length === 0 ? (
                  <p className="mt-1.5 text-[13px] text-text-muted">There are no classes yet. Coaches you add to new classes will be tracked per class day.</p>
                ) : (
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-text-primary">
                    {preview.classes.map((c) => (
                      <li key={c.classId}>{switchOnLine(c)}</li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-[13px] text-text-muted">{switchOnSentence(preview.date)}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button type="button" onClick={() => setConfirming(true)} disabled={switchBusy} className={primary}>Turn on</button>
                  <button type="button" onClick={() => setPreview(null)} disabled={switchBusy} className={ghost}>Not now</button>
                </div>
              </div>
            )}
          </>
        )}
        {switchNote && <p role="status" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={okBox}>{switchNote}</p>}
        {switchError && <p role="alert" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>{switchError}</p>}
      </div>

      {/* ── 2 + 3. Notifications ─────────────────────────────────────────── */}
      <div className="rounded-xl border border-app-border bg-surface p-6">
        <h2 className="text-base font-semibold text-text-primary">When a class needs coverage</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          A coach who can&apos;t make a class calls out; the class stays on the schedule and these people are told so someone can cover it.
          {!startOn && " This starts working once coach scheduling is turned on."}
        </p>

        <fieldset className="mt-4">
          <legend className={legend}>Tell</legend>
          {([
            ["coverageNotifyOwners", "Owners", ""],
            ["coverageNotifyManagers", "Schedule managers", "Everyone who can edit the staff schedule — owners included."],
            ["coverageNotifyClassStaff", "Other coaches on that class", "Whoever else is coaching the same class day."],
          ] as const).map(([key, label, hint]) => (
            <label key={key} className={check}>
              <input type="checkbox" className="mt-1" checked={form[key]} onChange={(e) => set({ [key]: e.target.checked } as Partial<Settings>)} />
              <span>
                {label}
                {hint && <span className="block text-xs text-text-muted">{hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>

        <fieldset className="mt-4">
          <legend className={legend}>Also anyone assigned to the class as</legend>
          <div className="flex flex-wrap gap-2">
            {[...STANDARD_ROLES, ...customRoles].map((r) => {
              const on = form.coverageNotifyRoleNames.includes(r);
              return (
                <button
                  key={r}
                  type="button"
                  aria-pressed={on}
                  onClick={() => set({ coverageNotifyRoleNames: toggleIn(form.coverageNotifyRoleNames, r) })}
                  className={`inline-flex min-h-[44px] items-center rounded-full border px-3 text-[13px] md:min-h-[32px] ${on ? "border-transparent bg-brand font-medium text-white" : "border-app-border text-text-primary hover:bg-app-bg"}`}
                >
                  {r}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              aria-label="Another role name"
              value={roleDraft}
              onChange={(e) => setRoleDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addRole(); } }}
              maxLength={60}
              placeholder="Another role name"
              className="min-h-[44px] w-full rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary sm:w-64 md:min-h-[36px]"
            />
            <button type="button" onClick={addRole} disabled={!roleDraft.trim()} className={ghost}>Add role</button>
          </div>
        </fieldset>

        <fieldset className="mt-4">
          <legend className={legend}>And these people, always</legend>
          {staff.length === 0 ? (
            <p className="text-[13px] text-text-muted">No staff yet.</p>
          ) : (
            <div className="grid max-h-56 grid-cols-1 gap-x-4 overflow-y-auto rounded-lg border border-app-border px-3 sm:grid-cols-2">
              {staff.map((u) => (
                <label key={u.id} className={check}>
                  <input type="checkbox" className="mt-1" checked={form.coverageNotifyUserIds.includes(u.id)} onChange={() => set({ coverageNotifyUserIds: toggleIn(form.coverageNotifyUserIds, u.id) })} />
                  {u.name}
                </label>
              ))}
            </div>
          )}
        </fieldset>

        <fieldset className="mt-4">
          <legend className={legend}>How</legend>
          {([["IN_APP", "In the app", "A message in their inbox and an item in the Action Center."], ["EMAIL", "Email", ""]] as const).map(([key, label, hint]) => (
            <label key={key} className={check}>
              <input type="checkbox" className="mt-1" checked={form.coverageChannels.includes(key)} onChange={() => set({ coverageChannels: toggleIn(form.coverageChannels, key) })} />
              <span>
                {label}
                {hint && <span className="block text-xs text-text-muted">{hint}</span>}
              </span>
            </label>
          ))}
          <label className={`${check} cursor-not-allowed opacity-60`}>
            <input type="checkbox" className="mt-1" checked={false} disabled readOnly />
            <span>
              Push notification
              <span className="block text-xs text-text-muted">Available when the mobile app supports it</span>
            </span>
          </label>
        </fieldset>

        <h2 className="mt-6 border-t border-app-border pt-5 text-base font-semibold text-text-primary">When a class is canceled</h2>
        <fieldset className="mt-2">
          <legend className={legend}>Notify by default</legend>
          <p className="mb-1 text-xs text-text-muted">Whoever cancels a class day can still choose differently that time.</p>
          {audienceOptions(null).map((o) => (
            <label key={o.value} className={check}>
              <input type="radio" name="cancel-default" className="mt-1" checked={form.classCancelNotifyDefault === o.value} onChange={() => set({ classCancelNotifyDefault: o.value })} />
              <span>
                {o.label}
                <span className="block text-xs text-text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {saveError && <p role="alert" className="mt-4 rounded-lg px-3 py-2 text-[13px]" style={dangerBox}>{saveError}</p>}
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={save} disabled={saving || !dirty} className={primary}>
            {saving ? "Saving…" : "Save"}
          </button>
          {dirty && !saving && <span className="text-xs text-text-muted">You have changes that are not saved yet.</span>}
          {saveNote && !dirty && <span role="status" className="text-xs text-text-muted">{saveNote}</span>}
        </div>
      </div>

      <Sheet
        open={confirming}
        onClose={() => !switchBusy && setConfirming(false)}
        title="Turn on new coach scheduling?"
        footer={
          <>
            <button type="button" onClick={() => setConfirming(false)} disabled={switchBusy} className={ghost}>Not now</button>
            <button type="button" onClick={() => switchOn(true)} disabled={switchBusy} className={primary}>{switchBusy ? "Turning on…" : "Turn on"}</button>
          </>
        }
      >
        <p className="text-[13px] text-text-primary">{preview ? switchOnSentence(preview.date) : ""}</p>
        <p className="mt-2 text-[13px] text-text-muted">
          Every class keeps the coaches it has now. This can&apos;t be turned off again from here, and the start date can&apos;t be moved afterwards.
        </p>
      </Sheet>
    </div>
  );
}
