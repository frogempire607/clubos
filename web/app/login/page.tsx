"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";

type Role = "staff" | "member";

function LoginInner() {
  const searchParams = useSearchParams();

  const [role, setRole] = useState<Role>(
    searchParams.get("role") === "member" ? "member" : "staff",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clubSlug, setClubSlug] = useState(searchParams.get("club") ?? "");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    searchParams.get("memberRedirect") === "1"
      ? "That login is a member account, so we sent it to the member portal."
      : "",
  );
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);

    let result;
    try {
      result = await signIn("credentials", {
        email,
        password,
        clubSlug,
        redirect: false,
      });
    } catch {
      setLoading(false);
      setError("Could not reach the server. Check your connection and try again.");
      return;
    }

    if (!result || result.error) {
      setLoading(false);
      // CredentialsSignin = authorize() returned null (bad email/password/club).
      // Any other string = NextAuth/runtime config error worth surfacing.
      setError(
        !result?.error || result.error === "CredentialsSignin"
          ? "Invalid email, password, or club. Please try again."
          : `Sign-in error: ${result.error}`,
      );
      return;
    }

    // Hard-nav to a server-side post-login redirect. The server reads the
    // JWT cookie (which was just written by /api/auth/callback/credentials)
    // and 307s to /dashboard or /member based on the account's real role.
    // This avoids any client-side session hydration race — important for
    // Capacitor iOS WKWebView where next-auth/react's getSession() can race
    // the cookie write and silently return null.
    //
    // Safari (desktop + iOS WebKit) sometimes hasn't fully committed the
    // Set-Cookie from the signIn POST by the time we navigate. Yielding
    // through a macrotask boundary forces the cookie write to flush before
    // the next request fires. Chrome doesn't need this, but it's cheap.
    await new Promise((r) => setTimeout(r, 0));

    if (typeof window !== "undefined") {
      const fromRole = role === "staff" ? "staff" : "member";
      window.location.href = `/post-login?fromRole=${fromRole}`;
    }
    // Intentionally leave `loading` true — the page is unmounting.
  }

  const isStaff = role === "staff";

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/circle.PNG" alt="AthletixOS" className="w-24 h-24 rounded-full" />
        </div>

        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-8">
          {/* Role selector — makes it obvious which kind of account you're using */}
          <div className="grid grid-cols-2 gap-2 mb-6">
            <button
              type="button"
              onClick={() => setRole("staff")}
              className={`rounded-lg border px-3 py-3 text-left transition ${
                isStaff
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
              }`}
            >
              <div className="text-sm font-semibold">Club / Staff</div>
              <div className={`text-xs mt-0.5 ${isStaff ? "text-white/70" : "text-stone-500"}`}>
                Owners &amp; coaches
              </div>
            </button>
            <button
              type="button"
              onClick={() => setRole("member")}
              className={`rounded-lg border px-3 py-3 text-left transition ${
                !isStaff
                  ? "border-stone-900 bg-stone-900 text-white"
                  : "border-stone-200 bg-white text-stone-600 hover:border-stone-300"
              }`}
            >
              <div className="text-sm font-semibold">Member / Parent</div>
              <div className={`text-xs mt-0.5 ${!isStaff ? "text-white/70" : "text-stone-500"}`}>
                Athletes &amp; guardians
              </div>
            </button>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-stone-900 mb-1">
              {isStaff ? "Club sign in" : "Member sign in"}
            </h1>
            <p className="text-sm text-stone-500">
              {isStaff
                ? "Access your club dashboard"
                : "View your schedule, documents, and bookings"}
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Club</label>
              <input
                type="text"
                value={clubSlug}
                onChange={(e) => setClubSlug(e.target.value)}
                placeholder="apex-wrestling"
                required
                // iOS WKWebView's default keyboard would otherwise capitalize
                // the first letter and run autocorrect, turning a valid slug
                // like `apex-wrestling` into `Apex-wrestling` and 401'ing the
                // login. Same reasoning for autoComplete="off" — Keychain
                // would suggest "Username" autofill on a slug field.
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
                inputMode="text"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <p className="text-xs text-stone-400 mt-1">
                {isStaff
                  ? "Your club's URL code"
                  : "The club code your coach gave you"}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="email"
                inputMode="email"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="current-password"
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            {notice && (
              <div className="text-sm text-stone-700 bg-stone-50 border border-stone-200 rounded-lg px-3 py-2">
                {notice}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
            >
              {loading ? "Signing in…" : isStaff ? "Sign in to dashboard" : "Sign in to portal"}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-stone-100">
            <Link
              href="/forgot-password"
              className="block text-sm text-center text-stone-600 hover:text-stone-900 mb-3"
            >
              Forgot password?
            </Link>
            {isStaff ? (
              <p className="text-sm text-center text-stone-500">
                New to AthletixOS?{" "}
                <Link href="/signup" className="text-stone-900 font-medium hover:underline">
                  Open a club
                </Link>
              </p>
            ) : (
              <p className="text-sm text-center text-stone-500">
                Joining a club?{" "}
                <Link
                  href="/member/signup"
                  className="text-stone-900 font-medium hover:underline"
                >
                  Create a member account
                </Link>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center bg-stone-50 text-sm text-stone-400">
          Loading…
        </div>
      }
    >
      <LoginInner />
    </Suspense>
  );
}
