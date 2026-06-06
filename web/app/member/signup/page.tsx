"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { User, Baby, Users, type LucideIcon } from "lucide-react";
import { TERMS_VERSION, PRIVACY_VERSION } from "@/legal/versions";

type AccountType = "ADULT_ATHLETE" | "MINOR_ATHLETE" | "PARENT";

export default function MemberSignupPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [clubSlug, setClubSlug] = useState("");

  // Prefill the club when arriving from a kiosk QR (/c/[id] → ?club=slug).
  useEffect(() => {
    const c = new URLSearchParams(window.location.search).get("club");
    if (c) setClubSlug(c.toLowerCase());
  }, []);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("ADULT_ATHLETE");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Minor fields
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("Parent");

  // Parent fields
  const [childEmail, setChildEmail] = useState("");
  const [relationship, setRelationship] = useState("Parent");

  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  function canContinueStep1() {
    return !!clubSlug.trim();
  }
  function canContinueStep2() {
    return !!(firstName && lastName && email && password);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // The whole wizard is one <form>, so pressing Enter on step 1/2 would
    // otherwise fire this submit with incomplete data. Advance instead.
    if (step === 1) {
      if (canContinueStep1()) setStep(2);
      return;
    }
    if (step === 2) {
      if (canContinueStep2()) setStep(3);
      return;
    }

    if (!acceptedTerms) {
      setError("You must agree to the Terms of Service and Privacy Policy.");
      return;
    }

    setLoading(true);
    setError("");

    const res = await fetch("/api/member/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clubSlug: clubSlug.trim().toLowerCase(),
        firstName,
        lastName,
        email,
        password,
        accountType,
        dateOfBirth: dateOfBirth || undefined,
        guardianName: accountType === "MINOR_ATHLETE" ? guardianName : undefined,
        guardianEmail: accountType === "MINOR_ATHLETE" ? guardianEmail : undefined,
        guardianPhone: accountType === "MINOR_ATHLETE" ? guardianPhone : undefined,
        guardianRelationship: accountType === "MINOR_ATHLETE" ? guardianRelationship : undefined,
        childEmail: accountType === "PARENT" ? childEmail : undefined,
        relationship: accountType === "PARENT" ? relationship : undefined,
        acceptedTerms: true,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      let msg = "Sign up failed. Please try again.";
      if (typeof data.error === "string") {
        msg = data.error;
      } else if (Array.isArray(data.error) && data.error[0]?.message) {
        // Zod validation errors come back as an array.
        msg = data.error[0].message;
      }
      setError(msg);
      setLoading(false);
      return;
    }

    // Sign in after successful signup
    const loginRes = await signIn("credentials", {
      email,
      password,
      clubSlug: clubSlug.trim().toLowerCase(),
      redirect: false,
    });

    setLoading(false);
    if (loginRes?.ok) {
      window.location.href = "/member";
    } else {
      // Account exists now — send them to login rather than a dead end.
      setError("Account created! Redirecting you to sign in…");
      setTimeout(() => {
        window.location.href = `/login?club=${encodeURIComponent(clubSlug.trim().toLowerCase())}`;
      }, 1200);
    }
  }

  const ACCOUNT_TYPES: { id: AccountType; label: string; desc: string; Icon: LucideIcon }[] = [
    {
      id: "ADULT_ATHLETE",
      label: "Adult Athlete",
      desc: "I'm joining as an athlete (18+)",
      Icon: User,
    },
    {
      id: "MINOR_ATHLETE",
      label: "Young Athlete",
      desc: "I'm under 18 — a parent or guardian will also sign up",
      Icon: Baby,
    },
    {
      id: "PARENT",
      label: "Parent / Guardian",
      desc: "I'm managing my child's account",
      Icon: Users,
    },
  ];

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Join your club</h1>
          <p className="text-sm text-stone-500">Create your member account</p>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-6">
          {[1, 2, 3].map((s) => (
            <div key={s} className="flex items-center gap-2 flex-1">
              <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                step >= s ? "bg-stone-900 text-white" : "bg-stone-200 text-stone-500"
              }`}>
                {s}
              </div>
              {s < 3 && <div className={`flex-1 h-0.5 ${step > s ? "bg-stone-900" : "bg-stone-200"}`} />}
            </div>
          ))}
        </div>

        <div className="bg-white rounded-xl border border-stone-200 p-6">
          <form onSubmit={handleSubmit}>
            {/* Step 1: Club + Account type */}
            {step === 1 && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Club URL</label>
                  <div className="flex items-center border border-stone-300 rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-stone-900">
                    <span className="px-3 py-2 bg-stone-50 text-stone-400 text-sm border-r border-stone-300 flex-shrink-0">
                      athletix-os.com/
                    </span>
                    <input
                      type="text"
                      value={clubSlug}
                      onChange={(e) => setClubSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      required
                      placeholder="my-club"
                      className="flex-1 px-3 py-2 text-sm focus:outline-none"
                    />
                  </div>
                  <p className="text-xs text-stone-400 mt-1">Your coach or club owner will give you this URL</p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-2">I am a…</label>
                  <div className="space-y-2">
                    {ACCOUNT_TYPES.map((type) => (
                      <label
                        key={type.id}
                        className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition ${
                          accountType === type.id
                            ? "border-stone-900 bg-stone-50"
                            : "border-stone-200 hover:border-stone-300"
                        }`}
                      >
                        <input
                          type="radio"
                          name="accountType"
                          value={type.id}
                          checked={accountType === type.id}
                          onChange={() => setAccountType(type.id)}
                          className="mt-0.5 accent-stone-900"
                        />
                        <div>
                          <p className="text-sm font-medium text-stone-900 inline-flex items-center gap-2">
                            <type.Icon className="h-4 w-4 text-stone-700" strokeWidth={2} />
                            {type.label}
                          </p>
                          <p className="text-xs text-stone-500">{type.desc}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setStep(2)}
                  disabled={!clubSlug.trim()}
                  className="w-full px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                >
                  Continue
                </button>
              </div>
            )}

            {/* Step 2: Personal info */}
            {step === 2 && (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">First name</label>
                    <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">Last name</label>
                    <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Email address</label>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">Password</label>
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8}
                    placeholder="At least 8 characters"
                    className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                </div>

                {(accountType === "ADULT_ATHLETE" || accountType === "MINOR_ATHLETE") && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">Date of birth {accountType === "ADULT_ATHLETE" ? "(optional)" : ""}</label>
                    <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)}
                      required={accountType === "MINOR_ATHLETE"}
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                  </div>
                )}

                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep(1)}
                    className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">
                    Back
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep(3)}
                    disabled={!firstName || !lastName || !email || !password}
                    className="flex-1 px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
                  >
                    Continue
                  </button>
                </div>
              </div>
            )}

            {/* Step 3: Type-specific info + confirm */}
            {step === 3 && (
              <div className="space-y-4">
                {accountType === "MINOR_ATHLETE" && (
                  <>
                    <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                      Since you're under 18, please provide a parent or guardian's contact info. They'll need to sign some documents on your behalf.
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-stone-700 mb-1">Guardian full name</label>
                      <input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} required
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">Guardian email</label>
                        <input type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} required
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">Relationship</label>
                        <select value={guardianRelationship} onChange={(e) => setGuardianRelationship(e.target.value)}
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none">
                          <option>Parent</option>
                          <option>Guardian</option>
                          <option>Grandparent</option>
                          <option>Other</option>
                        </select>
                      </div>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-stone-700 mb-1">Guardian phone (optional)</label>
                      <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)}
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                    </div>
                  </>
                )}

                {accountType === "PARENT" && (
                  <>
                    <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700">
                      As a parent/guardian, you can monitor your child's schedule, sign documents on their behalf, and message coaches.
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-stone-700 mb-1">Your child's email (optional)</label>
                      <input type="email" value={childEmail} onChange={(e) => setChildEmail(e.target.value)}
                        placeholder="Child's email or leave blank to link later"
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                      <p className="text-xs text-stone-400 mt-1">Must match the email used when your child was registered</p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-stone-700 mb-1">Your relationship</label>
                      <select value={relationship} onChange={(e) => setRelationship(e.target.value)}
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none">
                        <option>Parent</option>
                        <option>Guardian</option>
                        <option>Grandparent</option>
                        <option>Other</option>
                      </select>
                    </div>
                  </>
                )}

                {accountType === "ADULT_ATHLETE" && (
                  <div className="py-4 text-center">
                    <div className="mx-auto mb-3 inline-flex h-12 w-12 items-center justify-center rounded-full bg-stone-100 text-stone-700">
                      <User className="h-6 w-6" strokeWidth={2} />
                    </div>
                    <p className="text-sm text-stone-700 font-medium">Ready to create your account!</p>
                    <p className="text-xs text-stone-500 mt-1">
                      Signing up as <strong>{firstName} {lastName}</strong> at <strong>athletix-os.com/{clubSlug}</strong>
                    </p>
                  </div>
                )}

                <label className="flex items-start gap-2 text-sm text-stone-700">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    required
                    className="mt-1 h-4 w-4 rounded border-stone-300 text-[#534AB7] focus:ring-[#534AB7]"
                  />
                  <span>
                    I agree to the{" "}
                    <Link href="/terms" target="_blank" className="font-medium text-[#534AB7] underline">
                      Terms of Service
                    </Link>{" "}
                    and{" "}
                    <Link href="/privacy" target="_blank" className="font-medium text-[#534AB7] underline">
                      Privacy Policy
                    </Link>
                    .
                  </span>
                </label>

                {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep(2)}
                    className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">
                    Back
                  </button>
                  <button type="submit" disabled={loading || !acceptedTerms}
                    className="flex-1 px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50">
                    {loading ? "Creating account…" : "Create account"}
                  </button>
                </div>
              </div>
            )}
          </form>
        </div>

        <p className="text-center text-xs text-stone-500 mt-4">
          Already have an account?{" "}
          <Link href="/login" className="text-stone-900 font-medium hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
