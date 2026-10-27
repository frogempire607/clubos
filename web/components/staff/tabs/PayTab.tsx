"use client";

// Pay tab on a staff profile. Since the pay ledger (Branch 2) a staff member
// can hold several named, dated pay plans, so the plan list and its editor are
// the shared PayPlansPanel (also Payroll → Pay plans). The pay schedule card is
// unchanged. Staff can see their own plans and their own pay lines but never
// change them — the server refuses, and this tab is read-only for them.
import { CLASSIFICATION_NOTE, WORKER_TYPES, workerTypeDescription, workerTypeLabel } from "@/lib/workerType";
import W9Card from "@/components/staff/W9Card";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight, Loader2, Lock } from "lucide-react";
import PayScheduleCard from "@/components/staff/pay/PayScheduleCard";
import PayPlansPanel from "@/components/staff/pay/PayPlansPanel";
import PrivateLessonPayCard from "@/components/staff/pay/PrivateLessonPayCard";
import type { StaffTabProps } from "@/components/staff/types";

export default function PayTab({ data, reload, setDirty }: StaffTabProps) {
  const { staff, viewer } = data;
  const first = staff.firstName || "this staff member";
  const [scheduleDirty, setScheduleDirty] = useState(false);

  useEffect(() => {
    setDirty(scheduleDirty);
  }, [scheduleDirty, setDirty]);
  useEffect(() => () => setDirty(false), [setDirty]);

  if (!viewer.canViewPay) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-dashed border-app-border bg-surface px-5 py-4 text-[13px] text-text-muted">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Pay is visible to the owner and staff with Financials &amp; payroll: view.</span>
      </div>
    );
  }

  const readOnly = !viewer.canEditPay || viewer.isSelf;
  return (
    <div className="pb-4">
      {readOnly && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-dashed border-app-border px-4 py-3 text-[13px] text-text-muted">
          <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {viewer.isSelf
              ? "Your pay is set by the owner."
              : `Only the owner and staff with Financials & payroll: full can change ${first}'s pay.`}
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1.55fr_1fr]">
        <div className="min-w-0">
          {/* Phase 12.1 — worker type comes FIRST, because it decides whether
              anything below is payroll or a 1099. */}
          <WorkerTypeCard
            staffId={staff.id}
            first={first}
            workerType={staff.workerType ?? null}
            contractorId={staff.contractorId ?? null}
            readOnly={readOnly}
            isSelf={viewer.isSelf}
            staffName={`${staff.firstName} ${staff.lastName}`.trim()}
            onChanged={() => void reload()}
          />
          <PayPlansPanel staffId={staff.id} onChanged={() => void reload()} />
          <PrivateLessonPayCard staffId={staff.id} first={first} isSelf={viewer.isSelf} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <PayScheduleCard
            staffId={staff.id}
            first={first}
            readOnly={readOnly}
            isSelf={viewer.isSelf}
            onDirtyChange={setScheduleDirty}
          />
          <section className="rounded-xl border border-app-border bg-surface p-4 sm:p-5">
            <h2 className="text-[15px] font-semibold text-text-primary">How pay is worked out</h2>
            <p className="mt-2 text-[13px] text-text-primary">
              A class day pays once it has ended, from the plan that best fits that class and role. Salary pays once per pay period. A substitute is paid from their own plan. A private lesson pays once it has finished, from the private lesson pay below the plans.
            </p>
            <p className="mt-2 text-[12.5px] text-text-muted">
              These are the plans, not an amount owed. Payroll shows what is owed, line by line.
            </p>
          </section>
          {!viewer.isSelf && (
            <section className="rounded-xl border border-app-border bg-surface p-2">
              <PayLink href={`/dashboard/staff/payroll?staff=${staff.id}`} title="Payroll" desc={`What ${first} is owed, line by line.`} />
              <PayLink href="/dashboard/staff/payouts" title="Payouts" desc={`Records what you actually paid ${first}, and when.`} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function PayLink({ href, title, desc }: { href: string; title: string; desc: string }) {
  return (
    <Link href={href} className="flex min-h-[44px] items-center gap-3 rounded-lg px-3 py-2.5 hover:bg-app-bg">
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium text-text-primary">{title}</span>
        <span className="block text-[12.5px] text-text-muted">{desc}</span>
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-text-muted" aria-hidden />
    </Link>
  );
}

// ── Worker type (Phase 12.1) ────────────────────────────────────────────────
//
// Employee or contractor. Deliberately UNSET by default and shown as such:
// classification is a legal determination with tax consequences, and
// AthletixOS must not make it for a club by defaulting everybody to one side.
//
// Gated on the same permission as pay (Financials & payroll: full), because
// this is what decides whether somebody is paid through payroll or gets a
// 1099 — that is pay, not staff administration.
function WorkerTypeCard({
  staffId,
  first,
  workerType,
  contractorId,
  readOnly,
  isSelf,
  staffName,
  onChanged,
}: {
  staffId: string;
  first: string;
  workerType: string | null;
  contractorId: string | null;
  readOnly: boolean;
  isSelf: boolean;
  staffName: string;
  onChanged: () => void;
}) {
  const [saving, setSaving] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const save = async (next: "EMPLOYEE" | "CONTRACTOR") => {
    setSaving(next);
    setErr("");
    try {
      const r = await fetch(`/api/staff/${staffId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workerType: next }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setErr(d?.error || "That couldn't be saved.");
      } else onChanged();
    } catch {
      setErr("That couldn't be saved.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-app-border bg-surface p-4 sm:p-5">
      <h2 className="text-[15px] font-semibold text-text-primary">Worker type</h2>
      <p className="mt-1 text-[13px] text-text-muted">{workerTypeDescription(workerType)}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {WORKER_TYPES.map((t) => {
          const active = workerType === t;
          return (
            <button
              key={t}
              type="button"
              disabled={readOnly || saving !== null}
              onClick={() => save(t)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[13px] disabled:cursor-not-allowed disabled:opacity-60 ${
                active
                  ? "border-charcoal bg-charcoal text-white"
                  : "border-app-border bg-surface text-text-primary hover:bg-app-bg"
              }`}
            >
              {saving === t && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {workerTypeLabel(t)}
            </button>
          );
        })}
      </div>

      {/* The one-line note the brief asks for. Short on purpose: it has to be
          read, not skimmed past, and it must not pretend to be legal advice. */}
      <p className="mt-3 text-[12.5px] text-text-muted">{CLASSIFICATION_NOTE}</p>

      {readOnly && !isSelf && (
        <p className="mt-2 text-[12.5px] text-text-muted">
          Only the owner and staff with Financials &amp; payroll: full can change {first}&apos;s worker type.
        </p>
      )}
      {err && (
        <p className="mt-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-[13px] text-red-800">{err}</p>
      )}

      {workerType === "CONTRACTOR" && contractorId && (
        <div className="mt-4">
          <W9Card mode="owner" contractorId={contractorId} staffName={staffName || first} />
        </div>
      )}
    </section>
  );
}
