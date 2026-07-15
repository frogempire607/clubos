"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeft, Check, ChevronLeft, ChevronRight } from "lucide-react";
import ExportMenu from "@/components/ExportMenu";
import PageHeader from "@/components/PageHeader";
import { SkeletonList } from "@/components/LoadingSkeleton";
import { todayLocalISO } from "@/lib/datetime";

// ─── Types ────────────────────────────────────────────────────────────────────

type ClassSession = {
  id: string;
  date: string;
  startsAt: string;
  endsAt: string;
  canceled: boolean;
  recurringClass: { name: string; capacity: number | null };
  _count: { attendance: number };
};

type Event = {
  id: string;
  name: string;
  type: string;
  startsAt: string;
  endsAt: string;
  capacity: number | null;
  location: { name: string } | null;
  _count: { bookings: number };
};

type AttendanceRecord = {
  id: string;
  memberId: string;
  status: string;
  checkedInAt: string | null;
  notes: string | null;
  member: {
    id: string;
    firstName: string;
    lastName: string;
    email: string | null;
    phone: string | null;
    isMinor: boolean;
    guardianName: string | null;
    status: string;
  };
};

type Member = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  isMinor: boolean;
  guardianName: string | null;
  status: string;
};

const STATUS_CONFIG: Record<string, { label: string; bg: string; fg: string }> = {
  PRESENT: { label: "Present", bg: "var(--color-success)", fg: "#1F1F23" },
  ABSENT: { label: "Absent", fg: "var(--color-muted)", bg: "var(--color-bg)" },
  LATE: { label: "Late", bg: "var(--color-warning)", fg: "#fff" },
  TRIAL: { label: "Trial", bg: "var(--color-primary)", fg: "#fff" },
  DROP_IN: { label: "Drop-In", bg: "var(--color-primary)", fg: "#fff" },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Class sessions store the owner's wall-clock as that clock time in UTC
// (see lib/classSessions.ts / lib/datetime.ts) — render with UTC.
function fmtTime(iso: string) {
  const date = new Date(iso);
  const h = date.getUTCHours();
  const m = date.getUTCMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 || 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// Events are true instants (datetime-local round-tripped through ISO) —
// render in the viewer's local timezone, NOT UTC.
function fmtTimeLocal(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function todayStr() {
  // Local calendar day — NOT UTC. toISOString() rolls to tomorrow after ~8pm
  // US-Eastern, which made the dashboard show the wrong day.
  return todayLocalISO();
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split("T")[0];
}

function fmtDateHeader(dateStr: string) {
  const d = new Date(dateStr + "T00:00:00Z");
  return d.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

// ─── Pricing types ────────────────────────────────────────────────────────────

type PricingOption =
  | { type: "member" | "nonmember" | "dropin"; price: number }
  | { type: "membership"; membershipId: string };

type AcceptedMembership = { id: string; name: string };
type FreeTrialSummary = { active: boolean; name: string; days: number; renewable: boolean };

// ─── Payment methods (shared by both charge panels) ──────────────────────────

// CARD_ON_FILE is client-side only — it drives the ChargeSavedCardPanel flow
// against /api/attendance/charge-card and is NEVER sent to /api/attendance/charge.
const PAY_METHODS = ["CASH", "CHECK", "CARD_ON_FILE", "CREDIT", "COMP", "INVOICE"] as const;
type PayMethod = (typeof PAY_METHODS)[number];

const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  CASH: "Cash",
  CHECK: "Check",
  CARD_ON_FILE: "Charge saved card",
  CREDIT: "External reader — record only",
  COMP: "Comp / Free",
  INVOICE: "Invoice",
};

function PayMethodChips({ value, onChange }: { value: PayMethod; onChange: (m: PayMethod) => void }) {
  return (
    <div className="grid grid-cols-2 gap-1.5">
      {PAY_METHODS.map((pm) => (
        <button
          key={pm}
          type="button"
          onClick={() => onChange(pm)}
          className={`px-2 py-1 text-[11px] rounded border ${
            value === pm ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted"
          }`}
        >
          {PAY_METHOD_LABELS[pm]}
        </button>
      ))}
    </div>
  );
}

// ─── Charge saved card (card-on-file) panel ───────────────────────────────────

type ChargeCardPreview = {
  member: { id: string; name: string; isMinor: boolean };
  hasSavedCard: boolean;
  card: { brand: string; last4: string; cardholder: string } | null;
  guardians: { name: string; email: string; relationship: string }[];
  payerManagesOthers: string[];
  allowedPrices: { label: string; price: number }[];
  passProcessingFees: boolean;
};

type ChargeResult =
  | { kind: "success"; total: number }
  | { kind: "processing" }
  | { kind: "declined"; message: string }
  | { kind: "requires_action"; message: string }
  | { kind: "no_card" }
  | { kind: "error"; message: string };

function titleCaseBrand(brand: string) {
  return brand ? brand.charAt(0).toUpperCase() + brand.slice(1).toLowerCase() : "Card";
}

// Display-only estimate; the server computes the real fee/total.
function processingFeeFor(base: number) {
  return Math.round(base * 100 * 0.029) / 100;
}

function newClientKey(): string {
  const c = typeof crypto !== "undefined" ? (crypto as Crypto & { randomUUID?: () => string }) : undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `ck-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function ChargeSavedCardPanel({
  memberId,
  classSessionId,
  classId,
  status,
  notes,
  contextLabel,
  pricingOptions,
  onCharged,
}: {
  memberId: string;
  classSessionId: string;
  classId: string | null;
  status: string;
  notes: string | null;
  contextLabel: string;
  pricingOptions: PricingOption[];
  onCharged: () => void;
}) {
  const [preview, setPreview] = useState<ChargeCardPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [loadingPreview, setLoadingPreview] = useState(true);
  const [selectedPrice, setSelectedPrice] = useState<number | null>(null);
  const [emailReceipt, setEmailReceipt] = useState(true);
  // ONE idempotency key per open confirm box — a double-click reuses it.
  const [clientKey] = useState(newClientKey);
  const [charging, setCharging] = useState(false);
  const [result, setResult] = useState<ChargeResult | null>(null);
  const [linkState, setLinkState] = useState<{ state: "idle" | "sending" | "sent" | "error"; detail?: string }>({
    state: "idle",
  });

  useEffect(() => {
    let cancelled = false;
    fetch(
      `/api/attendance/charge-card?memberId=${encodeURIComponent(memberId)}&classSessionId=${encodeURIComponent(classSessionId)}`
    )
      .then(async (res) => {
        const d = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          setPreviewError(typeof d.error === "string" ? d.error : "Could not load the saved card.");
        } else {
          setPreview(d);
          if (Array.isArray(d.allowedPrices) && d.allowedPrices.length > 0) {
            setSelectedPrice(d.allowedPrices[0].price);
          }
        }
        setLoadingPreview(false);
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewError("Could not load the saved card.");
          setLoadingPreview(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [memberId, classSessionId]);

  async function charge() {
    if (charging || selectedPrice == null) return;
    setCharging(true);
    setResult(null);
    let res: Response;
    try {
      res = await fetch("/api/attendance/charge-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          memberId,
          classSessionId,
          amount: selectedPrice,
          status,
          notes: notes || null,
          emailReceipt,
          clientKey,
        }),
      });
    } catch {
      setCharging(false);
      setResult({ kind: "error", message: "Network error — check Financials before retrying." });
      return;
    }
    const d = await res.json().catch(() => ({}));
    setCharging(false);
    if (res.status === 202 || d.outcome === "processing") {
      setResult({ kind: "processing" });
      return;
    }
    if (res.ok && d.outcome === "succeeded") {
      setResult({ kind: "success", total: typeof d.total === "number" ? d.total : selectedPrice });
      onCharged();
      return;
    }
    if (res.status === 402) {
      const message = typeof d.message === "string" ? d.message : "The card was declined.";
      setResult({ kind: d.outcome === "requires_action" ? "requires_action" : "declined", message });
      return;
    }
    if (res.status === 409 && d.error === "NO_SAVED_CARD") {
      setResult({ kind: "no_card" });
      return;
    }
    setResult({
      kind: "error",
      message:
        typeof d.error === "string" ? d.error : typeof d.message === "string" ? d.message : "The charge failed.",
    });
  }

  // Fallback: email a Stripe Checkout link to the payer via the existing
  // drop-in checkout creator. DROP_IN → NON_MEMBER → MEMBER pricing fallback.
  async function sendPaymentLink() {
    if (!classId) {
      setLinkState({ state: "error", detail: "This session has no linked class to price from." });
      return;
    }
    setLinkState({ state: "sending" });
    const dropin = pricingOptions.find((o) => o.type === "dropin") as { price: number } | undefined;
    const nonmember = pricingOptions.find((o) => o.type === "nonmember") as { price: number } | undefined;
    const memberOpt = pricingOptions.find((o) => o.type === "member") as { price: number } | undefined;
    const candidates: { type: "DROP_IN" | "NON_MEMBER" | "MEMBER"; price?: number }[] = [
      { type: "DROP_IN", price: dropin?.price },
      { type: "NON_MEMBER", price: nonmember?.price },
      { type: "MEMBER", price: memberOpt?.price },
    ];
    let url: string | null = null;
    let usedPrice: number | undefined;
    let lastErr = "Could not create a payment link.";
    for (const c of candidates) {
      let res: Response;
      try {
        res = await fetch(`/api/classes/${classId}/charge`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memberId, classSessionId, pricingType: c.type }),
        });
      } catch {
        setLinkState({ state: "error", detail: "Network error — the link was not sent." });
        return;
      }
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.coveredByMembership) {
        setLinkState({ state: "sent", detail: "Covered by an active membership — no payment needed." });
        onCharged();
        return;
      }
      if (res.ok && typeof d.url === "string") {
        url = d.url;
        usedPrice = c.price;
        break;
      }
      if (typeof d.error === "string") lastErr = d.error;
    }
    if (!url) {
      setLinkState({ state: "error", detail: lastErr });
      return;
    }
    const res2 = await fetch("/api/attendance/send-payment-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        memberId,
        url,
        amountLabel: usedPrice != null ? `$${usedPrice.toFixed(2)}` : "",
        contextLabel,
      }),
    });
    const d2 = await res2.json().catch(() => ({}));
    if (!res2.ok) {
      setLinkState({
        state: "error",
        detail: typeof d2.error === "string" ? d2.error : "The link was created but could not be emailed.",
      });
      return;
    }
    setLinkState({
      state: "sent",
      detail: `Link emailed to ${typeof d2.sentTo === "string" ? d2.sentTo : "the payer"}`,
    });
  }

  const paymentLinkBlock = (
    <div className="space-y-1">
      <button
        type="button"
        disabled={linkState.state === "sending" || !classId}
        onClick={sendPaymentLink}
        className="w-full px-2 py-1.5 text-xs rounded border border-brand/40 bg-brand/5 text-brand hover:bg-brand/10 disabled:opacity-50"
      >
        {linkState.state === "sending" ? "Sending payment link…" : "Email payment link to payer"}
      </button>
      {linkState.state === "sent" && <p className="text-[11px] text-text-primary">{linkState.detail}</p>}
      {linkState.state === "error" && <p className="text-[11px] text-red-600">{linkState.detail}</p>}
    </div>
  );

  if (loadingPreview) return <p className="text-xs text-text-muted">Checking for a saved card…</p>;
  if (previewError) return <p className="text-xs text-red-600">{previewError}</p>;
  if (!preview) return null;

  const card = preview.card;

  if (!preview.hasSavedCard || !card || result?.kind === "no_card") {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-app-border bg-app-bg px-2 py-1.5 text-[11px] text-text-muted">
          No saved card on file for {preview.member.name}.
        </div>
        {paymentLinkBlock}
      </div>
    );
  }

  if (result?.kind === "success") {
    return (
      <div
        className="rounded-lg px-2 py-1.5 text-xs font-medium flex items-center gap-1.5"
        style={{ background: "var(--color-success)", color: "#1F1F23" }}
      >
        <Check className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2.5} />
        Charged ${result.total.toFixed(2)}
        {emailReceipt ? " — receipt sent" : ""}
      </div>
    );
  }

  const base = selectedPrice;
  const fee = preview.passProcessingFees && base != null ? processingFeeFor(base) : 0;
  const total = base != null ? base + fee : null;

  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-app-border bg-app-bg px-2 py-2 space-y-1">
        <p className="text-xs font-medium text-text-primary">{preview.member.name}</p>
        <p className="text-[11px] text-text-muted">
          {titleCaseBrand(card.brand)} •••• {card.last4} — cardholder {card.cardholder}
        </p>
        {preview.guardians.length > 0 && (
          <p className="text-[11px] text-text-muted">
            Guardians:{" "}
            {preview.guardians
              .map((g) => `${g.name}${g.relationship ? ` (${g.relationship})` : ""}`)
              .join(", ")}
          </p>
        )}
        {preview.payerManagesOthers.length > 0 && (
          <p className="text-[11px] text-orange-accent">
            This card&apos;s payer also manages: {preview.payerManagesOthers.join(", ")}
          </p>
        )}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        {preview.allowedPrices.map((p) => (
          <button
            key={`${p.label}-${p.price}`}
            type="button"
            onClick={() => setSelectedPrice(p.price)}
            className={`px-2 py-1 text-[11px] rounded border ${
              selectedPrice === p.price ? "border-brand bg-brand/10 text-brand" : "border-app-border text-text-muted"
            }`}
          >
            {p.label} · ${p.price.toFixed(2)}
          </button>
        ))}
        {preview.allowedPrices.length === 0 && (
          <p className="text-[11px] text-text-muted">No chargeable prices are configured for this class.</p>
        )}
      </div>

      {base != null && preview.passProcessingFees && (
        <div className="text-[11px] text-text-muted space-y-0.5">
          <div className="flex justify-between">
            <span>Base price</span>
            <span>${base.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span>Processing fee</span>
            <span>${fee.toFixed(2)}</span>
          </div>
          <div className="flex justify-between font-medium text-text-primary">
            <span>Total charged</span>
            <span>${(total as number).toFixed(2)}</span>
          </div>
        </div>
      )}

      <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
        <input
          type="checkbox"
          checked={emailReceipt}
          onChange={(e) => setEmailReceipt(e.target.checked)}
          className="w-3.5 h-3.5 accent-brand"
        />
        Email receipt
      </label>

      {result?.kind === "processing" ? (
        <p className="text-[11px] text-orange-accent">
          Payment is processing — do not retry; it will appear in Financials when it settles.
        </p>
      ) : (
        <button
          type="button"
          disabled={charging || total == null}
          onClick={charge}
          className="w-full px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
        >
          {charging
            ? "Charging…"
            : total != null
              ? `Charge $${total.toFixed(2)} to ${titleCaseBrand(card.brand)} •••• ${card.last4}`
              : "Pick a price to charge"}
        </button>
      )}

      {(result?.kind === "declined" || result?.kind === "requires_action" || result?.kind === "error") && (
        <p className="text-xs text-red-600">{result.message}</p>
      )}
      {result?.kind === "requires_action" && paymentLinkBlock}
    </div>
  );
}

// ─── Quick Add Member Form ────────────────────────────────────────────────────

function QuickAddForm({
  sessionId,
  sessionName,
  classId,
  pricingOptions,
  acceptedMemberships,
  freeTrial,
  onAdded,
}: {
  sessionId: string;
  sessionName: string;
  classId: string | null;
  pricingOptions: PricingOption[];
  acceptedMemberships: AcceptedMembership[];
  freeTrial: FreeTrialSummary | null;
  onAdded: () => void;
}) {
  const [step, setStep] = useState<"search" | "add-new">("search");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [allMembers, setAllMembers] = useState<Member[]>([]);
  const [saving, setSaving] = useState(false);
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [isMinor, setIsMinor] = useState(false);
  const [guardianName, setGuardianName] = useState("");
  const [guardianEmail, setGuardianEmail] = useState("");
  const [error, setError] = useState("");
  const [registeringId, setRegisteringId] = useState<string | null>(null);
  const [payingId, setPayingId] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState<PayMethod>("CASH");
  const [payStatus, setPayStatus] = useState<"DROP_IN" | "TRIAL" | "PRESENT">("DROP_IN");
  const [payNotes, setPayNotes] = useState("");
  const [payEmailReceipt, setPayEmailReceipt] = useState(false);

  const memberPrice    = pricingOptions.find((o) => o.type === "member")    as { type: "member"; price: number } | undefined;
  const nonMemberPrice = pricingOptions.find((o) => o.type === "nonmember") as { type: "nonmember"; price: number } | undefined;
  const dropInPrice    = pricingOptions.find((o) => o.type === "dropin")    as { type: "dropin"; price: number } | undefined;
  const acceptsMembership = acceptedMemberships.length > 0;
  const hasAnyPricing = !!(memberPrice || nonMemberPrice || dropInPrice || acceptsMembership);

  async function register(memberId: string, pricingType: "MEMBER" | "NON_MEMBER" | "DROP_IN" | "MEMBERSHIP") {
    if (!classId) return;
    setSaving(true);
    setError("");
    const res = await fetch(`/api/classes/${classId}/charge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memberId, classSessionId: sessionId, pricingType }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(data.error?.toString?.() || "Failed to register member");
      return;
    }
    if (data.coveredByMembership) {
      setRegisteringId(null);
      setQuery("");
      setResults([]);
      onAdded();
      return;
    }
    if (data.url) {
      window.open(data.url, "_blank");
      setRegisteringId(null);
      return;
    }
    setError("Unexpected response");
  }

  function openPay(memberId: string) {
    if (payingId === memberId) { setPayingId(null); return; }
    // Default matches the panel's default status (Drop-in).
    const def = dropInPrice?.price ?? nonMemberPrice?.price ?? memberPrice?.price ?? 0;
    setPayAmount(def ? String(def) : "");
    setPayMethod("CASH");
    setPayStatus("DROP_IN");
    setPayNotes("");
    setPayEmailReceipt(false);
    setError("");
    setRegisteringId(null);
    setTrialingId(null);
    setPayingId(memberId);
  }

  // Cash / comp / invoice — no Stripe. Records attendance + an internal
  // transaction so it shows in reports under the right channel.
  // CARD_ON_FILE never goes through here — it charges via ChargeSavedCardPanel.
  async function recordPay(memberId: string) {
    if (!sessionId || payMethod === "CARD_ON_FILE") return;
    setSaving(true);
    setError("");
    const res = await fetch("/api/attendance/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classSessionId: sessionId,
        memberId,
        status: payStatus,
        paymentMethod: payMethod,
        amount: Number(payAmount || 0),
        notes: payNotes || null,
        emailReceipt: payEmailReceipt,
      }),
    });
    const data = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) { setError(typeof data.error === "string" ? data.error : "Could not record payment"); return; }
    setPayingId(null);
    setQuery("");
    setResults([]);
    onAdded();
  }

  useEffect(() => {
    fetch("/api/members")
      .then((r) => r.json())
      .then((d) => setAllMembers(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!query.trim()) { setResults([]); return; }
    const q = query.toLowerCase();
    setResults(
      allMembers
        .filter(
          (m) =>
            `${m.firstName} ${m.lastName}`.toLowerCase().includes(q) ||
            (m.email ?? "").toLowerCase().includes(q)
        )
        .slice(0, 8)
    );
  }, [query, allMembers]);

  async function checkIn(memberId: string, status = "PRESENT", emailReceipt = false): Promise<string | null> {
    setSaving(true);
    const res = await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status, emailReceipt }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      const msg = typeof d.error === "string" ? d.error : "Could not check them in.";
      setError(msg);
      return msg;
    }
    setError("");
    setQuery("");
    setResults([]);
    setTrialingId(null);
    onAdded();
    return null;
  }

  // Trial needs an explicit confirmation (it starts the club's free-trial
  // membership window) — small inline panel per search row.
  const [trialingId, setTrialingId] = useState<string | null>(null);
  const [trialEmailReceipt, setTrialEmailReceipt] = useState(false);

  async function createAndCheckIn(e: React.FormEvent) {
    e.preventDefault();
    if (!newFirst || !newLast) { setError("Name is required."); return; }
    if (isMinor && (!guardianName.trim() || !guardianEmail.trim())) {
      setError("Guardian name and email are required for athletes under 18.");
      return;
    }
    if (!isMinor && !newEmail.trim()) {
      setError("Email is required.");
      return;
    }
    setSaving(true);
    setError("");

    const res = await fetch("/api/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: newFirst,
        lastName: newLast,
        email: !isMinor && newEmail ? newEmail.trim() : null,
        isMinor,
        guardianName: isMinor ? guardianName : null,
        guardianEmail: isMinor ? guardianEmail.trim() : null,
        status: "PROSPECT",
      }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(typeof d.error === "string" ? d.error : "Failed to create member.");
      setSaving(false);
      return;
    }
    const member = await res.json();
    const trialError = await checkIn(member.id, "TRIAL", trialEmailReceipt);
    if (trialError) {
      // Member exists now — surface why the trial part failed instead of
      // silently dropping them from the roster.
      setError(`${newFirst} was added, but the trial couldn't start: ${trialError}`);
      return;
    }
    setStep("search");
    setNewFirst(""); setNewLast(""); setNewEmail(""); setIsMinor(false); setGuardianName(""); setGuardianEmail("");
    setTrialEmailReceipt(false);
  }

  if (step === "add-new") {
    return (
      <form onSubmit={createAndCheckIn} className="space-y-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-text-primary">New Member (Quick Add)</span>
          <button type="button" onClick={() => setStep("search")} className="inline-flex items-center gap-1 text-xs text-text-muted hover:text-text-muted">
            <ArrowLeft className="h-3 w-3" strokeWidth={2} /> Back
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <input
            required
            placeholder="First name"
            value={newFirst}
            onChange={(e) => setNewFirst(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
          <input
            required
            placeholder="Last name"
            value={newLast}
            onChange={(e) => setNewLast(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        {!isMinor && (
          <input
            type="email"
            required
            placeholder="Email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
          />
        )}
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isMinor} onChange={(e) => setIsMinor(e.target.checked)} className="rounded" />
          <span className="text-sm text-text-primary">Minor / under 18</span>
        </label>
        {isMinor && (
          <>
            <input
              required
              placeholder="Guardian name"
              value={guardianName}
              onChange={(e) => setGuardianName(e.target.value)}
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
            <input
              type="email"
              required
              placeholder="Guardian email"
              value={guardianEmail}
              onChange={(e) => setGuardianEmail(e.target.value)}
              className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
            />
          </>
        )}
        <label className="flex items-center gap-2 cursor-pointer text-xs text-text-muted">
          <input
            type="checkbox"
            checked={trialEmailReceipt}
            onChange={(e) => setTrialEmailReceipt(e.target.checked)}
            className="w-3.5 h-3.5 accent-brand"
          />
          Email a trial receipt {isMinor ? "to the guardian" : "to the member"}
        </label>
        {error && <p className="text-red-600 text-xs">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full px-4 py-2 bg-brand text-white text-sm rounded-lg hover:bg-brand-hover disabled:opacity-50"
        >
          {saving
            ? "Adding…"
            : freeTrial
              ? `Add & start ${freeTrial.name} (${freeTrial.days} day${freeTrial.days === 1 ? "" : "s"})`
              : "Add as Trial & Check In"}
        </button>
      </form>
    );
  }

  return (
    <div>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search members to add…"
        className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand mb-2"
      />
      {results.length > 0 && (
        <div className="space-y-1 mb-2">
          {results.map((m) => (
            <div
              key={m.id}
              className="px-3 py-2 rounded-lg hover:bg-app-bg border border-app-border"
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    {m.firstName} {m.lastName}
                    {m.isMinor && <span className="ml-1.5 text-xs text-brand">(minor)</span>}
                  </div>
                  {m.isMinor && m.guardianName && (
                    <div className="text-xs text-text-muted">Guardian: {m.guardianName}</div>
                  )}
                </div>
                <div className="flex gap-1.5 flex-wrap justify-end">
                  <button
                    disabled={saving}
                    onClick={() => checkIn(m.id, "PRESENT")}
                    className="px-2 py-1 text-xs rounded bg-lime-accent text-text-primary hover:bg-lime-accent"
                  >
                    Present
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => {
                      setTrialingId(trialingId === m.id ? null : m.id);
                      setTrialEmailReceipt(false);
                      setError("");
                      setRegisteringId(null);
                      setPayingId(null);
                    }}
                    className="px-2 py-1 text-xs rounded bg-brand/10 text-brand hover:bg-brand"
                  >
                    {trialingId === m.id ? "Cancel" : "Trial"}
                  </button>
                  {hasAnyPricing && classId && (
                    <button
                      disabled={saving}
                      onClick={() => { setRegisteringId(registeringId === m.id ? null : m.id); setTrialingId(null); }}
                      className="px-2 py-1 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      {registeringId === m.id ? "Cancel" : "Register (card)"}
                    </button>
                  )}
                  {classId && (
                    <button
                      disabled={saving}
                      onClick={() => openPay(m.id)}
                      className="px-2 py-1 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      {payingId === m.id ? "Cancel" : "Cash / Comp"}
                    </button>
                  )}
                </div>
              </div>
              {trialingId === m.id && (
                <div className="mt-2 pt-2 border-t border-app-border space-y-2">
                  <p className="text-sm font-medium text-text-primary">Start free trial for this client?</p>
                  <p className="text-xs text-text-muted">
                    {freeTrial
                      ? `${m.firstName} gets “${freeTrial.name}” — ${freeTrial.days} day${freeTrial.days === 1 ? "" : "s"} free, active like a membership, then it ends automatically.${freeTrial.renewable ? "" : " One per client — it can't be renewed later."}`
                      : `${m.firstName} gets the club's free trial and can book like a member until it ends.`}
                  </p>
                  <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={trialEmailReceipt}
                      onChange={(e) => setTrialEmailReceipt(e.target.checked)}
                      className="w-3.5 h-3.5 accent-brand"
                    />
                    Email a trial receipt
                  </label>
                  <button
                    disabled={saving}
                    onClick={() => checkIn(m.id, "TRIAL", trialEmailReceipt)}
                    className="w-full px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                  >
                    {saving ? "Starting…" : "Start free trial & check in"}
                  </button>
                  {error && <p className="text-red-600 text-xs">{error}</p>}
                </div>
              )}
              {registeringId === m.id && hasAnyPricing && classId && (
                <div className="mt-2 pt-2 border-t border-app-border space-y-1.5">
                  {acceptsMembership && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "MEMBERSHIP")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-brand/40 bg-brand/5 text-text-primary hover:bg-brand/10"
                    >
                      <span className="font-medium">Use accepted membership</span>
                      <span className="block text-[10px] text-text-muted">
                        Free if active on: {acceptedMemberships.map((a) => a.name).join(", ")}
                      </span>
                    </button>
                  )}
                  {memberPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "MEMBER")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Member · ${memberPrice.price.toFixed(2)}
                    </button>
                  )}
                  {nonMemberPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "NON_MEMBER")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Non-member · ${nonMemberPrice.price.toFixed(2)}
                    </button>
                  )}
                  {dropInPrice && (
                    <button
                      disabled={saving}
                      onClick={() => register(m.id, "DROP_IN")}
                      className="w-full text-left px-2 py-1.5 text-xs rounded border border-app-border text-text-primary hover:bg-app-bg"
                    >
                      Drop-in · ${dropInPrice.price.toFixed(2)}
                    </button>
                  )}
                  {error && <p className="text-red-600 text-xs">{error}</p>}
                </div>
              )}
              {payingId === m.id && classId && (
                <div className="mt-2 pt-2 border-t border-app-border space-y-2">
                  <PayMethodChips value={payMethod} onChange={setPayMethod} />
                  <div className="grid grid-cols-2 gap-1.5">
                    {payMethod !== "CARD_ON_FILE" && (
                      <input
                        type="number" min="0" step="0.01"
                        value={payAmount}
                        onChange={(e) => setPayAmount(e.target.value)}
                        placeholder={payMethod === "COMP" ? "Value (optional)" : "Amount"}
                        className="border border-app-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
                      />
                    )}
                    <select
                      value={payStatus}
                      onChange={(e) => setPayStatus(e.target.value as "DROP_IN" | "TRIAL" | "PRESENT")}
                      className={`border border-app-border rounded-lg px-2 py-1.5 text-xs bg-white ${
                        payMethod === "CARD_ON_FILE" ? "col-span-2" : ""
                      }`}
                    >
                      <option value="DROP_IN">Drop-in</option>
                      <option value="TRIAL">Trial</option>
                      <option value="PRESENT">Present</option>
                    </select>
                  </div>
                  <input
                    value={payNotes}
                    onChange={(e) => setPayNotes(e.target.value)}
                    placeholder="Notes (optional)"
                    className="w-full border border-app-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
                  />
                  {payMethod === "CREDIT" && (
                    <p className="text-[11px] text-orange-accent">
                      AthletixOS does NOT charge the card — record only, collected on your external card reader.
                    </p>
                  )}
                  {payMethod === "CARD_ON_FILE" ? (
                    <ChargeSavedCardPanel
                      memberId={m.id}
                      classSessionId={sessionId}
                      classId={classId}
                      status={payStatus}
                      notes={payNotes}
                      contextLabel={sessionName}
                      pricingOptions={pricingOptions}
                      onCharged={onAdded}
                    />
                  ) : (
                    <>
                      <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                        <input
                          type="checkbox"
                          checked={payEmailReceipt}
                          onChange={(e) => setPayEmailReceipt(e.target.checked)}
                          className="w-3.5 h-3.5 accent-brand"
                        />
                        Email a receipt to the member
                      </label>
                      <button
                        disabled={saving}
                        onClick={() => recordPay(m.id)}
                        className="w-full px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                      >
                        {saving
                          ? "Saving…"
                          : payMethod === "COMP"
                            ? "Record comped attendance"
                            : payMethod === "INVOICE"
                              ? "Record as unpaid invoice"
                              : payMethod === "CREDIT"
                              ? `Record externally-collected card payment${payAmount ? ` · $${Number(payAmount).toFixed(2)}` : ""}`
                              : `Record ${payMethod === "CHECK" ? "check" : "cash"} payment${payAmount ? ` · $${Number(payAmount).toFixed(2)}` : ""}`}
                      </button>
                    </>
                  )}
                  {error && <p className="text-red-600 text-xs">{error}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <button
        onClick={() => setStep("add-new")}
        className="w-full px-3 py-2 border border-dashed border-app-border rounded-lg text-xs text-text-muted hover:border-app-border hover:text-text-primary transition-colors"
      >
        + Add a brand-new member
      </button>
    </div>
  );
}

// ─── Attendance Panel ─────────────────────────────────────────────────────────

function AttendancePanel({
  sessionId,
  sessionName,
  onClose,
}: {
  sessionId: string;
  sessionName: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{
    session: ClassSession & {
      recurringClass: { id: string; name: string; capacity: number | null };
    };
    attendance: AttendanceRecord[];
    pricingOptions: PricingOption[];
    acceptedMemberships: AcceptedMembership[];
    freeTrial: FreeTrialSummary | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [filter, setFilter] = useState("");
  // Drop-In on a roster row opens a charge form (price + method) instead of
  // silently flipping status — the charge flow used to exist only on the
  // quick-add search rows, so anyone already on the roster couldn't be charged.
  const [chargeRecId, setChargeRecId] = useState<string | null>(null);
  const [chargeAmount, setChargeAmount] = useState("");
  const [chargeMethod, setChargeMethod] = useState<PayMethod>("CASH");
  const [chargeEmailReceipt, setChargeEmailReceipt] = useState(false);
  const [chargeError, setChargeError] = useState("");
  // Trial on a roster row asks for confirmation first — it starts the club's
  // free-trial membership window, not just an attendance mark.
  const [trialRecId, setTrialRecId] = useState<string | null>(null);
  const [trialEmailReceipt, setTrialEmailReceipt] = useState(false);
  const [trialError, setTrialError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/attendance/${sessionId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);

  async function setStatus(memberId: string, status: string) {
    setUpdating(memberId);
    await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ classSessionId: sessionId, memberId, status }),
    });
    setUpdating(null);
    load();
  }

  function openDropInCharge(rec: AttendanceRecord) {
    if (chargeRecId === rec.id) { setChargeRecId(null); return; }
    const opts = data?.pricingOptions ?? [];
    const dropIn = opts.find((o) => o.type === "dropin") as { price: number } | undefined;
    const nonMember = opts.find((o) => o.type === "nonmember") as { price: number } | undefined;
    const memberOpt = opts.find((o) => o.type === "member") as { price: number } | undefined;
    const def = dropIn?.price ?? nonMember?.price ?? memberOpt?.price ?? 0;
    setChargeAmount(def ? String(def) : "");
    setChargeMethod("CASH");
    setChargeEmailReceipt(false);
    setChargeError("");
    setTrialRecId(null);
    setChargeRecId(rec.id);
  }

  function openTrialConfirm(rec: AttendanceRecord) {
    if (trialRecId === rec.id) { setTrialRecId(null); return; }
    setTrialEmailReceipt(false);
    setTrialError("");
    setChargeRecId(null);
    setTrialRecId(rec.id);
  }

  async function confirmTrial(rec: AttendanceRecord) {
    setUpdating(rec.member.id);
    setTrialError("");
    const res = await fetch("/api/attendance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classSessionId: sessionId,
        memberId: rec.member.id,
        status: "TRIAL",
        emailReceipt: trialEmailReceipt,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setUpdating(null);
    if (!res.ok) {
      setTrialError(typeof d.error === "string" ? d.error : "Could not start the trial");
      return;
    }
    setTrialRecId(null);
    load();
  }

  // CARD_ON_FILE never goes through here — it charges via ChargeSavedCardPanel.
  async function recordDropInCharge(rec: AttendanceRecord) {
    if (chargeMethod === "CARD_ON_FILE") return;
    setUpdating(rec.member.id);
    setChargeError("");
    const res = await fetch("/api/attendance/charge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        classSessionId: sessionId,
        memberId: rec.member.id,
        status: "DROP_IN",
        paymentMethod: chargeMethod,
        amount: Number(chargeAmount || 0),
        emailReceipt: chargeEmailReceipt,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setUpdating(null);
    if (!res.ok) {
      setChargeError(typeof d.error === "string" ? d.error : "Could not record the charge");
      return;
    }
    setChargeRecId(null);
    load();
  }

  // Hard remove: deletes the AttendanceRecord entirely (added by accident).
  // Not a status — leaves no attendance history for this session.
  async function removeFromRoster(rec: AttendanceRecord) {
    const name = `${rec.member.firstName} ${rec.member.lastName}`;
    if (!confirm(`Remove ${name} from this roster? This deletes the attendance entry entirely (no absent/late mark, no record kept). Any payment already collected stays in Financials.`)) return;
    setUpdating(rec.member.id);
    const res = await fetch(`/api/attendance?recordId=${encodeURIComponent(rec.id)}`, { method: "DELETE" });
    setUpdating(null);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      alert(typeof d.error === "string" ? d.error : "Failed to remove from roster");
      return;
    }
    load();
  }

  const attendance = data?.attendance ?? [];
  const filtered = filter
    ? attendance.filter(
        (r) =>
          `${r.member.firstName} ${r.member.lastName}`.toLowerCase().includes(filter.toLowerCase())
      )
    : attendance;

  const counts = Object.keys(STATUS_CONFIG).reduce(
    (acc, k) => ({ ...acc, [k]: attendance.filter((r) => r.status === k).length }),
    {} as Record<string, number>
  );

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/30" onClick={onClose} />

      {/* Panel */}
      <div className="w-[480px] bg-white shadow-2xl flex flex-col h-full overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-app-border flex-shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h2 className="font-semibold text-text-primary">{sessionName}</h2>
            <button onClick={onClose} className="text-text-muted hover:text-text-muted text-xl leading-none">×</button>
          </div>
          {/* Accepted memberships */}
          {(data?.acceptedMemberships?.length ?? 0) > 0 && (
            <div className="mb-2 text-xs text-text-muted">
              <span className="font-medium text-text-primary">Accepted memberships:</span>{" "}
              {data!.acceptedMemberships.map((m) => m.name).join(", ")}
            </div>
          )}
          {/* Status summary */}
          <div className="flex gap-2 flex-wrap">
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <span
                key={k}
                style={{ background: v.bg, color: v.fg }}
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium"
              >
                {v.label}: {counts[k] ?? 0}
              </span>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-text-muted text-center py-12">Loading roster…</p>
          ) : (
            <>
              {/* Search */}
              <div className="px-4 pt-4 pb-2">
                <input
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter attendees…"
                  className="w-full border border-app-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>

              {/* Attendance list */}
              {filtered.length === 0 && !showAdd ? (
                <div className="text-center py-8 text-text-muted text-sm px-4">
                  {filter ? "No attendees match your filter." : "No one checked in yet. Use the form below to add members."}
                </div>
              ) : (
                <div className="divide-y divide-app-border">
                  {filtered.map((rec) => {
                    const s = STATUS_CONFIG[rec.status] ?? STATUS_CONFIG.PRESENT;
                    return (
                      <div key={rec.id} className="px-4 py-3">
                        <div className="flex items-start justify-between mb-2">
                          <div>
                            <div className="text-sm font-medium text-text-primary">
                              {rec.member.firstName} {rec.member.lastName}
                              {rec.member.isMinor && (
                                <span className="ml-1.5 text-xs text-brand">(minor)</span>
                              )}
                            </div>
                            {rec.member.isMinor && rec.member.guardianName && (
                              <div className="text-xs text-text-muted">
                                Guardian: {rec.member.guardianName}
                              </div>
                            )}
                            {rec.checkedInAt && (
                              <div className="text-xs text-text-muted">
                                Checked in {new Date(rec.checkedInAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                              </div>
                            )}
                          </div>
                          <span
                            style={{ background: s.bg, color: s.fg }}
                            className="text-xs font-medium px-2 py-0.5 rounded-full flex-shrink-0"
                          >
                            {s.label}
                          </span>
                        </div>
                        {/* Status buttons */}
                        <div className="flex gap-1.5 flex-wrap items-center">
                          {Object.entries(STATUS_CONFIG).map(([k, v]) => (
                            <button
                              key={k}
                              disabled={updating === rec.member.id}
                              onClick={() =>
                                k === "DROP_IN"
                                  ? openDropInCharge(rec)
                                  : k === "TRIAL"
                                    ? openTrialConfirm(rec)
                                    : setStatus(rec.member.id, k)
                              }
                              style={
                                rec.status === k
                                  ? { background: v.bg, color: v.fg, borderColor: v.fg + "55" }
                                  : {}
                              }
                              className={`px-2.5 py-1 text-xs rounded border transition-all ${
                                rec.status === k
                                  ? "font-medium border-current"
                                  : "border-app-border text-text-muted hover:border-app-border"
                              }`}
                            >
                              {v.label}
                            </button>
                          ))}
                          <button
                            disabled={updating === rec.member.id}
                            onClick={() => removeFromRoster(rec)}
                            title="Remove from roster entirely — no attendance record is kept."
                            className="ml-auto px-2.5 py-1 text-xs rounded border border-red-200 text-red-600 hover:bg-red-50 transition-all"
                          >
                            Remove
                          </button>
                        </div>
                        {/* Drop-in charge form — price + payment method, always
                            reachable no matter which status was clicked first. */}
                        {chargeRecId === rec.id && (
                          <div className="mt-2 pt-2 border-t border-app-border space-y-2">
                            <PayMethodChips value={chargeMethod} onChange={setChargeMethod} />
                            {chargeMethod === "CARD_ON_FILE" ? (
                              <>
                                <ChargeSavedCardPanel
                                  memberId={rec.member.id}
                                  classSessionId={sessionId}
                                  classId={data?.session.recurringClass.id ?? null}
                                  status="DROP_IN"
                                  notes={null}
                                  contextLabel={sessionName}
                                  pricingOptions={data?.pricingOptions ?? []}
                                  onCharged={() => load()}
                                />
                                <button
                                  disabled={updating === rec.member.id}
                                  onClick={() => { setChargeRecId(null); setStatus(rec.member.id, "DROP_IN"); }}
                                  className="w-full px-2 py-1.5 text-xs rounded border border-app-border text-text-muted hover:bg-app-bg"
                                  title="Only set the status — no payment recorded."
                                >
                                  Mark only
                                </button>
                              </>
                            ) : (
                              <>
                                <input
                                  type="number" min="0" step="0.01"
                                  value={chargeAmount}
                                  onChange={(e) => setChargeAmount(e.target.value)}
                                  placeholder={chargeMethod === "COMP" ? "Value (optional)" : "Drop-in amount"}
                                  className="w-full border border-app-border rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand"
                                />
                                {chargeMethod === "CREDIT" && (
                                  <p className="text-[11px] text-orange-accent">
                                    AthletixOS does NOT charge the card — record only, collected on your external card reader.
                                  </p>
                                )}
                                <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                                  <input
                                    type="checkbox"
                                    checked={chargeEmailReceipt}
                                    onChange={(e) => setChargeEmailReceipt(e.target.checked)}
                                    className="w-3.5 h-3.5 accent-brand"
                                  />
                                  Email a receipt to the member
                                </label>
                                <div className="flex gap-1.5">
                                  <button
                                    disabled={updating === rec.member.id}
                                    onClick={() => recordDropInCharge(rec)}
                                    className="flex-1 px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                                  >
                                    {updating === rec.member.id
                                      ? "Saving…"
                                      : chargeMethod === "COMP"
                                        ? "Mark Drop-in (comped)"
                                        : chargeMethod === "CREDIT"
                                        ? `Record external card${chargeAmount ? ` $${Number(chargeAmount).toFixed(2)}` : ""} & mark Drop-in`
                                        : `Charge${chargeAmount ? ` $${Number(chargeAmount).toFixed(2)}` : ""} & mark Drop-in`}
                                  </button>
                                  <button
                                    disabled={updating === rec.member.id}
                                    onClick={() => { setChargeRecId(null); setStatus(rec.member.id, "DROP_IN"); }}
                                    className="px-2 py-1.5 text-xs rounded border border-app-border text-text-muted hover:bg-app-bg"
                                    title="Only set the status — no payment recorded."
                                  >
                                    Mark only
                                  </button>
                                </div>
                              </>
                            )}
                            {chargeError && <p className="text-red-600 text-xs">{chargeError}</p>}
                          </div>
                        )}
                        {/* Start-free-trial confirmation — the trial acts like a
                            membership for the configured days, so it's explicit. */}
                        {trialRecId === rec.id && (
                          <div className="mt-2 pt-2 border-t border-app-border space-y-2">
                            <p className="text-sm font-medium text-text-primary">Start free trial for this client?</p>
                            <p className="text-xs text-text-muted">
                              {data?.freeTrial
                                ? `${rec.member.firstName} gets “${data.freeTrial.name}” — ${data.freeTrial.days} day${data.freeTrial.days === 1 ? "" : "s"} free, active like a membership, then it ends automatically.${data.freeTrial.renewable ? "" : " One per client — it can't be renewed later."}`
                                : `${rec.member.firstName} gets the club's free trial and can book like a member until it ends.`}
                            </p>
                            <label className="flex items-center gap-1.5 text-[11px] text-text-muted">
                              <input
                                type="checkbox"
                                checked={trialEmailReceipt}
                                onChange={(e) => setTrialEmailReceipt(e.target.checked)}
                                className="w-3.5 h-3.5 accent-brand"
                              />
                              Email a trial receipt
                            </label>
                            <div className="flex gap-1.5">
                              <button
                                disabled={updating === rec.member.id}
                                onClick={() => confirmTrial(rec)}
                                className="flex-1 px-2 py-1.5 text-xs rounded bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
                              >
                                {updating === rec.member.id ? "Starting…" : "Start free trial"}
                              </button>
                              <button
                                disabled={updating === rec.member.id}
                                onClick={() => setTrialRecId(null)}
                                className="px-2 py-1.5 text-xs rounded border border-app-border text-text-muted hover:bg-app-bg"
                              >
                                Cancel
                              </button>
                            </div>
                            {trialError && <p className="text-red-600 text-xs">{trialError}</p>}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Add member section */}
              <div className="px-4 py-4 border-t border-app-border mt-2">
                {showAdd ? (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs font-medium text-text-primary uppercase tracking-wide">Add Member</span>
                      <button onClick={() => setShowAdd(false)} className="text-xs text-text-muted hover:text-text-muted">
                        Hide
                      </button>
                    </div>
                    <QuickAddForm
                      sessionId={sessionId}
                      sessionName={sessionName}
                      classId={data?.session.recurringClass.id ?? null}
                      pricingOptions={data?.pricingOptions ?? []}
                      acceptedMemberships={data?.acceptedMemberships ?? []}
                      freeTrial={data?.freeTrial ?? null}
                      onAdded={() => { load(); }}
                    />
                  </div>
                ) : (
                  <button
                    onClick={() => setShowAdd(true)}
                    className="w-full px-4 py-2.5 border border-app-border rounded-lg text-sm text-text-muted hover:bg-app-bg hover:border-app-border font-medium"
                  >
                    + Add Member to Session
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Item ────────────────────────────────────────────────────────────

function ScheduleItem({
  label,
  sublabel,
  timeRange,
  checkedIn,
  capacity,
  type,
  onClick,
  active,
}: {
  label: string;
  sublabel?: string;
  timeRange: string;
  checkedIn: number;
  capacity: number | null;
  type: "class" | "event";
  onClick: () => void;
  active: boolean;
}) {
  const pct = capacity ? Math.min(100, Math.round((checkedIn / capacity) * 100)) : null;

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3.5 rounded-xl border transition-all ${
        active
          ? "border-brand bg-brand text-white"
          : "border-app-border bg-white hover:border-app-border hover:bg-app-bg"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-sm font-medium truncate ${active ? "text-white" : "text-text-primary"}`}>{label}</div>
          {sublabel && (
            <div className={`text-xs mt-0.5 truncate ${active ? "text-text-muted" : "text-text-muted"}`}>{sublabel}</div>
          )}
          <div className={`text-xs mt-1 ${active ? "text-text-muted" : "text-text-muted"}`}>{timeRange}</div>
        </div>
        <div className="flex-shrink-0 text-right">
          <div className={`text-sm font-semibold ${active ? "text-white" : "text-text-primary"}`}>
            {checkedIn}
            {capacity ? <span className={`font-normal text-xs ml-0.5 ${active ? "text-text-muted" : "text-text-muted"}`}>/{capacity}</span> : ""}
          </div>
          {pct !== null && (
            <div className={`text-xs mt-0.5 ${active ? "text-text-muted" : "text-text-muted"}`}>{pct}%</div>
          )}
          <span
            className={`inline-block mt-1 text-xs px-1.5 py-0.5 rounded ${
              type === "class"
                ? active ? "bg-charcoal-hover text-text-muted" : "bg-brand/10 text-brand"
                : active ? "bg-charcoal-hover text-text-muted" : "bg-app-bg text-text-muted"
            }`}
          >
            {type === "class" ? "Class" : "Event"}
          </span>
        </div>
      </div>
    </button>
  );
}

function QrGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM21 14v3M17 21h4M14 21h0" />
    </svg>
  );
}

// ─── Main Page (inner, needs useSearchParams) ─────────────────────────────────

function AttendancePageInner() {
  const searchParams = useSearchParams();
  const initialDate = searchParams.get("date") ?? todayStr();
  const initialSession = searchParams.get("session") ?? null;

  const [date, setDate] = useState(initialDate);
  const [classSessions, setClassSessions] = useState<ClassSession[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedSession, setSelectedSession] = useState<{ id: string; name: string } | null>(
    null
  );

  const load = useCallback(async (d: string) => {
    setLoading(true);
    const res = await fetch(`/api/attendance?date=${d}`);
    if (res.ok) {
      const data = await res.json();
      setClassSessions(data.classSessions ?? []);
      setEvents(data.events ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(date); }, [date, load]);

  // Auto-open session from URL param
  useEffect(() => {
    if (initialSession && classSessions.length > 0) {
      const s = classSessions.find((cs) => cs.id === initialSession);
      if (s) setSelectedSession({ id: s.id, name: s.recurringClass.name });
    }
  }, [initialSession, classSessions]);

  const isToday = date === todayStr();
  const totalItems = classSessions.length + events.length;

  return (
    <div className="flex h-full">
      {/* Main content */}
      <div className="flex-1 p-4 sm:p-6 lg:p-8 max-w-2xl">
        <PageHeader
          title="Attendance"
          description="Check in members for today's classes and events"
          actions={<ExportMenu baseUrl="/api/export/attendance" label="Export" />}
        />

        {/* Date navigation */}
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => setDate(addDays(date, -1))}
            aria-label="Previous day"
            className="p-2 border border-app-border rounded-lg hover:bg-app-bg text-text-muted"
          >
            <ChevronLeft className="h-4 w-4" strokeWidth={2} />
          </button>
          <div className="flex-1 text-center">
            <div className="font-semibold text-text-primary">{fmtDateHeader(date)}</div>
            {isToday && (
              <div className="text-xs text-lime-accent font-medium">Today</div>
            )}
          </div>
          <button
            onClick={() => setDate(addDays(date, 1))}
            aria-label="Next day"
            className="p-2 border border-app-border rounded-lg hover:bg-app-bg text-text-muted"
          >
            <ChevronRight className="h-4 w-4" strokeWidth={2} />
          </button>
          {!isToday && (
            <button
              onClick={() => setDate(todayStr())}
              className="px-3 py-1.5 border border-app-border rounded-lg text-sm text-text-muted hover:bg-app-bg"
            >
              Today
            </button>
          )}
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="border border-app-border rounded-lg px-3 py-1.5 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-brand"
          />
        </div>

        {/* Session list */}
        {loading ? (
          <div className="text-center py-16 text-text-muted text-sm">Loading schedule…</div>
        ) : totalItems === 0 ? (
          <div className="text-center py-20 border border-dashed border-app-border rounded-xl">
            <div className="text-text-muted text-4xl mb-3">◫</div>
            <p className="text-text-muted font-medium mb-1">No sessions scheduled</p>
            <p className="text-text-muted text-sm">
              {isToday
                ? "No classes or events are scheduled for today."
                : "No classes or events are scheduled for this date."}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {classSessions.map((s) => (
              <div key={s.id} className="flex items-stretch gap-2">
                <div className="flex-1 min-w-0">
                  <ScheduleItem
                    label={s.recurringClass.name}
                    timeRange={`${fmtTime(s.startsAt)} – ${fmtTime(s.endsAt)}`}
                    checkedIn={s._count.attendance}
                    capacity={s.recurringClass.capacity}
                    type="class"
                    active={selectedSession?.id === s.id}
                    onClick={() =>
                      setSelectedSession(
                        selectedSession?.id === s.id
                          ? null
                          : { id: s.id, name: s.recurringClass.name }
                      )
                    }
                  />
                </div>
                <button
                  type="button"
                  title="Open sign-in / QR kiosk"
                  onClick={() => window.open(`/kiosk/${s.id}`, "_blank")}
                  className="flex-shrink-0 px-3 rounded-xl border border-app-border bg-white hover:bg-app-bg text-text-muted hover:text-text-primary flex items-center justify-center"
                  aria-label="Open QR kiosk"
                >
                  <QrGlyph />
                </button>
              </div>
            ))}
            {events.map((ev) => (
              <div key={ev.id} className="flex items-stretch gap-2">
                <div className="flex-1 min-w-0">
                  <ScheduleItem
                    label={ev.name}
                    sublabel={ev.location?.name}
                    timeRange={`${fmtTimeLocal(ev.startsAt)} – ${fmtTimeLocal(ev.endsAt)}`}
                    checkedIn={ev._count.bookings}
                    capacity={ev.capacity}
                    type="event"
                    active={false}
                    onClick={() => {
                      window.location.href = `/dashboard/events?event=${ev.id}`;
                    }}
                  />
                </div>
                <button
                  type="button"
                  title="Open sign-in / QR kiosk"
                  onClick={() => window.open(`/kiosk/${ev.id}`, "_blank")}
                  className="flex-shrink-0 px-3 rounded-xl border border-app-border bg-white hover:bg-app-bg text-text-muted hover:text-text-primary flex items-center justify-center"
                  aria-label="Open QR kiosk"
                >
                  <QrGlyph />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Hint */}
        {totalItems > 0 && (
          <p className="text-xs text-text-muted text-center mt-4">
            Click a class session to open the attendance roster →
          </p>
        )}
      </div>

      {/* Attendance panel slide-over */}
      {selectedSession && (
        <AttendancePanel
          sessionId={selectedSession.id}
          sessionName={selectedSession.name}
          onClose={() => setSelectedSession(null)}
        />
      )}
    </div>
  );
}

// ─── Export (wrapped in Suspense for useSearchParams) ─────────────────────────

export default function AttendancePage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 sm:p-6 lg:p-8 max-w-2xl">
          <div className="bg-white rounded-xl border border-app-border">
            <SkeletonList rows={4} />
          </div>
        </div>
      }
    >
      <AttendancePageInner />
    </Suspense>
  );
}
