"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Sparkles, Check } from "lucide-react";

export default function SignupPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"create" | "join">("create");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [clubSlug, setClubSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          firstName,
          lastName,
          email,
          password,
          mode,
          clubSlug: mode === "join" ? clubSlug : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Signup failed");
        setLoading(false);
        return;
      }

      const result = await signIn("credentials", {
        email,
        password,
        clubSlug: data.clubSlug,
        redirect: false,
      });

      setLoading(false);

      if (result?.error) {
        setError("Account created but login failed. Try signing in.");
        return;
      }

      router.push(mode === "create" ? "/onboarding" : "/dashboard");
    } catch {
      setError("Something went wrong");
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/circle.PNG" alt="AthletixOS" className="w-24 h-24 rounded-full" />
        </div>
        {mode === "create" && (
          <div className="mb-4 rounded-xl bg-gradient-to-br from-[#534AB7] to-[#1a1560] p-4 text-white">
            <div className="flex items-center gap-2 text-xs font-semibold mb-2">
              <Sparkles className="h-4 w-4" strokeWidth={2.5} />
              YOUR 14-DAY FREE TRIAL STARTS NOW
            </div>
            <ul className="space-y-1.5 text-xs text-white/85">
              {["No credit card required", "Full access to all Growth features", "Cancel anytime from settings"].map((b) => (
                <li key={b} className="flex items-center gap-2">
                  <Check className="h-3.5 w-3.5 text-lime-accent" strokeWidth={3} />
                  {b}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="bg-white rounded-xl shadow-sm border border-stone-200 p-8">
          <div className="mb-5">
            <span className="inline-block text-[11px] font-semibold uppercase tracking-wider text-stone-500 bg-stone-100 rounded-full px-2.5 py-1 mb-3">
              Club owners &amp; staff
            </span>
            <h1 className="text-2xl font-semibold text-stone-900 mb-1">Get started</h1>
            <p className="text-sm text-stone-500">
              {mode === "create"
                ? "Create your club on AthletixOS"
                : "Join an existing club as a coach or staff member"}
            </p>
          </div>

          {/* Members land here by mistake constantly — send them to the right place. */}
          <div className="mb-6 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2.5 text-xs text-stone-600">
            Are you an athlete or parent?{" "}
            <Link href="/member/signup" className="font-semibold text-stone-900 hover:underline">
              Create a member account →
            </Link>
          </div>

          <div className="flex gap-1 bg-stone-100 rounded-lg p-1 mb-6">
            <button
              type="button"
              onClick={() => setMode("create")}
              className={`flex-1 text-sm py-1.5 rounded-md transition ${
                mode === "create" ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"
              }`}
            >
              Create a club
            </button>
            <button
              type="button"
              onClick={() => setMode("join")}
              className={`flex-1 text-sm py-1.5 rounded-md transition ${
                mode === "join" ? "bg-white shadow-sm text-stone-900 font-medium" : "text-stone-600"
              }`}
            >
              Join a club
            </button>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === "join" && (
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Club code</label>
                <input
                  type="text"
                  value={clubSlug}
                  onChange={(e) => setClubSlug(e.target.value.toLowerCase())}
                  placeholder="apex-wrestling"
                  required
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
                <p className="text-xs text-stone-400 mt-1">Ask your club for their code</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">First name</label>
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-stone-700 mb-1">Last name</label>
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
                />
              </div>
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
                minLength={8}
                required
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
              />
              <p className="text-xs text-stone-400 mt-1">At least 8 characters</p>
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-2.5 bg-[#534AB7] text-white rounded-lg text-sm font-semibold hover:bg-[#3F389E] disabled:opacity-50 transition-colors"
            >
              {loading
                ? "Creating account…"
                : mode === "create"
                ? "Create account & start setup"
                : "Join club"}
            </button>
          </form>

          <div className="mt-6 text-center text-sm">
            <Link href="/login" className="text-stone-600 hover:text-stone-900">
              Already have an account? Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
