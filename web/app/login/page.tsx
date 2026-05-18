"use client";

import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";

type Role = "staff" | "member";

function LoginInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [role, setRole] = useState<Role>(
    searchParams.get("role") === "member" ? "member" : "staff",
  );
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clubSlug, setClubSlug] = useState(searchParams.get("club") ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const result = await signIn("credentials", {
      email,
      password,
      clubSlug,
      redirect: false,
    });

    setLoading(false);

    if (result?.error) {
      setError("Invalid email, password, or club. Please try again.");
      return;
    }

    // Role-based redirect (the account's real role wins, regardless of tab).
    const sessionRes = await fetch("/api/auth/session");
    const session = await sessionRes.json();
    const userRole = session?.user?.role;
    if (userRole === "MEMBER") router.push("/member");
    else router.push("/dashboard");
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
