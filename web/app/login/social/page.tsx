"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { memberErrorText } from "@/lib/memberErrorText";

// After "Continue with Google / Apple" found no account to sign in to.
//
// The same two choices whatever the reason (a hidden Apple address, an
// address the provider hasn't verified, a staff login, or no account at all),
// so this page never tells anyone whether an account exists:
//   1. Link to my existing account: sign in once with its password; from then
//      on Google / Apple works by itself.
//   2. Create an account: the normal signup, without a password.

type Pending = {
  provider: "google" | "apple";
  providerLabel: string;
  email: string | null;
  hiddenEmail: boolean;
  firstName: string | null;
  lastName: string | null;
  clubSlug: string;
  clubName: string | null;
};

const input =
  "w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-surface text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-brand";

function Inner() {
  const searchParams = useSearchParams();
  const [pending, setPending] = useState<Pending | null | undefined>(undefined);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth/social/pending", { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { pending: Pending | null }) => {
        setPending(d.pending);
        if (d.pending?.email) setEmail(d.pending.email);
      })
      .catch(() => setPending(null));
  }, []);

  async function link(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await fetch("/api/auth/social/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || typeof d.next !== "string") {
        setError(memberErrorText(d, "That didn't work. Please try again."));
        setBusy(false);
        return;
      }
      const next = searchParams.get("next");
      window.location.assign(next && next.startsWith("/member") ? `${d.next}&next=${encodeURIComponent(next)}` : d.next);
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
      setBusy(false);
    }
  }

  async function cancel() {
    await fetch("/api/auth/social/pending", { method: "DELETE" }).catch(() => undefined);
    window.location.assign(pending?.clubSlug ? `/login?club=${encodeURIComponent(pending.clubSlug)}` : "/login");
  }

  if (pending === undefined) {
    return <p className="text-sm text-text-muted text-center">Loading…</p>;
  }
  if (pending === null) {
    return (
      <div className="text-center space-y-3">
        <p className="text-sm text-text-primary">That sign-in attempt expired. Please try again.</p>
        <Link href="/login" className="text-sm font-medium text-brand hover:underline">Back to sign in</Link>
      </div>
    );
  }

  const who = pending.hiddenEmail ? `with ${pending.providerLabel} (email hidden)` : pending.email ? `as ${pending.email}` : `with ${pending.providerLabel}`;
  const signupHref = `/member/signup?club=${encodeURIComponent(pending.clubSlug)}&social=1`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-text-primary mb-1">Which account is yours?</h1>
        <p className="text-sm text-text-muted">
          You signed in to {pending.providerLabel} {who}. Choose how to continue{pending.clubName ? ` at ${pending.clubName}` : ""}.
        </p>
      </div>

      <form onSubmit={link} className="space-y-3 rounded-xl border border-app-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">I already have an account</h2>
        <p className="text-xs text-text-muted">
          Sign in once with your email and password. {pending.providerLabel} is then connected, and you can use it next time.
        </p>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1" htmlFor="link-email">Email</label>
          <input id="link-email" type="email" required autoComplete="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
            value={email} onChange={(e) => setEmail(e.target.value)} className={input} />
        </div>
        <div>
          <label className="block text-sm font-medium text-text-primary mb-1" htmlFor="link-password">Password</label>
          <input id="link-password" type="password" required autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <button type="submit" disabled={busy} className="w-full min-h-11 py-2.5 bg-charcoal text-white rounded-lg text-sm font-medium hover:bg-charcoal-hover disabled:opacity-50">
          {busy ? "Linking…" : `Link ${pending.providerLabel} to my account`}
        </button>
        <Link href={`/forgot-password?club=${encodeURIComponent(pending.clubSlug)}`} className="block text-xs text-center text-text-muted hover:text-text-primary">
          Forgot your password?
        </Link>
      </form>

      <div className="space-y-3 rounded-xl border border-app-border p-4">
        <h2 className="text-sm font-semibold text-text-primary">I&apos;m new here</h2>
        <p className="text-xs text-text-muted">
          Create an account with {pending.providerLabel}. No password needed.
          {pending.hiddenEmail ? " You'll be asked for an email address the club can reach you at." : ""}
        </p>
        <a href={signupHref} className="block w-full min-h-11 py-2.5 text-center border border-app-border rounded-lg text-sm font-medium text-text-primary hover:bg-app-bg">
          Create an account
        </a>
      </div>

      <button type="button" onClick={cancel} className="block mx-auto min-h-11 text-sm text-text-muted hover:text-text-primary">
        Cancel and go back
      </button>
    </div>
  );
}

export default function SocialChoicePage() {
  return (
    <div className="dashboard-root min-h-dvh flex items-center justify-center bg-app-bg px-4 py-10">
      <div className="w-full max-w-md bg-surface rounded-xl shadow-sm border border-app-border p-6 sm:p-8">
        <Suspense fallback={<p className="text-sm text-text-muted text-center">Loading…</p>}>
          <Inner />
        </Suspense>
      </div>
    </div>
  );
}
