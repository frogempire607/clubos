"use client";

// The confirmation card — §5.2.7's slots, in §5.2.7's order.
//
// It renders a RegistrationRenderContext and nothing else. There is no prop
// here that says "show the success banner": what the visitor is told comes
// from the row, through the same resolver every lifecycle email uses, so the
// page and the email they were sent cannot disagree. That is the whole point
// of the §5.2 design and the reason /e/[slug]?registered=true had to go — it
// rendered "you're registered" from a query parameter, before the webhook had
// written anything.

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { RegistrationRenderContext } from "@/lib/registrationRenderState";

const SEVERITY_STYLE: Record<RegistrationRenderContext["severity"], { bg: string; fg: string; border: string }> = {
  info: { bg: "#EEF0FB", fg: "#3F3A8C", border: "#C9CCEF" },
  success: { bg: "#E8F4EC", fg: "#2F5D45", border: "#BFDECB" },
  warn: { bg: "#FDF2E3", fg: "#8A5A12", border: "#F0D9AE" },
  danger: { bg: "#FBECEC", fg: "#8F2A2A", border: "#EFC9C9" },
};

const money = (n: number) => `$${n.toFixed(2)}`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-stone-100 last:border-0">
      <span className="text-xs text-stone-500 flex-shrink-0">{label}</span>
      <span className="text-sm text-stone-900 text-right min-w-0">{children}</span>
    </div>
  );
}

export default function RegistrationCard({
  ctx,
  timeZone,
}: {
  ctx: RegistrationRenderContext;
  timeZone?: string | null;
}) {
  const router = useRouter();
  const m = ctx.meta;
  const tone = SEVERITY_STYLE[ctx.severity];

  // An in-flight checkout is the one state that changes without the visitor
  // doing anything: Stripe redirects them here in parallel with the webhook
  // that marks the row PAID. Poll briefly rather than making them refresh —
  // and stop, rather than polling a page nobody is watching forever.
  const inFlight = ctx.key === "PENDING_PAYMENT_INFLIGHT";
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    if (!inFlight || polls >= 10) return;
    const t = setTimeout(() => {
      setPolls((p) => p + 1);
      router.refresh();
    }, 3000);
    return () => clearTimeout(t);
  }, [inFlight, polls, router]);

  const fmt = (d: Date | string, withTime = true) => {
    const date = typeof d === "string" ? new Date(d) : d;
    try {
      return date.toLocaleString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
        ...(timeZone ? { timeZone } : {}),
      });
    } catch {
      return date.toISOString();
    }
  };

  return (
    <div className="max-w-xl mx-auto">
      <div className="bg-white rounded-2xl border border-stone-200 overflow-hidden">
        <div className="p-5 sm:p-6">
          <span
            className="inline-block text-[11px] font-semibold px-2.5 py-1 rounded-full"
            style={{ background: tone.bg, color: tone.fg }}
          >
            {ctx.waitingOnLabel}
          </span>
          <h1 className="text-[22px] sm:text-[25px] font-extrabold tracking-[-0.01em] text-stone-900 mt-3">
            {ctx.headline}
          </h1>
          {ctx.subheadline && <p className="text-sm text-stone-600 mt-1">{ctx.subheadline}</p>}

          <p
            className="text-sm text-stone-900 mt-3 rounded-lg px-3 py-2.5"
            style={{ background: tone.bg, border: `1px solid ${tone.border}` }}
          >
            {ctx.chargeTiming}
          </p>

          {inFlight && (
            <p className="text-xs text-stone-500 mt-2">
              Checking for your payment{".".repeat((polls % 3) + 1)}
            </p>
          )}

          {m.proposedChange && (
            <div className="mt-4 rounded-lg border border-stone-200 overflow-hidden">
              <div className="grid grid-cols-2 text-[11px] uppercase tracking-wide text-stone-500 bg-stone-50">
                <div className="px-3 py-2">You signed up for</div>
                <div className="px-3 py-2 border-l border-stone-200">Your coach proposes</div>
              </div>
              {Object.keys(m.proposedChange.proposed).map((k) => (
                <div key={k} className="grid grid-cols-2 text-sm border-t border-stone-200">
                  <div className="px-3 py-2">{String(m.proposedChange?.original[k] ?? "—")}</div>
                  <div className="px-3 py-2 border-l border-stone-200 bg-stone-50/60">
                    <strong>
                      {m.proposedChange?.proposed[k] === true
                        ? "Yes"
                        : String(m.proposedChange?.proposed[k] ?? "—")}
                    </strong>
                  </div>
                </div>
              ))}
            </div>
          )}

          {m.declineReason && (
            <blockquote className="mt-4 border-l-2 border-stone-300 pl-3 text-sm text-stone-700">
              {m.declineReason}
            </blockquote>
          )}

          <div className="mt-5">
            <Row label="Confirmation #">
              <span className="font-mono font-semibold">{m.confirmationCode}</span>
            </Row>
            <Row label="Event">{m.eventName}</Row>
            <Row label="Registered">{m.athleteName}</Row>
            {m.payerName && <Row label="Paid by">{m.payerName}</Row>}
            <Row label="Date &amp; time">{fmt(m.eventStartsAt)}</Row>
            {m.location && (
              <Row label="Location">
                {m.location.directionsUrl ? (
                  <a href={m.location.directionsUrl} className="underline" target="_blank" rel="noreferrer">
                    {m.location.name}
                  </a>
                ) : (
                  m.location.name
                )}
              </Row>
            )}
            {m.amountPaid != null && <Row label="Amount paid">{money(m.amountPaid)}</Row>}
            {m.amountDue != null && <Row label="Amount due">{money(m.amountDue)}</Row>}
            {m.amountRefunded != null && <Row label="Refunded">{money(m.amountRefunded)}</Row>}
            {m.discountLabel && <Row label="Discount">{m.discountLabel}</Row>}
            {m.cardLabel && <Row label="Card on file">{m.cardLabel}</Row>}
            {m.dueDate && (
              <Row label="Payment due by">
                {fmt(m.dueDate, false)}
                {m.proximityBadge && (
                  <span
                    className="ml-2 text-[11px] px-2 py-0.5 rounded-full"
                    style={{ background: tone.bg, color: tone.fg }}
                  >
                    {m.proximityBadge === "TODAY"
                      ? "today"
                      : m.proximityBadge === "TOMORROW"
                        ? "tomorrow"
                        : m.proximityBadge === "3_DAYS"
                          ? "in 3 days"
                          : "this week"}
                  </span>
                )}
              </Row>
            )}
            {m.escalationStage > 0 && m.dueDate && (
              <Row label="Reminders sent">{m.escalationStage}</Row>
            )}
          </div>

          {(ctx.actions.primary || ctx.actions.secondary.length > 0) && (
            <div className="flex flex-wrap gap-2 mt-5">
              {ctx.actions.primary && (
                <a
                  href={ctx.actions.primary.href}
                  className="px-4 py-2.5 rounded-lg bg-stone-900 text-white text-sm font-semibold"
                >
                  {ctx.actions.primary.label}
                </a>
              )}
              {ctx.actions.secondary.map((a) => (
                <a
                  key={a.label}
                  href={a.href}
                  className="px-4 py-2.5 rounded-lg border border-stone-300 text-stone-700 text-sm font-semibold"
                >
                  {a.label}
                </a>
              ))}
            </div>
          )}
        </div>

        {m.cancellationPolicyText && (
          <details className="border-t border-stone-200 px-5 sm:px-6 py-3">
            <summary className="text-xs text-stone-500 cursor-pointer">Cancellation policy</summary>
            <p className="text-xs text-stone-600 mt-2 whitespace-pre-line">{m.cancellationPolicyText}</p>
          </details>
        )}
      </div>

      <p className="text-[11px] text-stone-500 text-center mt-4 px-4">
        This page stays up to date — bookmark it to check on this registration any time.
        <br />
        {m.clubName}
        {m.clubContact ? ` · ${m.clubContact}` : ""}
      </p>
    </div>
  );
}
