"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

function ForgotForm() {
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  // Prefilled when arriving from the login page (which passes ?club=…), so a
  // staff member doesn't have to remember their club's exact short name.
  const [clubSlug, setClubSlug] = useState(searchParams.get("club") ?? "");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, clubSlug }),
    });

    setLoading(false);
    setSent(true);
  }

  if (sent) {
    return (
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-stone-900 mb-2">Check your email</h1>
        <p className="text-sm text-stone-500 mb-6">
          If an account exists with that email, we&apos;ve sent a password reset link. It can
          take a minute to arrive — check spam too.
        </p>
        <Link href="/login" className="text-sm text-stone-900 underline">
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Reset password</h1>
        <p className="text-sm text-stone-500">
          Enter your club and email and we&apos;ll send you a reset link.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Club</label>
          <input
            type="text"
            value={clubSlug}
            onChange={(e) => setClubSlug(e.target.value)}
            required
            placeholder="Your club name or short name"
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
          />
          <p className="text-xs text-stone-400 mt-1">
            Your club name or the short name from your club&apos;s web address.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
        >
          {loading ? "Sending…" : "Send reset link"}
        </button>
      </form>

      <div className="mt-6 text-center text-sm">
        <Link href="/login" className="text-stone-600 hover:text-stone-900">
          Back to sign in
        </Link>
      </div>
    </>
  );
}

export default function ForgotPasswordPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-8">
          <Suspense fallback={<div className="text-sm text-stone-400 text-center py-6">Loading…</div>}>
            <ForgotForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
