"use client";

// B21 — Access tab. One row per PERMISSION_CATALOG area, each with only the
// levels that area offers. Messaging and Billing management open their real
// sub-options in place. One "Review and save" → a confirm step that says each
// change in plain words → PATCH /api/staff/[id] (the same write the old Edit
// Staff modal made). The server refuses self-edits and owner targets; this tab
// shows the same thing read-only.
import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import { Lock, Minus, Plus, RotateCcw } from "lucide-react";
import Sheet from "@/components/Sheet";
import Reveal from "@/components/staff/access/Reveal";
import Switch from "@/components/staff/access/Switch";
import {
  LEVEL_LABEL,
  TONE_STYLE,
  accessDraftFromStaff,
  accessPayload,
  advancedOpen,
  areaChanged,
  hasAdvanced,
  isAccessDirty,
  levelSummary,
  levelTone,
  toAccessState,
  type AccessDraft,
} from "@/components/staff/access/accessModel";
import { PERMISSION_CATALOG, MESSAGES_SUBSCOPES, BILLING_SUBSCOPES, type PermissionKey, type PermissionLevel } from "@/lib/permissions";
import { LEVEL_MEANING, MONEY_AREAS, MESSAGES_SUBSCOPE_LABEL, BILLING_SUBSCOPE_LABEL, describeAccessChanges } from "@/lib/staffAccess";
import type { StaffTabProps } from "@/components/staff/types";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-3.5 text-[13px] font-medium md:min-h-[36px]";

export default function AccessTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const { data: session } = useSession();
  const first = staff.firstName || "This staff member";

  const saved = useMemo(
    () => accessDraftFromStaff(staff),
    [staff],
  );
  const [draft, setDraft] = useState<AccessDraft>(saved);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  // A fresh payload (after save / reload) resets the draft.
  useEffect(() => setDraft(saved), [saved]);

  const readOnly = viewer.targetIsOwner || viewer.isSelf || !viewer.canEditAccess;
  const dirty = !readOnly && isAccessDirty(saved, draft);
  useEffect(() => {
    setDirty(dirty);
  }, [dirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  const changes = useMemo(
    () => (dirty ? describeAccessChanges(first, toAccessState(saved), toAccessState(draft)) : []),
    [dirty, first, saved, draft],
  );

  if (viewer.targetIsOwner) {
    return (
      <section className="rounded-xl border border-app-border bg-surface p-5">
        <h2 className="text-[15px] font-semibold text-text-primary">Full access (owner)</h2>
        <p className="mt-1 text-[13px] text-text-muted">
          Owners can see and change everything in the club. Their access can&apos;t be limited.
        </p>
      </section>
    );
  }

  function setLevel(key: PermissionKey, level: PermissionLevel) {
    setFlash(null);
    setDraft((d) => ({ ...d, levels: { ...d.levels, [key]: level } }));
  }

  async function save() {
    setSaving(true);
    setError(null);
    const n = changes.length;
    const res = await fetch(`/api/staff/${staff.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissions: accessPayload(draft) }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(typeof d.error === "string" ? d.error : "Couldn't save. Nothing was changed.");
      return;
    }
    setConfirming(false);
    setDirty(false);
    setFlash(`Saved ${n} change${n === 1 ? "" : "s"} to ${first}'s access.`);
    await reload();
  }

  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const me = session?.user?.name ? `your name, ${session.user.name}` : "your name";

  return (
    <div className="pb-4">
      {readOnly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {viewer.isSelf
              ? "Your access is set by the owner."
              : `Only the owner and staff with Staff & contractors: full can change ${first}'s access.`}
          </span>
        </div>
      )}

      <section className="rounded-xl border border-app-border bg-surface">
        <div className="flex flex-col gap-3 border-b border-app-border px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-text-primary">
              {viewer.isSelf ? "What you can do" : `What ${first} can do`}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-text-muted">{levelSummary(draft.levels)}</p>
          </div>
          <div className="flex flex-wrap gap-1.5" aria-label="Level colours">
            {(["none", "view", "edit", "full"] as const).map((t) => (
              <span key={t} className="rounded-md px-2 py-0.5 text-[12px] font-medium" style={TONE_STYLE[t]}>
                {t === "edit" ? "Edit / Send" : cap(t)}
              </span>
            ))}
          </div>
        </div>

        <ul>
          {PERMISSION_CATALOG.map((area) => {
            const level = draft.levels[area.key];
            const was = saved.levels[area.key];
            const changed = areaChanged(saved, draft, area.key);
            const meaning = LEVEL_MEANING[area.key][level] ?? area.description;
            return (
              <li
                key={area.key}
                className={`border-b border-app-border px-4 py-3.5 last:border-b-0 sm:px-5 ${changed ? "bg-[var(--color-info-surface)]" : ""}`}
              >
                <div className="flex flex-col gap-2.5 md:flex-row md:items-center md:justify-between md:gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[14px] font-medium text-text-primary">{area.label}</span>
                      {MONEY_AREAS.has(area.key) && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[12px] font-medium"
                          style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)" }}
                        >
                          Money
                        </span>
                      )}
                      {level !== was && (
                        <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[12px] font-medium text-brand">
                          Was {LEVEL_LABEL[was]}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-text-muted">{cap(meaning)}.</p>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label={`${area.label} access level`}
                    className="flex w-full shrink-0 rounded-lg border border-app-border bg-app-bg p-0.5 md:w-auto"
                  >
                    {area.levels.map((l) => {
                      const on = l === level;
                      return (
                        <button
                          key={l}
                          type="button"
                          role="radio"
                          aria-checked={on}
                          disabled={readOnly}
                          onClick={() => setLevel(area.key, l)}
                          className={`min-h-[44px] flex-1 rounded-md px-3 text-[13px] font-medium transition-colors motion-reduce:transition-none md:min-h-[32px] md:flex-none ${
                            on ? "shadow-sm" : "text-text-muted hover:text-text-primary disabled:hover:text-text-muted"
                          } disabled:cursor-not-allowed`}
                          style={on ? TONE_STYLE[levelTone(l)] : undefined}
                        >
                          {LEVEL_LABEL[l]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {hasAdvanced(area.key) && (
                  <Reveal open={advancedOpen(area.key, level)}>
                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg px-3 py-2.5">
                      <p className="text-[12px] font-semibold uppercase tracking-wide text-text-muted">
                        Advanced · {area.label}
                      </p>
                      <ul className="mt-1">
                        {area.key === "messages"
                          ? MESSAGES_SUBSCOPES.map((s) => (
                              <SubOption
                                key={s}
                                label={cap(MESSAGES_SUBSCOPE_LABEL[s])}
                                on={draft.messages[s]}
                                changed={draft.messages[s] !== saved.messages[s]}
                                disabled={readOnly}
                                onChange={(v) => {
                                  setFlash(null);
                                  setDraft((d) => ({ ...d, messages: { ...d.messages, [s]: v } }));
                                }}
                              />
                            ))
                          : BILLING_SUBSCOPES.map((s) => (
                              <SubOption
                                key={s}
                                label={cap(BILLING_SUBSCOPE_LABEL[s])}
                                on={draft.billing[s]}
                                changed={draft.billing[s] !== saved.billing[s]}
                                disabled={readOnly}
                                onChange={(v) => {
                                  setFlash(null);
                                  setDraft((d) => ({ ...d, billing: { ...d.billing, [s]: v } }));
                                }}
                              />
                            ))}
                      </ul>
                    </div>
                  </Reveal>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {!readOnly && (
        <div className="sticky bottom-[calc(72px+env(safe-area-inset-bottom))] z-20 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-app-border bg-surface px-4 py-3 shadow-lg md:bottom-4">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-text-muted" role="status">
            {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand" aria-hidden />}
            <span>
              {dirty
                ? `${changes.length} unsaved change${changes.length === 1 ? "" : "s"} to ${first}'s access`
                : flash ?? "No unsaved changes"}
            </span>
          </div>
          {dirty && (
            <button
              type="button"
              onClick={() => setDraft(saved)}
              className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            disabled={!dirty}
            onClick={() => {
              setError(null);
              setConfirming(true);
            }}
            className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}
          >
            Review and save
          </button>
        </div>
      )}

      <Sheet
        open={confirming}
        onClose={() => !saving && setConfirming(false)}
        dismissable={!saving}
        width={520}
        title={`Confirm ${changes.length} change${changes.length === 1 ? "" : "s"} to ${first}'s access`}
        description="Here is what will be different for them."
        footer={
          <>
            <button
              type="button"
              disabled={saving}
              onClick={() => setConfirming(false)}
              className={`${btn} border border-app-border text-text-primary hover:bg-app-bg disabled:opacity-50`}
            >
              Go back and edit
            </button>
            <button
              type="button"
              disabled={saving || changes.length === 0}
              onClick={save}
              className={`${btn} bg-brand text-white hover:opacity-90 disabled:opacity-50`}
            >
              {saving ? "Saving…" : `Confirm and save ${changes.length} change${changes.length === 1 ? "" : "s"}`}
            </button>
          </>
        }
      >
        <ul className="space-y-2">
          {changes.map((c) => {
            const up = c.sentence.includes(" will be able to ");
            const Icon = up ? Plus : Minus;
            return (
              <li
                key={c.key}
                className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-[13px] ${c.money ? "" : "bg-app-bg text-text-primary"}`}
                style={c.money ? { background: "var(--color-warn-surface)", color: "var(--color-warn-text)" } : undefined}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0">
                  {c.sentence}
                  {c.money && (
                    <span className="ml-1.5 inline-block rounded-full border border-[var(--color-warn-border)] px-1.5 text-[12px] font-medium">
                      Involves money
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex items-start gap-2 text-[12.5px] text-text-muted">
          <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Recorded under {me} on {today} in {first}&apos;s Recent activity. Takes effect within a minute — {first}{" "}
            doesn&apos;t need to sign out.
          </span>
        </p>
        {error && (
          <p
            role="alert"
            className="mt-3 rounded-lg px-3 py-2 text-[13px]"
            style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}
          >
            {error}
          </p>
        )}
      </Sheet>
    </div>
  );
}

function SubOption({
  label,
  on,
  changed,
  disabled,
  onChange,
}: {
  label: string;
  on: boolean;
  changed: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <li className="flex items-center gap-2 border-b border-[var(--color-hairline)] py-0.5 last:border-b-0">
      <span className="min-w-0 flex-1 text-[13px] text-text-primary">
        {label}
        {changed && (
          <span className="ml-1.5 rounded-full bg-brand/10 px-1.5 py-0.5 text-[12px] font-medium text-brand">Changed</span>
        )}
      </span>
      <Switch checked={on} onChange={onChange} label={label} disabled={disabled} />
    </li>
  );
}
