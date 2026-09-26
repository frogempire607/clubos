"use client";

// B21 — Lessons tab: which private lesson types this coach offers. Each switch
// saves immediately (PATCH /api/private-lessons/types/[id] with the new
// eligibleCoachIds — the same write the Edit Staff modal made). That route
// needs Events & purchase options: edit, so anyone without it (including a
// staff member on their own profile) sees the list read-only.
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, Lock } from "lucide-react";
import Switch from "@/components/staff/access/Switch";
import { lessonMeta, nextEligible, offeredViaPriceOption, openToAnyStaff, type CoachLessonType } from "@/components/staff/pay/lessonModel";
import { hasPermission } from "@/lib/permissions";
import type { StaffTabProps } from "@/components/staff/types";

export default function LessonsTab({ data, reload }: StaffTabProps) {
  const { staff, viewer } = data;
  const first = staff.firstName || "This coach";
  const [types, setTypes] = useState<CoachLessonType[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/private-lessons/types", { cache: "no-store" });
    if (!r.ok) {
      setLoadError("Couldn't load lesson types.");
      setTypes([]);
      return;
    }
    const d = await r.json().catch(() => []);
    setTypes(Array.isArray(d) ? d : []);
    setLoadError(null);
  }, []);

  useEffect(() => {
    load();
    // Same check the PATCH route makes: owner, or Events & purchase options ≥ edit.
    fetch("/api/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((me) => {
        if (!me) return;
        setCanEdit(me.role === "OWNER" || (me.role === "STAFF" && hasPermission(me.permissions, "events", "edit")));
      })
      .catch(() => {});
    return () => {
      if (tickTimer.current) clearTimeout(tickTimer.current);
    };
  }, [load]);

  async function toggle(lt: CoachLessonType, on: boolean) {
    setBusy(lt.id);
    setError(null);
    const r = await fetch(`/api/private-lessons/types/${lt.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eligibleCoachIds: nextEligible(lt.eligibleCoachIds, staff.id, on) }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) {
      setError(`${lt.title} didn't save: ${typeof d.error === "string" ? d.error : "the server refused it"}.`);
      return;
    }
    setTypes((cur) => (cur ?? []).map((x) => (x.id === lt.id ? { ...x, eligibleCoachIds: d.eligibleCoachIds ?? nextEligible(x.eligibleCoachIds, staff.id, on) } : x)));
    setStatus(`${on ? "Added" : "Removed"} ${lt.title} · saved just now`);
    setTick(lt.id);
    if (tickTimer.current) clearTimeout(tickTimer.current);
    tickTimer.current = setTimeout(() => setTick(null), 2000);
    reload();
  }

  const readOnly = !canEdit;
  const onCount = (types ?? []).filter((t) => (t.eligibleCoachIds ?? []).includes(staff.id)).length;
  const you = viewer.isSelf;

  return (
    <div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
      <section className="min-w-0 rounded-xl border border-app-border bg-surface p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-text-primary">
            {you ? "Private lesson types you coach" : `Private lesson types ${first} coaches`}
          </h2>
          {status && (
            <span
              role="status"
              className="rounded-full px-2 py-0.5 text-[12px] font-medium"
              style={{ background: "var(--color-success-surface)", color: "var(--color-success-text)" }}
            >
              {status}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-[12.5px] text-text-muted">
          Prices live on the lesson type (and its purchase options) under Purchase Options → Privates.
        </p>

        {readOnly && types !== null && (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-3 py-2.5 text-[13px] text-text-muted">
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              {you
                ? "Your lesson types are set by the owner."
                : "Changing lesson types needs Events & purchase options: edit."}
            </span>
          </div>
        )}

        {error && (
          <p role="alert" className="mt-3 rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
            {error}
          </p>
        )}

        {types === null ? (
          <p className="mt-4 text-[13px] text-text-muted">Loading lesson types…</p>
        ) : loadError ? (
          <p className="mt-4 text-[13px]" style={{ color: "var(--color-danger-text)" }}>{loadError}</p>
        ) : types.length === 0 ? (
          <p className="mt-4 text-[13px] text-text-muted">No lesson types yet. Create them under Purchase Options → Privates.</p>
        ) : (
          <ul className="mt-2">
            {types.map((lt) => {
              const on = (lt.eligibleCoachIds ?? []).includes(staff.id);
              const viaOption = !on && offeredViaPriceOption(lt, staff.id);
              return (
                <li key={lt.id} className="flex items-center gap-2 border-b border-[var(--color-hairline)] py-1.5 last:border-b-0">
                  <Switch
                    checked={on}
                    disabled={readOnly || busy !== null}
                    label={`${you ? "You coach" : `${first} coaches`} ${lt.title}`}
                    onChange={(v) => toggle(lt, v)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14px] font-medium text-text-primary">{lt.title}</p>
                    <p className="text-[12.5px] text-text-muted">{lessonMeta(lt)}</p>
                    {openToAnyStaff(lt) && (
                      <p className="mt-0.5 text-[12px] text-text-muted">
                        No coach list set, so any staff member can coach it.
                        {!readOnly && ` Switching on limits it to ${you ? "you" : first}.`}
                      </p>
                    )}
                    {viaOption && (
                      <p className="mt-0.5 text-[12px] text-text-muted">
                        Already offered through one of this lesson&apos;s price options. Change that option under Purchase Options → Privates.
                      </p>
                    )}
                  </div>
                  <span
                    aria-hidden={tick !== lt.id}
                    className={`inline-flex shrink-0 items-center gap-1 text-[12px] font-medium transition-opacity duration-200 motion-reduce:transition-none ${
                      tick === lt.id ? "opacity-100" : "opacity-0"
                    }`}
                    style={{ color: "var(--color-success-text)" }}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden /> Saved
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="min-w-0 self-start rounded-xl border border-app-border bg-surface p-4 sm:p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">How this is used</h2>
        <p className="mt-2 text-[13px] text-text-primary">
          {onCount === 0
            ? `${you ? "You don't" : `${first} doesn't`} appear as a coach for any private lesson.`
            : `Members booking ${onCount === 1 ? "this lesson type" : `these ${onCount} lesson types`} can pick ${you ? "you" : first} as their coach.`}
        </p>
        <p className="mt-2 text-[13px] text-text-muted">
          To change a price or package, open{" "}
          {canEdit ? (
            <Link href="/dashboard/privates" className="font-medium text-brand hover:underline">
              Purchase Options → Privates
            </Link>
          ) : (
            "Purchase Options → Privates"
          )}
          .
        </p>
      </section>
    </div>
  );
}
