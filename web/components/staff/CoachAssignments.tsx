"use client";

// Coaches on one calendar item — shown in the Calendar's event / class detail.
// Uses the SAME write APIs as the rest of the app (lib/staffAssignments.ts has
// the map), so a change here is what the staff Schedule, the staff profile,
// the member schedule and payroll read next:
//   event        POST/DELETE /api/events/[id]/staff        (events:edit)
//   class day    POST /api/classes/[id]/occurrence          (schedule:edit)
//   class series POST/DELETE /api/classes/[id]/staff        (classes:edit)
// The page passes which of those the viewer holds; controls are hidden
// otherwise (the APIs refuse them anyway).
import { useState } from "react";
import Sheet from "@/components/Sheet";
import { classStaffScopes, nextDayStaff, type ClassStaffScope } from "@/lib/staffAssignments";

export type CoachTarget =
  | { kind: "event"; eventId: string; name: string; staff: { id: string; name: string }[] }
  | {
      kind: "class";
      classId: string;
      date: string; // YYYY-MM-DD
      dateLabel: string;
      name: string;
      staff: { id: string; name: string }[];
      seriesStaffIds: string[];
      staffIsOverride: boolean;
    };

export type CoachPermissions = {
  editEventStaff: boolean;
  editClassSeriesStaff: boolean;
  editClassDayStaff: boolean;
};

type Pending = { op: "add" | "remove"; userId: string; userName: string };

const btn =
  "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px] disabled:opacity-50";

async function errorOf(res: Response, fallback: string): Promise<string> {
  const d = await res.json().catch(() => ({}));
  return typeof d?.error === "string" ? d.error : fallback;
}

export default function CoachAssignments({
  target,
  can,
  staffOptions,
  onChanged,
}: {
  target: CoachTarget;
  can: CoachPermissions;
  staffOptions: { id: string; name: string }[];
  onChanged: (message: string) => void;
}) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [picking, setPicking] = useState(false);
  const [scope, setScope] = useState<ClassStaffScope>("day");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canEdit =
    target.kind === "event" ? can.editEventStaff : can.editClassDayStaff || can.editClassSeriesStaff;
  const onIds = target.staff.map((s) => s.id);
  const addable = staffOptions.filter((s) => !onIds.includes(s.id));

  const scopes =
    pending && target.kind === "class"
      ? classStaffScopes({
          op: pending.op,
          userId: pending.userId,
          seriesStaffIds: target.seriesStaffIds,
          canEditDay: can.editClassDayStaff,
          canEditSeries: can.editClassSeriesStaff,
        })
      : [];

  function start(p: Pending) {
    setError(null);
    setPicking(false);
    setPending(p);
    if (target.kind === "class") {
      const opts = classStaffScopes({
        op: p.op,
        userId: p.userId,
        seriesStaffIds: target.seriesStaffIds,
        canEditDay: can.editClassDayStaff,
        canEditSeries: can.editClassSeriesStaff,
      });
      setScope(opts[0] ?? "day");
    }
  }

  async function apply() {
    if (!pending) return;
    setBusy(true);
    setError(null);
    let res: Response;
    if (target.kind === "event") {
      res =
        pending.op === "add"
          ? await fetch(`/api/events/${target.eventId}/staff`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: pending.userId, role: "Coach" }),
            })
          : await fetch(`/api/events/${target.eventId}/staff?userId=${encodeURIComponent(pending.userId)}`, {
              method: "DELETE",
            });
    } else if (scope === "day") {
      res = await fetch(`/api/classes/${target.classId}/occurrence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: target.date,
          scope: "occurrence",
          staffIds: nextDayStaff(onIds, pending.userId, pending.op),
        }),
      });
    } else {
      res =
        pending.op === "add"
          ? await fetch(`/api/classes/${target.classId}/staff`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ userId: pending.userId }),
            })
          : await fetch(`/api/classes/${target.classId}/staff?userId=${encodeURIComponent(pending.userId)}`, {
              method: "DELETE",
            });
    }
    setBusy(false);
    if (!res.ok) {
      setError(await errorOf(res, "Couldn't save that change. Please try again."));
      return;
    }
    const verb = pending.op === "add" ? "added to" : "removed from";
    const where =
      target.kind === "class" ? (scope === "day" ? `${target.name} on ${target.dateLabel}` : `every ${target.name}`) : target.name;
    setPending(null);
    onChanged(`${pending.userName} ${verb} ${where} — saved.`);
  }

  async function resetDay() {
    if (target.kind !== "class") return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/classes/${target.classId}/occurrence`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: target.date, scope: "occurrence", staffIds: null }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(await errorOf(res, "Couldn't reset this day."));
      return;
    }
    onChanged(`${target.name} on ${target.dateLabel} uses the weekly coaches again — saved.`);
  }

  const seriesHint =
    target.kind === "class" && target.staffIsOverride
      ? "This day already has its own coach list, so a weekly change won't alter this day."
      : null;

  return (
    <div className="mt-3 border-t border-app-border pt-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-medium text-text-primary">Coaches</p>
        {target.kind === "class" && target.staffIsOverride && (
          <span
            className="rounded-full px-2 py-0.5 text-xs font-medium"
            style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}
          >
            Changed for this day
          </span>
        )}
      </div>

      {target.staff.length === 0 ? (
        <p className="text-[13px] text-text-muted">Nobody assigned.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {target.staff.map((s) => (
            <li
              key={s.id}
              className="inline-flex items-center gap-1 rounded-full border border-app-border bg-surface pl-3 text-[13px] text-text-primary"
            >
              <span className="py-1.5">{s.name}</span>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => start({ op: "remove", userId: s.id, userName: s.name })}
                  aria-label={`Remove ${s.name}`}
                  className="inline-flex h-11 min-w-[44px] items-center justify-center rounded-full px-2 text-xs font-medium text-text-muted hover:bg-app-bg hover:text-text-primary md:h-8"
                >
                  Remove
                </button>
              ) : (
                <span className="pr-3" />
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setError(null);
              setPicking(true);
            }}
            disabled={addable.length === 0}
            className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
          >
            + Add coach
          </button>
          {target.kind === "class" && target.staffIsOverride && can.editClassDayStaff && (
            <button
              type="button"
              onClick={resetDay}
              disabled={busy}
              className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
            >
              Use the weekly coaches
            </button>
          )}
        </div>
      )}
      {error && !pending && (
        <p className="mt-2 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
          {error}
        </p>
      )}

      {/* Pick who to add */}
      <Sheet open={picking} onClose={() => setPicking(false)} title="Add a coach" description={target.name}>
        {addable.length === 0 ? (
          <p className="text-[13px] text-text-muted">Everyone is already on this.</p>
        ) : (
          <ul className="divide-y divide-app-border">
            {addable.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => start({ op: "add", userId: s.id, userName: s.name })}
                  className="flex min-h-[44px] w-full items-center justify-between px-1 text-left text-[14px] text-text-primary hover:bg-app-bg"
                >
                  {s.name}
                  <span className="text-xs text-text-muted">Add</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      {/* Confirm add / remove (and, for a class, which days) */}
      <Sheet
        open={!!pending}
        onClose={() => !busy && setPending(null)}
        title={
          pending
            ? pending.op === "add"
              ? `Add ${pending.userName}?`
              : `Remove ${pending.userName}?`
            : ""
        }
        description={target.kind === "class" ? `${target.name} · ${target.dateLabel}` : target.name}
        footer={
          <>
            <button
              type="button"
              onClick={() => setPending(null)}
              disabled={busy}
              className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={apply}
              disabled={busy || (target.kind === "class" && scopes.length === 0)}
              className={`${btn} bg-brand text-white hover:bg-brand-hover`}
            >
              {busy ? "Saving…" : pending?.op === "add" ? "Add" : "Remove"}
            </button>
          </>
        }
      >
        {target.kind === "class" ? (
          scopes.length === 0 ? (
            <p className="text-[13px] text-text-muted">You don&apos;t have permission to change coaches on this class.</p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="mb-1 text-[13px] text-text-muted">Apply to</legend>
              {scopes.map((sc) => (
                <label
                  key={sc}
                  className="flex min-h-[44px] cursor-pointer items-start gap-3 rounded-lg border border-app-border px-3 py-2"
                >
                  <input
                    type="radio"
                    name="coach-scope"
                    className="mt-1"
                    checked={scope === sc}
                    onChange={() => setScope(sc)}
                  />
                  <span>
                    <span className="block text-[14px] text-text-primary">
                      {sc === "day" ? "Just this day" : "Every week"}
                    </span>
                    <span className="block text-xs text-text-muted">
                      {sc === "day"
                        ? `Only ${target.dateLabel}. The weekly coaches stay as they are.`
                        : `Changes the class itself — every future ${target.name}.`}
                    </span>
                  </span>
                </label>
              ))}
              {scope === "series" && seriesHint && <p className="text-xs text-text-muted">{seriesHint}</p>}
            </fieldset>
          )
        ) : (
          <p className="text-[13px] text-text-muted">
            {pending?.op === "remove"
              ? "They come off the staff schedule, their profile and the calendar for this event. Any pay set up for them on this event that hasn't been generated yet is removed too."
              : "They'll show on the staff schedule, their profile and the calendar for this event."}
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
            {error}
          </p>
        )}
      </Sheet>
    </div>
  );
}
