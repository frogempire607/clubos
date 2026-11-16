"use client";

// The page an emailed "Confirm my email" link opens. Public: the person may be
// on a different device from the one they signed up on. The confirmation
// happens when they press the button, not when the page loads — mail scanners
// open links, they do not press buttons.

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";

function VerifyEmail() {
  const token = useSearchParams().get("token") ?? "";
  const [state, setState] = useState<"idle" | "working" | "done" | "error">("idle");
  const [message, setMessage] = useState("");

  async function confirm() {
    if (state === "working") return;
    setState("working");
    try {
      const res = await fetch("/api/auth/verify-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(typeof d.error === "string" ? d.error : "That didn't work. Please try again.");
        setState("error");
        return;
      }
      const parts: string[] = [];
      if (d.linkedOwnRecord) parts.push("your own record");
      if (d.linkedChildren > 0) parts.push(d.linkedChildren === 1 ? "1 child" : `${d.linkedChildren} children`);
      setMessage(parts.length ? `We connected ${parts.join(" and ")} to your account.` : "Your account is ready.");
      setState("done");
    } catch {
      setMessage("No connection. Check your signal and try again.");
      setState("error");
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#F7F7F9] px-6 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-[#E5E7EB] bg-white p-6 text-center">
        <h1 className="text-xl font-semibold text-[#111111]">
          {state === "done" ? "Email confirmed" : "Confirm your email"}
        </h1>
        {state === "done" ? (
          <>
            <p className="mt-2 text-sm text-[#374151]">{message}</p>
            <Link href="/member" className="mt-5 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-[#1F1F23] px-4 text-sm font-semibold text-white">
              Open the portal
            </Link>
          </>
        ) : !token ? (
          <p className="mt-2 text-sm text-[#374151]">This link is incomplete. Open the newest email from us and use the button in it.</p>
        ) : (
          <>
            <p className="mt-2 text-sm text-[#374151]">
              Press the button to confirm this is your email address. Records your club already has under it are then connected to your account.
            </p>
            <button
              type="button"
              onClick={confirm}
              disabled={state === "working"}
              className="mt-5 min-h-[44px] w-full rounded-lg bg-[#6D5DF6] px-4 text-sm font-semibold text-white disabled:opacity-60"
            >
              {state === "working" ? "Confirming…" : "Confirm my email"}
            </button>
            {state === "error" && <p role="alert" className="mt-3 text-sm text-red-600">{message}</p>}
          </>
        )}
      </div>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
