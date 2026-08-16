"use client";

import { useEffect, useState } from "react";
import { signIn } from "next-auth/react";
import Link from "next/link";
import { User, Baby, Users, type LucideIcon } from "lucide-react";
import { TERMS_VERSION, PRIVACY_VERSION } from "@/legal/versions";
import { SIGNUP_INTENT_COPY } from "@/lib/signupIntent";
import { ageFromDOB, isMinorAge } from "@/lib/age";

type AccountType = "ADULT_ATHLETE" | "MINOR_ATHLETE" | "MINOR_SELF" | "PARENT";
type SignupDocument = {
  id: string;
  title: string;
  type: string;
  body: string | null;
  requiresGuardianSignature: boolean;
};

export default function MemberSignupPage() {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [clubSlug, setClubSlug] = useState("");
  // When arriving from a public membership link (/join/[slug]?m=…) the slug is
  // passed as ?club and the chosen plan as ?membership — remember the plan so we
  // can deep-link to it after the account is created.
  const [membershipId, setMembershipId] = useState("");
  // Attendance-QR intent (/c/[id] → ?checkin=<sessionId>): after the account
  // exists, finish the scan by checking them into that class.
  const [checkinId, setCheckinId] = useState("");
  // Generic deep-link continuation (e.g. /join/[slug]?goal=privates →
  // ?next=/member/privates). Same sanitization as /post-login: path-only,
  // /member-scoped, so this can never become an open redirect.
  const [nextPath, setNextPath] = useState("");
  // Club free-trial link (?trial=1): the server grants the club's trial
  // window on the created athlete profile (validated server-side).
  const [trialRequested, setTrialRequested] = useState(false);
  const [trialOffer, setTrialOffer] = useState<{ name: string; days: number } | null>(null);

  // Prefill from a kiosk QR (/c/[id] → ?club=slug&checkin=…), the club's
  // free-trial link (?trial=1), or a public registration link
  // (/join/[slug]?m=… → ?club=slug&membership=…).
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const c = sp.get("club");
    if (c) setClubSlug(c.toLowerCase());
    const m = sp.get("membership");
    if (m) setMembershipId(m);
    const k = sp.get("checkin");
    if (k) setCheckinId(k);
    const n = sp.get("next");
    if (n && n.startsWith("/member") && !n.startsWith("//") && !n.includes("://")) setNextPath(n);
    if (sp.get("trial") === "1") setTrialRequested(true);
  }, []);

  // Show what the trial link actually grants (name + days) once the club is known.
  useEffect(() => {
    if (!trialRequested || !clubSlug.trim()) return;
    const controller = new AbortController();
    fetch(`/api/member/signup?clubSlug=${encodeURIComponent(clubSlug.trim().toLowerCase())}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { freeTrial?: { name: string; days: number } | null } | null) => {
        setTrialOffer(d?.freeTrial ?? null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [trialRequested, clubSlug]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [accountType, setAccountType] = useState<AccountType>("ADULT_ATHLETE");
  const [dateOfBirth, setDateOfBirth] = useState("");

  // Child fields (MINOR_ATHLETE — the account holder is the GUARDIAN, these
  // describe the athlete they're signing up).
  const [childFirstName, setChildFirstName] = useState("");
  const [childLastName, setChildLastName] = useState("");
  const [guardianPhone, setGuardianPhone] = useState("");
  const [guardianRelationship, setGuardianRelationship] = useState("Parent");
  // MINOR_SELF — a junior or senior signing themselves up. They get their own
  // login; these name the parent who has to approve it.
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");

  // Parent fields
  const [childEmail, setChildEmail] = useState("");
  const [relationship, setRelationship] = useState("Parent");

  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [parentalConsent, setParentalConsent] = useState(false);
  const [consentSent, setConsentSent] = useState(false);
  const [signupDocs, setSignupDocs] = useState<SignupDocument[]>([]);
  const [signedDocIds, setSignedDocIds] = useState<string[]>([]);
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
    if (accountType === "PARENT" && childEmail && !parentalConsent) {
      setError("Please confirm your consent as the parent/guardian of this athlete.");
      return;
    }
    if (accountType === "MINOR_ATHLETE") {
      if (!childFirstName.trim()) {
        setError("Please enter your child's name.");
        return;
      }
      if (!parentalConsent) {
        setError("Please confirm you're the parent or legal guardian of this athlete.");
        return;
      }
    }
    if ((isSelfSignup || accountType === "MINOR_ATHLETE") && !dateOfBirth) {
      setError(
        isSelfSignup
          ? "Please enter your date of birth — it decides whether a parent has to approve the account."
          : "Please enter your child's date of birth.",
      );
      return;
    }
    if (needsGuardian && !guardianEmail.trim()) {
      setError("Please enter a parent or guardian's email — they'll need to approve the account.");
      return;
    }
    if (signupDocs.some((doc) => !signedDocIds.includes(doc.id))) {
      setError("Please review and acknowledge all required club documents.");
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
        // The DOB-derived intent, not the button they clicked.
        accountType: effectiveIntent,
        // On the guardian path this is the CHILD's date of birth — the account
        // holder is the guardian and we never ask for theirs. On the two
        // self-signup paths it is the athlete's own, and it is what decides
        // whether a guardian is required at all.
        dateOfBirth: dateOfBirth || undefined,
        childFirstName: accountType === "MINOR_ATHLETE" ? childFirstName.trim() : undefined,
        childLastName: accountType === "MINOR_ATHLETE" ? childLastName.trim() : undefined,
        // A self-signing minor names their parent here. Deliberately NOT sent
        // on the guardian path: the guardian IS the account holder, so the
        // server derives it from the signup email. Sending both on that path
        // is what created the self-guardian shape.
        guardianName: needsGuardian ? guardianName.trim() || undefined : undefined,
        guardianEmail: needsGuardian ? guardianEmail.trim() || undefined : undefined,
        guardianPhone:
          accountType === "MINOR_ATHLETE" || needsGuardian ? guardianPhone || undefined : undefined,
        guardianRelationship:
          accountType === "MINOR_ATHLETE" || needsGuardian ? guardianRelationship : undefined,
        childEmail: accountType === "PARENT" ? childEmail : undefined,
        relationship: accountType === "PARENT" ? relationship : undefined,
        parentalConsent:
          accountType === "PARENT" || accountType === "MINOR_ATHLETE" ? parentalConsent : undefined,
        acceptedTerms: true,
        termsVersion: TERMS_VERSION,
        privacyVersion: PRIVACY_VERSION,
        signedDocumentIds: signedDocIds,
        requestTrial: trialRequested,
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

    // A legacy minor signup (the athlete's own login) can't be used until a
    // guardian consents — show the "consent link sent" screen instead of
    // attempting a (blocked) auto-login.
    const okData = (await res.json().catch(() => ({}))) as {
      pendingGuardianConsent?: boolean;
      intent?: string;
      athlete?: { firstName: string } | null;
      sweptChildren?: number;
      trialGrantedTo?: string | null;
      trialNote?: string | null;
    };
    if (okData?.pendingGuardianConsent) {
      setLoading(false);
      setConsentSent(true);
      return;
    }
    // A guardian account lands on "add your athlete" with the sweep result,
    // never on an empty portal — that dead end is why parents emailed the club
    // asking how to add their kid.
    const guardianLanding =
      okData.intent === "GUARDIAN_ONLY" || okData.intent === "CHILD_BY_GUARDIAN"
        ? `/member?welcome=guardian&swept=${okData.sweptChildren ?? 0}` +
          (okData.athlete?.firstName ? `&athlete=${encodeURIComponent(okData.athlete.firstName)}` : "") +
          (okData.trialGrantedTo ? `&trial=${encodeURIComponent(okData.trialGrantedTo)}` : "") +
          (okData.trialNote ? `&trialnote=${encodeURIComponent(okData.trialNote)}` : "")
        : null;

    // Sign in after successful signup
    const loginRes = await signIn("credentials", {
      email,
      password,
      clubSlug: clubSlug.trim().toLowerCase(),
      redirect: false,
    });

    setLoading(false);
    if (loginRes?.ok) {
      // Preserve the original intent: an attendance-QR scan finishes at the
      // check-in page for the scanned class; a public membership link
      // deep-links to that plan; a generic next (e.g. book-a-private link)
      // lands there; otherwise the portal home.
      window.location.href = checkinId
        ? `/member/checkin/${encodeURIComponent(checkinId)}`
        : membershipId
          ? `/member/memberships?plan=${encodeURIComponent(membershipId)}`
          : nextPath || guardianLanding || "/member";
    } else {
      // Account exists now — send them to login rather than a dead end,
      // keeping the original intent through the sign-in hop.
      setError("Account created! Redirecting you to sign in…");
      const intent = checkinId ? `/member/checkin/${checkinId}` : nextPath;
      const next = intent ? `&next=${encodeURIComponent(intent)}` : "";
      setTimeout(() => {
        window.location.href = `/login?club=${encodeURIComponent(clubSlug.trim().toLowerCase())}&role=member${next}`;
      }, 1200);
    }
  }

  // Order puts the most common real case first. Copy comes from the shared
  // intent model so the wording the form promises and the rows the server
  // creates can't drift apart.
  const ACCOUNT_TYPES: { id: AccountType; Icon: LucideIcon }[] = [
    { id: "MINOR_ATHLETE", Icon: Baby },
    { id: "ADULT_ATHLETE", Icon: User },
    { id: "MINOR_SELF", Icon: Baby },
    { id: "PARENT", Icon: Users },
  ];
  const isChildPath = accountType === "MINOR_ATHLETE";
  const isGuardianAccount = accountType === "MINOR_ATHLETE" || accountType === "PARENT";
  // The two paths where the person filling this in IS the athlete.
  const isSelfSignup = accountType === "ADULT_ATHLETE" || accountType === "MINOR_SELF";

  // THE DOB BACKSTOP, client side. The server enforces the same rule — this
  // just means the person sees the right fields instead of a rejection. Which
  // option they clicked does not decide whether a guardian is required; their
  // date of birth does, exactly as `resolveIsMinor` decides it at the login
  // gate, in age brackets and in waivers.
  const dobAge = ageFromDOB(dateOfBirth || null);
  const effectiveIntent: AccountType = isSelfSignup && dobAge !== null
    ? (isMinorAge(dateOfBirth) ? "MINOR_SELF" : "ADULT_ATHLETE")
    : accountType;
  const needsGuardian = effectiveIntent === "MINOR_SELF";
  // They picked one thing and their birthday says the other. Say so plainly
  // rather than silently reclassifying them.
  const dobOverrodePick = isSelfSignup && dobAge !== null && effectiveIntent !== accountType;

  useEffect(() => {
    if (step !== 3 || !clubSlug.trim()) return;
    const controller = new AbortController();
    fetch(`/api/member/signup?clubSlug=${encodeURIComponent(clubSlug.trim().toLowerCase())}`, {
      signal: controller.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { documents?: SignupDocument[] } | null) => {
        const docs = d?.documents ?? [];
        setSignupDocs(docs);
        setSignedDocIds((ids) => ids.filter((id) => docs.some((doc) => doc.id === id)));
      })
      .catch(() => {});
    return () => controller.abort();
  }, [step, clubSlug]);

  function toggleSignedDoc(id: string) {
    setSignedDocIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  // Minor signup completed — the guardian must confirm consent before use.
  if (consentSent) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center px-4 py-12">
        <div className="w-full max-w-md bg-white rounded-2xl border border-stone-200 p-8 text-center">
          <h1 className="text-xl font-semibold text-stone-900">Almost there</h1>
          <p className="mt-3 text-stone-600 leading-relaxed">
            We&apos;ve created {firstName ? `${firstName}'s` : "the"} account and emailed a consent link to the
            parent or guardian. They must complete consent before the account can be used to sign in, book,
            or message.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-stone-50 flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Join your club</h1>
          <p className="text-sm text-stone-500">Create your member account</p>
          {trialRequested && trialOffer && (
            <p className="mt-2 inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-lime-accent/20 text-charcoal text-xs font-semibold">
              Includes {trialOffer.name} — {trialOffer.days} day{trialOffer.days === 1 ? "" : "s"} to try classes free
            </p>
          )}
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
                            {SIGNUP_INTENT_COPY[type.id].label}
                          </p>
                          <p className="text-xs text-stone-500">{SIGNUP_INTENT_COPY[type.id].description}</p>
                        </div>
                      </label>
                    ))}
                  </div>
                  {/* Say whose login is about to exist, before a single name is
                      typed. The AJ Dorn account happened because this sentence
                      was missing and a dad's login ended up named after his son. */}
                  <p className="mt-2 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-600">
                    {SIGNUP_INTENT_COPY[accountType].accountLine}
                  </p>
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
                {isGuardianAccount && (
                  <p className="rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-600">
                    These are <strong>your</strong> details — the parent or guardian.
                    {isChildPath ? " We'll ask for your child's on the next step." : ""}
                  </p>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">
                      {isGuardianAccount ? "Your first name" : "First name"}
                    </label>
                    <input type="text" value={firstName} onChange={(e) => setFirstName(e.target.value)} required
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">
                      {isGuardianAccount ? "Your last name" : "Last name"}
                    </label>
                    <input type="text" value={lastName} onChange={(e) => setLastName(e.target.value)} required
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-stone-700 mb-1">
                    {isGuardianAccount ? "Your email — you'll manage this account" : "Email address"}
                  </label>
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

                {/* REQUIRED on both self-signup paths, and it is what actually
                    decides the outcome — not the option above. On the guardian
                    path the DOB that matters is the athlete's, so it is asked
                    for next to their name where it can't be mistaken for the
                    parent's. */}
                {isSelfSignup && (
                  <div>
                    <label className="block text-sm font-medium text-stone-700 mb-1">Your date of birth</label>
                    <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} required
                      className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                    {dobOverrodePick && needsGuardian && (
                      <p className="mt-1.5 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-600">
                        That makes you {dobAge}. You&apos;ll still get your own login — we just need a parent or
                        guardian to approve it first. We&apos;ll ask for their email on the next step.
                      </p>
                    )}
                    {dobOverrodePick && !needsGuardian && (
                      <p className="mt-1.5 rounded-lg bg-stone-50 border border-stone-200 px-3 py-2 text-xs text-stone-600">
                        That makes you {dobAge}, so you don&apos;t need a parent to approve anything — we&apos;ll
                        set you up as an adult athlete.
                      </p>
                    )}
                    <p className="mt-1 text-xs text-stone-400">
                      We use this for age brackets, waivers, and whether a parent needs to approve the account.
                    </p>
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
                    <div className="p-3 bg-stone-50 border border-stone-200 rounded-lg text-xs text-stone-600">
                      Now your athlete. They&apos;ll appear under your account — <strong>{firstName || "you"}</strong>{" "}
                      ({email || "your email"}) — so their schedule, documents and billing all stay with you.
                      They don&apos;t need their own login or email address.
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">Your child&apos;s first name</label>
                        <input type="text" value={childFirstName} onChange={(e) => setChildFirstName(e.target.value)} required
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">
                          Your child&apos;s last name
                        </label>
                        <input type="text" value={childLastName} onChange={(e) => setChildLastName(e.target.value)}
                          placeholder={lastName || ""}
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">Their date of birth</label>
                        <input type="date" value={dateOfBirth} onChange={(e) => setDateOfBirth(e.target.value)} required
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">You are their…</label>
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
                      <label className="block text-sm font-medium text-stone-700 mb-1">Your phone (optional)</label>
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

                {/* A self-signing minor: their own login, their own email, and
                    a SEPARATE parent who has to approve it. This is the path
                    juniors and seniors actually use. */}
                {needsGuardian && (
                  <>
                    <div className="p-3 bg-stone-50 border border-stone-200 rounded-lg text-xs text-stone-600">
                      You&apos;re under 18, so a parent or guardian has to approve your account before you can sign
                      in. The account stays <strong>yours</strong> — your own login at{" "}
                      <strong>{email || "your email"}</strong>. We&apos;ll email them a link to approve it, and
                      they&apos;ll get their own account to manage things with you.
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-stone-700 mb-1">
                        Parent or guardian&apos;s full name
                      </label>
                      <input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)}
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">
                          Their email
                        </label>
                        <input type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} required
                          className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                        {/* The AJ Dorn rule, said before they can trip it. */}
                        <p className="mt-1 text-xs text-stone-400">
                          Must be different from your own email above.
                        </p>
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-stone-700 mb-1">They are your…</label>
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
                      <label className="block text-sm font-medium text-stone-700 mb-1">Their phone (optional)</label>
                      <input type="tel" value={guardianPhone} onChange={(e) => setGuardianPhone(e.target.value)}
                        className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900" />
                    </div>
                  </>
                )}

                {isSelfSignup && !needsGuardian && (
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

                {signupDocs.length > 0 && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium text-stone-900">Required club documents</p>
                    {signupDocs.map((doc) => (
                      <div key={doc.id} className="rounded-lg border border-stone-200 bg-stone-50 p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-stone-900">{doc.title}</p>
                          <span className="text-[10px] uppercase tracking-wide text-stone-500">{doc.type}</span>
                        </div>
                        {doc.body ? (
                          <div
                            className="doc-prose max-h-44 overflow-y-auto rounded-md border border-stone-200 bg-white p-3 text-sm"
                            dangerouslySetInnerHTML={{ __html: doc.body }}
                          />
                        ) : (
                          <p className="rounded-md border border-stone-200 bg-white p-3 text-sm text-stone-500">
                            No document content added.
                          </p>
                        )}
                        <label className="mt-3 flex items-start gap-2 text-sm text-stone-700">
                          <input
                            type="checkbox"
                            checked={signedDocIds.includes(doc.id)}
                            onChange={() => toggleSignedDoc(doc.id)}
                            required
                            className="mt-1 h-4 w-4 rounded border-stone-300 text-[#534AB7] focus:ring-[#534AB7]"
                          />
                          <span>
                            {accountType === "MINOR_ATHLETE" && doc.requiresGuardianSignature
                              ? "My parent or guardian has read and agrees to this document."
                              : "I have read and agree to this document."}
                          </span>
                        </label>
                      </div>
                    ))}
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

                {((accountType === "PARENT" && childEmail) || accountType === "MINOR_ATHLETE") && (
                  <label className="flex items-start gap-2 text-sm text-stone-700">
                    <input
                      type="checkbox"
                      checked={parentalConsent}
                      onChange={(e) => setParentalConsent(e.target.checked)}
                      className="mt-1 h-4 w-4 rounded border-stone-300 text-[#534AB7] focus:ring-[#534AB7]"
                    />
                    <span>
                      I am the parent or legal guardian of{" "}
                      {isChildPath && childFirstName.trim() ? childFirstName.trim() : "this athlete"} and I consent to
                      the collection and use of their information as described above.
                    </span>
                  </label>
                )}

                {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

                <div className="flex gap-2">
                  <button type="button" onClick={() => setStep(2)}
                    className="flex-1 px-4 py-2 border border-stone-300 text-stone-700 rounded-lg text-sm hover:bg-stone-50">
                    Back
                  </button>
                  <button type="submit" disabled={loading || !acceptedTerms || (isChildPath && (!childFirstName.trim() || !parentalConsent)) || (isSelfSignup && !dateOfBirth) || (needsGuardian && !guardianEmail.trim()) || signupDocs.some((doc) => !signedDocIds.includes(doc.id))}
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
