"use client";

// Public pricing page — the "you choose who pays which fee" control, live.
// Uses lib/fees.ts quoteCharge, the same function every real checkout uses,
// so the numbers on the marketing page are the numbers clubs get.
import { useMemo, useState } from "react";
import { quoteCharge, formatCents, type FeePolicy } from "@/lib/fees";
import { TIER_FEATURES, TIER_PRICES, type Tier } from "@/lib/tier";

const TIERS: Tier[] = ["starter", "pro", "enterprise"];

function Toggle({ label, sub, on, onChange }: { label: string; sub: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, width: "100%",
        textAlign: "left", background: on ? "rgba(83,74,183,0.08)" : "#fff",
        border: `1px solid ${on ? "#534AB7" : "#E7E5E4"}`, borderRadius: 12, padding: "14px 16px",
        cursor: "pointer", minHeight: 64,
      }}
    >
      <span>
        <span style={{ display: "block", fontWeight: 600, fontSize: 14, color: "#1C1917" }}>{label}</span>
        <span style={{ display: "block", fontSize: 12, color: "#78716C", marginTop: 2 }}>{sub}</span>
      </span>
      <span
        aria-hidden
        style={{
          width: 44, height: 24, borderRadius: 999, flexShrink: 0, position: "relative",
          background: on ? "#534AB7" : "#D6D3D1", transition: "background 150ms",
        }}
      >
        <span
          style={{
            position: "absolute", top: 2, left: on ? 22 : 2, width: 20, height: 20, borderRadius: 999,
            background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.2)", transition: "left 150ms",
          }}
        />
      </span>
    </button>
  );
}

export default function FeeChooser() {
  const [tier, setTier] = useState<Tier>("starter");
  const [passProcessing, setPassProcessing] = useState(true);
  const [passPlatform, setPassPlatform] = useState(false);
  const f = TIER_FEATURES[tier];
  const policy: FeePolicy = { passProcessing, passPlatform, platformRate: f.platformRate, platformFixedCents: f.platformFixedCents };
  const q = useMemo(() => quoteCharge(10000, policy), [tier, passProcessing, passPlatform]); // eslint-disable-line react-hooks/exhaustive-deps
  const pct = +(f.platformRate * 100).toFixed(2);

  const Row = ({ k, v, strong, minus }: { k: string; v: number; strong?: boolean; minus?: boolean }) => (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: strong ? 15 : 14, fontWeight: strong ? 700 : 400, color: strong ? "#1C1917" : "#57534e", padding: "6px 0", borderTop: strong ? "1px solid #E7E5E4" : undefined }}>
      <span>{k}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{minus ? "−" : ""}{formatCents(v)}</span>
    </div>
  );

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div role="radiogroup" aria-label="Plan" style={{ display: "flex", gap: 6, background: "#F5F3EE", padding: 4, borderRadius: 10 }}>
          {TIERS.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={tier === t}
              onClick={() => setTier(t)}
              style={{
                flex: 1, minHeight: 44, borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600,
                background: tier === t ? "#fff" : "transparent", color: tier === t ? "#1C1917" : "#78716C",
                boxShadow: tier === t ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
              }}
            >
              {TIER_PRICES[t].label}
            </button>
          ))}
        </div>
        <Toggle label="Member pays Stripe processing" sub="2.9% + $0.30, added to their total" on={passProcessing} onChange={setPassProcessing} />
        <Toggle label="Member pays the AthletixOS fee" sub={`${pct}% + $0.30 on ${TIER_PRICES[tier].label}, added to their total`} on={passPlatform} onChange={setPassPlatform} />
        <p style={{ fontSize: 12, color: "#78716C", lineHeight: 1.5, margin: "4px 2px 0" }}>
          Two separate switches, set by your club and changeable any time. Discounts come off first; fees are worked out on the discounted price.
        </p>
      </div>
      <div style={{ background: "#fff", border: "1px solid #E7E5E4", borderRadius: 16, padding: "20px 22px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#78716C", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
          On a $100 membership
        </div>
        <Row k="Membership price" v={10000} />
        {q.surchargeCents > 0 && <Row k="Added to the member's total" v={q.surchargeCents} />}
        <Row k="Member pays" v={q.totalCents} strong />
        <Row k="Stripe processing" v={q.stripeFeeCents} minus />
        <Row k="AthletixOS platform fee" v={q.applicationFeeCents} minus />
        <Row k="Your club nets" v={q.clubNetCents} strong />
        <p style={{ fontSize: 12, color: "#A8A29E", marginTop: 10, lineHeight: 1.5 }}>
          Stripe&apos;s standard U.S. card rate. Amex and international cards cost more. Cash and check payments carry no fees.
        </p>
      </div>
    </div>
  );
}
