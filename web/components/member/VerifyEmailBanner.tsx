"use client";
import { memberErrorText } from "@/lib/memberErrorText";

// Shown in the member portal only when BOTH are true: this account has not
// confirmed its email, and the club already has something under that email
// (the person's own record, or children). Without it the account would just
// look unexpectedly empty. Everyone else never sees it.

import { useEffect, useState } from "react";
import { sharedGet } from "@/lib/sharedGet";
import { invalidateAthleteProfiles } from "@/components/member/AthleteRail";

type Status = { verified: boolean; pending: boolean };

export default function VerifyEmailBanner() {
  const [status, setStatus] = useState<Status | null>(null);
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    const check = () =>
      sharedGet<Status>("/api/member/email-verification", { cache: "no-store" })
        .then((r) => {
          if (!alive || !r.ok || !r.data) return;
          setStatus((prev) => {
            // Confirmed in another tab or on another device: bring the
            // family in without asking for a reload.
            if (prev && !prev.verified && r.data!.verified) invalidateAthleteProfiles();
            return r.data;
          });
        })
        .catch(() => undefined);
    void check();
    // People confirm in their mail app and come straight back.
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  if (!status || status.verified || !status.pending) return null;

  async function resend() {
    if (sent === "sending") return;
    setSent("sending");
    try {
      const res = await fetch("/api/member/email-verification", { method: "POST" });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setSent("sent"); setNote("Sent. Check your inbox, and your spam folder."); }
      else { setSent("error"); setNote(memberErrorText(d, "We couldn't send it. Please try again.")); }
    } catch {
      setSent("error");
      setNote("No connection. Try again.");
    }
  }

  return (
    <div role="status" className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
      <p className="text-[15px] font-semibold text-stone-900">Confirm your email to see your records</p>
      <p className="mt-1 text-sm text-stone-700">
        Your club already has records under your email address. We sent you a link — open it and they will appear here.
      </p>
      <button
        type="button"
        onClick={resend}
        disabled={sent === "sending"}
        className="mt-3 min-h-[44px] rounded-lg border border-stone-300 bg-white px-4 text-sm font-medium text-stone-900 disabled:opacity-60"
      >
        {sent === "sending" ? "Sending…" : "Send the link again"}
      </button>
      {note && <p className="mt-2 text-[13px] text-stone-700">{note}</p>}
    </div>
  );
}
