"use client";

// First-time staff account setup. The owner emails a setup link with a
// resetToken; the staff member chooses a password here. The endpoint is the
// existing /api/auth/reset-password which clears the token after first use,
// so the link is single-use by construction.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

function SetupForm() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const clubSlug = params.get("club") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) setError("This setup link is invalid or missing a token. Ask your club owner to resend it.");
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setLoading(true);
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, password }),
    });
    setLoading(false);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setError(data.error || "Setup failed. The link may have expired.");
      return;
    }
    setDone(true);
    // Send them to the staff/owner side of the login screen with the club
    // pre-filled so they don't have to retype it.
    const params = new URLSearchParams({ role: "staff" });
    if (clubSlug) params.set("club", clubSlug);
    setTimeout(() => router.push(`/login?${params.toString()}`), 1800);
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="text-3xl mb-3">✓</div>
        <h1 className="text-2xl font-semibold text-stone-900 mb-2">Account activated</h1>
        <p className="text-sm text-stone-500">Redirecting you to sign in…</p>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Set up your staff account</h1>
        <p className="text-sm text-stone-500">
          Choose a password for your account. You&apos;ll use it to sign in from the
          Club / Staff side of the login page.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Create password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Confirm password</label>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            placeholder="Repeat your password"
            autoComplete="new-password"
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
          />
        </div>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !token}
          className="w-full py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
        >
          {loading ? "Activating…" : "Activate account"}
        </button>

        <p className="text-xs text-stone-400 text-center">
          Already activated?{" "}
          <Link href={`/login?role=staff${clubSlug ? `&club=${encodeURIComponent(clubSlug)}` : ""}`} className="underline text-stone-600">
            Sign in
          </Link>
        </p>
      </form>
    </>
  );
}

export default function StaffSetupPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/circle.PNG" alt="AthletixOS" className="w-24 h-24 rounded-full" />
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-8">
          <Suspense fallback={<div className="text-sm text-stone-400 text-center py-6">Loading…</div>}>
            <SetupForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
