"use client";

// The coach proposed something different — accept or decline (plan.md §5.4.7).
//
// This is the ONE place a family answers, and every route into it lands here:
// the email button, the DM in the coach thread, the family approvals card, and
// the pill on Bookings. It renders from /api/member/registrations, which builds
// its copy with the same resolver the confirmation page and the emails use, so
// what the parent reads here matches what they were sent.

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, EmptyState, AccentButton, GhostButton } from "@/components/member/ui";

type Registration = {
  id: string;
  memberName: string;
  eventName: string;
  startsAt: string;
  key: string;
  headline: string;
  subheadline: string | null;
  chargeTiming: string;
  waitingOn: string;
  confirmationCode: string;
  amountDue: number | null;
  amountPaid: number | null;
  eventId: string;
  proposedChange: {
    original: Record<string, unknown>;
    proposed: Record<string, unknown>;
    priceDelta: number;
    proposedAt: string;
    coachNote: string | null;
  } | null;
};

const FIELD_LABEL: Record<string, string> = {
  weightClass: "Weight class",
  division: "Division",
  session: "Session",
  addAnotherDual: "Additional dual",
  freeText: "Note",
};

const money = (n: number) => `$${n.toFixed(2)}`;

function value(v: unknown): string {
  if (v === true) return "Yes";
  if (v === false || v == null || v === "") return "—";
  return String(v);
}

export default function ProposalResponsePage() {
  const params = useParams<{ regId: string }>();
  const router = useRouter();
  const [reg, setReg] = useState<Registration | null>(null);
  const [loading, setLoading] = useState(true);
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<"accepted" | "declined" | null>(null);

  useEffect(() => {
    fetch("/api/member/registrations")
      .then((r) => (r.ok ? r.json() : { registrations: [] }))
      .then((d) => {
        const found = (d.registrations ?? []).find((x: Registration) => x.id === params.regId) ?? null;
        setReg(found);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [params.regId]);

  const proposal = reg?.proposedChange ?? null;
  const delta = proposal?.priceDelta ?? 0;
  const consentLabel =
    delta > 0 ? `I authorize the additional ${money(delta)} if I accept this change` : undefined;

  async function respond(action: "accept" | "decline") {
    if (!reg) return;
    setBusy(action);
    setErr("");
    const res = await fetch(
      `/api/member/events/${reg.eventId}/registrations/${reg.id}/proposal/${action}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "accept" && delta > 0
            ? { additionalConsent: { agreed: true, buttonLabel: consentLabel, amount: delta } }
            : {},
        ),
      },
    );
    const d = await res.json().catch(() => ({}));
    setBusy(null);
    if (!res.ok) {
      setErr(d.message || d.error || "That didn't go through. Try again.");
      return;
    }
    setDone(action === "accept" ? "accepted" : "declined");
    // The money side may have failed even though the answer landed — say so
    // rather than letting the family think a payment link is on its way.
    if (d.chargeError) setErr(`Your card charge didn't go through: ${d.chargeError}`);
    else if (d.invoiceError) setErr(`We couldn't send the payment link: ${d.invoiceError}`);
    else if (d.refund?.error) setErr("Your refund needs a hand — please contact the club.");
  }

  if (loading) {
    return <p className="text-sm text-stone-500">Loading…</p>;
  }

  if (!reg) {
    return (
      <EmptyState
        title="This registration isn't available"
        description="It may have been withdrawn, or it belongs to a different account."
        action={<GhostButton href="/member/bookings">Back to bookings</GhostButton>}
      />
    );
  }

  if (done) {
    return (
      <Card className="p-5">
        <h1 className="text-lg font-semibold text-stone-900">
          {done === "accepted" ? "Thanks — you're all set" : "Registration withdrawn"}
        </h1>
        <p className="text-sm text-stone-600 mt-1">
          {done === "accepted"
            ? `We've told your coach, and ${reg.memberName}'s registration for ${reg.eventName} has been updated.`
            : `We've told your coach that ${reg.memberName} won't be competing at ${reg.eventName}.`}
        </p>
        {err && <p className="text-sm text-amber-700 mt-2">{err}</p>}
        <div className="mt-4 flex gap-2">
          <AccentButton onClick={() => router.push("/member/bookings")}>Back to bookings</AccentButton>
        </div>
      </Card>
    );
  }

  if (!proposal || reg.waitingOn !== "PARENT") {
    return (
      <Card className="p-5">
        <h1 className="text-lg font-semibold text-stone-900">{reg.headline}</h1>
        <p className="text-sm text-stone-600 mt-1">{reg.chargeTiming}</p>
        <p className="text-xs text-stone-500 mt-3">
          There&apos;s nothing waiting on you for this registration right now.
        </p>
        <div className="mt-4">
          <GhostButton href="/member/bookings">Back to bookings</GhostButton>
        </div>
      </Card>
    );
  }

  const keys = [...new Set([...Object.keys(proposal.proposed), ...Object.keys(proposal.original)])];

  return (
    <div className="max-w-xl">
      <div className="mb-4">
        <Link href="/member/bookings" className="text-xs text-stone-500 hover:text-stone-900">
          ← Bookings
        </Link>
        <h1 className="text-[22px] font-extrabold tracking-[-0.01em] text-stone-900 mt-1">
          Your coach proposed a change
        </h1>
        <p className="text-sm text-stone-500 mt-0.5">
          {reg.memberName} · {reg.eventName} · #{reg.confirmationCode}
        </p>
      </div>

      <Card className="p-5">
        {proposal.coachNote && (
          <blockquote className="border-l-2 border-stone-300 pl-3 text-sm text-stone-700 mb-4">
            {proposal.coachNote}
          </blockquote>
        )}

        <div className="rounded-lg border border-stone-200 overflow-hidden">
          <div className="grid grid-cols-2 text-[11px] uppercase tracking-wide text-stone-500 bg-stone-50">
            <div className="px-3 py-2">You signed up for</div>
            <div className="px-3 py-2 border-l border-stone-200">Your coach proposes</div>
          </div>
          {keys.map((k) => (
            <div key={k} className="grid grid-cols-2 text-sm border-t border-stone-200">
              <div className="px-3 py-2">
                <span className="block text-[11px] text-stone-500">{FIELD_LABEL[k] ?? k}</span>
                {value(proposal.original[k])}
              </div>
              <div className="px-3 py-2 border-l border-stone-200 bg-stone-50/60">
                <span className="block text-[11px] text-stone-500">{FIELD_LABEL[k] ?? k}</span>
                <strong>{value(proposal.proposed[k])}</strong>
              </div>
            </div>
          ))}
        </div>

        <p className="text-sm text-stone-700 mt-4">
          {delta > 0
            ? // amountDue is what they owe TODAY, before accepting — the total
              // has to be the after figure, or the sentence contradicts the
              // number on the button.
              `Accepting adds ${money(delta)} to what you owe${
                reg.amountDue != null ? ` — ${money(reg.amountDue + delta)} in total` : ""
              }.`
            : "Accepting doesn't change what you owe."}
        </p>
        <p className="text-xs text-stone-500 mt-1">
          Declining withdraws {reg.memberName} from this event
          {reg.amountPaid ? " and refunds what you've paid" : ""}.
        </p>

        {delta > 0 && (
          <label className="flex items-start gap-2.5 p-3 mt-3 rounded-lg bg-stone-50 border border-stone-200 cursor-pointer">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              className="mt-0.5"
            />
            <span className="text-xs text-stone-700">{consentLabel}.</span>
          </label>
        )}

        {err && <p className="text-sm text-red-600 mt-3">{err}</p>}

        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <AccentButton
            onClick={() => respond("accept")}
            disabled={busy !== null || (delta > 0 && !consented)}
            className="flex-1"
          >
            {busy === "accept"
              ? "Accepting…"
              : delta > 0
                ? `Accept — adds ${money(delta)}`
                : "Accept this change"}
          </AccentButton>
          <button
            type="button"
            onClick={() => respond("decline")}
            disabled={busy !== null}
            className="flex-1 py-2.5 rounded-lg border border-stone-300 text-sm font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-40"
          >
            {busy === "decline" ? "Withdrawing…" : "Decline and withdraw"}
          </button>
        </div>
      </Card>
    </div>
  );
}
