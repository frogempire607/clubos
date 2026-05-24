"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Invite = {
  partnerId: string;
  status: string;
  clubName: string;
  booking: {
    status: string;
    requestedSlots: { date: string; startTime: string; endTime: string }[];
    confirmedStartAt: string | null;
    confirmedEndAt: string | null;
    bookerName: string;
    lessonTitle: string;
    durationMin: number;
    coach: string | null;
  };
  prefill: { name: string | null; email: string | null; phone: string | null };
};

export default function PartnerInvitePage() {
  const params = useParams<{ token: string }>();
  const token = params.token;

  const [invite, setInvite] = useState<Invite | null>(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState<"" | "CONFIRMED" | "DECLINED">("");

  useEffect(() => {
    fetch(`/api/private-lessons/partner-invite/${token}`)
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setLoadError(d.error || "Invalid link");
          return;
        }
        const d = (await r.json()) as Invite;
        setInvite(d);
        setName(d.prefill.name || "");
        setEmail(d.prefill.email || "");
        setPhone(d.prefill.phone || "");
        if (d.status === "CONFIRMED") setOutcome("CONFIRMED");
        if (d.status === "DECLINED") setOutcome("DECLINED");
      })
      .finally(() => setLoading(false));
  }, [token]);

  async function send(action: "confirm" | "decline") {
    setSubmitting(true);
    setError("");
    const res = await fetch(`/api/private-lessons/partner-invite/${token}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        action === "confirm"
          ? {
              action,
              name: name.trim(),
              email: email.trim() || undefined,
              phone: phone.trim() || undefined,
              extras: notes.trim() ? { notes: notes.trim() } : undefined,
            }
          : { action },
      ),
    });
    const d = await res.json().catch(() => ({}));
    setSubmitting(false);
    if (!res.ok) {
      setError(d.error || "Could not submit");
      return;
    }
    setOutcome(action === "confirm" ? "CONFIRMED" : "DECLINED");
  }

  if (loading) {
    return <PageShell><p className="text-stone-500 text-sm">Loading…</p></PageShell>;
  }
  if (loadError || !invite) {
    return (
      <PageShell>
        <h1 className="text-xl font-semibold text-stone-900 mb-2">Invitation unavailable</h1>
        <p className="text-stone-600 text-sm">{loadError || "This link is no longer valid."}</p>
      </PageShell>
    );
  }

  if (outcome === "CONFIRMED") {
    return (
      <PageShell>
        <h1 className="text-xl font-semibold text-stone-900 mb-2">You&apos;re in!</h1>
        <p className="text-stone-600 text-sm">
          Thanks — {invite.clubName} has your details. You&apos;ll hear from {invite.booking.bookerName} or the coach with any final details.
        </p>
      </PageShell>
    );
  }
  if (outcome === "DECLINED") {
    return (
      <PageShell>
        <h1 className="text-xl font-semibold text-stone-900 mb-2">No problem.</h1>
        <p className="text-stone-600 text-sm">We&apos;ve let {invite.booking.bookerName} and the coach know.</p>
      </PageShell>
    );
  }

  const confirmedTime = invite.booking.confirmedStartAt
    ? new Date(invite.booking.confirmedStartAt).toLocaleString("en-US", {
        weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
      })
    : null;

  return (
    <PageShell>
      <p className="text-xs uppercase tracking-wider text-stone-500 mb-1">{invite.clubName}</p>
      <h1 className="text-xl font-semibold text-stone-900 mb-1">
        {invite.booking.bookerName} invited you to a private lesson
      </h1>
      <p className="text-sm text-stone-600 mb-4">
        Confirm your participation and share your contact info below.
      </p>

      <div className="bg-stone-50 border border-stone-200 rounded-lg p-4 mb-5 text-sm space-y-1.5">
        <div className="flex justify-between gap-3">
          <span className="text-stone-500">Lesson</span>
          <span className="text-stone-900 font-medium">{invite.booking.lessonTitle}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-stone-500">Duration</span>
          <span className="text-stone-900">{invite.booking.durationMin} min</span>
        </div>
        {invite.booking.coach && (
          <div className="flex justify-between gap-3">
            <span className="text-stone-500">Coach</span>
            <span className="text-stone-900">{invite.booking.coach}</span>
          </div>
        )}
        {confirmedTime && (
          <div className="flex justify-between gap-3">
            <span className="text-stone-500">When</span>
            <span className="text-stone-900">{confirmedTime}</span>
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); send("confirm"); }}
        className="space-y-3"
      >
        <Field label="Your name" required>
          <input value={name} onChange={(e) => setName(e.target.value)} required
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
        </Field>
        <Field label="Email">
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
        </Field>
        <Field label="Phone">
          <input value={phone} onChange={(e) => setPhone(e.target.value)}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
        </Field>
        <Field label="Anything we should know? (optional)">
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm" />
        </Field>

        {error && (
          <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md px-3 py-2">{error}</p>
        )}

        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={() => send("decline")}
            disabled={submitting}
            className="px-4 py-2 text-sm border border-stone-300 text-stone-700 rounded-md hover:bg-stone-50 disabled:opacity-50"
          >
            Decline
          </button>
          <button
            type="submit"
            disabled={submitting || !name.trim()}
            className="px-4 py-2 text-sm bg-stone-900 text-white rounded-md hover:bg-stone-700 disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Confirm"}
          </button>
        </div>
      </form>
    </PageShell>
  );
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-100 px-4 py-10 flex items-start justify-center">
      <div className="w-full max-w-md bg-white rounded-xl border border-stone-200 p-6">{children}</div>
    </div>
  );
}

function Field({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs text-stone-500 mb-1">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
