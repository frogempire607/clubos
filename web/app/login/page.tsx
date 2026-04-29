"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clubSlug, setClubSlug] = useState("");
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
      setError("Invalid email, password, or club");
      return;
    }

    // Fetch session to determine role-based redirect
    const sessionRes = await fetch("/api/auth/session");
    const session = await sessionRes.json();
    const role = session?.user?.role;
    if (role === "MEMBER") {
      router.push("/member");
    } else {
      router.push("/dashboard");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-stone-900 mb-1">Welcome back</h1>
            <p className="text-sm text-stone-500">Sign in to your club account</p>
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
              {loading ? "Signing in…" : "Sign in"}
            </button>
          </form>

          <div className="mt-6 flex justify-between text-sm">
            <Link href="/forgot-password" className="text-stone-600 hover:text-stone-900">
              Forgot password?
            </Link>
            <Link href="/signup" className="text-stone-600 hover:text-stone-900">
              Open a club
            </Link>
          </div>
          <div className="mt-3 text-center">
            <p className="text-xs text-stone-400">
              Joining as a member?{" "}
              <Link href="/member/signup" className="text-stone-600 hover:text-stone-900 font-medium">
                Member sign up
              </Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
