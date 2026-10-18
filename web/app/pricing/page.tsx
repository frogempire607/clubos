import { Fragment } from "react";
import Link from "next/link";
import { Check, Minus, Sparkles, Mail, PhoneCall, Clock } from "lucide-react";
// Pricing overhaul (2026-10-18): base + platform fee. Every number on this
// page is read from lib/tier.ts and lib/fees.ts so marketing can never drift
// from what a club is actually charged. No sport-specific language here.
import FeeChooser from "@/components/marketing/FeeChooser";
import { TIER_PRICES, TIER_FEATURES, describePlatformFee, type Tier } from "@/lib/tier";
import { quoteCharge, formatCents } from "@/lib/fees";


const SOON = "Coming soon";

const tiers: {
  id: Tier; name: string; price: number; tagline: string; desc: string; cta: string; href: string; featured: boolean; highlights: string[];
}[] = [
  {
    id: "starter",
    name: TIER_PRICES.starter.label,
    price: TIER_PRICES.starter.monthly,
    tagline: "Take payments and run your club — free.",
    desc: "No monthly fee. You only pay when you get paid.",
    cta: "Start free",
    href: "/signup",
    featured: true,
    highlights: [
      "Memberships & plan options",
      "Classes, attendance & QR check-in",
      "Member portal & family accounts",
      "Events with registration & payment",
      "Products & private lessons",
      "Email & group announcements",
      "Documents, waivers & e-sign",
      "Family & group discounts",
      "Staff accounts, permissions & class coverage (5 seats)",
      "Stripe + cash/offline financials",
      "Membership report",
    ],
  },
  {
    id: "pro",
    name: TIER_PRICES.pro.label,
    price: TIER_PRICES.pro.monthly,
    tagline: "Automation that gives your staff hours back.",
    desc: "A lower platform rate plus the tools that save labor.",
    cta: "Start 14-day trial",
    href: "/signup",
    featured: false,
    highlights: [
      "Everything in Starter",
      "Branded mobile app",
      "Private messaging",
      "Full event toolkit: participant categories, roster grid, private links",
      "Pay plans, payroll ledger & coach calendar feeds",
      "Full financials: bank sync, expense matching, Money Out, tax summary",
      "Every report & the Action Center",
      "25 staff seats · 2 bank accounts",
    ],
  },
  {
    id: "enterprise",
    name: TIER_PRICES.enterprise.label,
    price: TIER_PRICES.enterprise.monthly,
    tagline: "For organizations running more than one entity.",
    desc: "The lowest platform rate and no caps.",
    cta: "Talk to us",
    href: "mailto:hello@athletix-os.com",
    featured: false,
    highlights: [
      "Everything in Pro",
      "Unlimited entities, bank accounts & staff seats",
      "Consolidated cross-entity reporting (coming soon)",
      "Saved & scheduled reports (coming soon)",
      "Custom permission roles (coming soon)",
      "API access & data export (coming soon)",
      "Priority support & white-glove migration",
    ],
  },
];

const lim = (n: number | null) => (n === null ? "Unlimited" : String(n));
const F = TIER_FEATURES;

const compareGroups: { group: string; rows: { label: string; values: (string | boolean)[] }[] }[] = [
  {
    group: "Pricing",
    rows: [
      { label: "Monthly", values: tiers.map((t) => (t.price === 0 ? "$0" : `$${t.price}`)) },
      { label: "AthletixOS platform fee", values: tiers.map((t) => describePlatformFee(t.id)) },
      { label: "You choose who pays each fee", values: [true, true, true] },
      { label: "Entities", values: [lim(F.starter.maxEntities), lim(F.pro.maxEntities), lim(F.enterprise.maxEntities)] },
      { label: "Bank accounts", values: [lim(F.starter.maxBankAccounts), lim(F.pro.maxBankAccounts), lim(F.enterprise.maxBankAccounts)] },
      { label: "Staff seats", values: [lim(F.starter.maxStaffSeats), lim(F.pro.maxStaffSeats), lim(F.enterprise.maxStaffSeats)] },
      { label: "Members", values: ["Unlimited", "Unlimited", "Unlimited"] },
    ],
  },
  {
    group: "Getting paid",
    rows: [
      { label: "Memberships & plan options", values: [true, true, true] },
      { label: "Classes, attendance & QR check-in", values: [true, true, true] },
      { label: "Member portal & family accounts", values: [true, true, true] },
      { label: "Events with registration & payment", values: [true, true, true] },
      { label: "Products & private lessons", values: [true, true, true] },
      { label: "Family & group discounts", values: [true, true, true] },
    ],
  },
  {
    group: "Communication",
    rows: [
      { label: "Email & group announcements", values: [true, true, true] },
      { label: "Private messaging", values: [false, true, true] },
      { label: "Branded mobile app", values: [false, true, true] },
    ],
  },
  {
    group: "Events",
    rows: [
      { label: "Event list view", values: [true, true, true] },
      { label: "Participant categories", values: [false, true, true] },
      { label: "Roster grid", values: [false, true, true] },
      { label: "Private shareable registration links", values: [false, true, true] },
      { label: "Bulk roster import", values: [false, SOON, SOON] },
    ],
  },
  {
    group: "Staff",
    rows: [
      { label: "Staff accounts & permissions", values: [true, true, true] },
      { label: "Class assignments, coverage & cancellations", values: [true, true, true] },
      { label: "Pay plans & payroll ledger", values: [false, true, true] },
      { label: "Coach calendar feeds", values: [false, true, true] },
      { label: "Custom permission roles", values: [false, false, SOON] },
    ],
  },
  {
    group: "Money & reporting",
    rows: [
      { label: "Stripe & cash/offline payments", values: [true, true, true] },
      { label: "Bank sync & expense matching", values: [false, true, true] },
      { label: "Money Out & tax summary", values: [false, true, true] },
      { label: "Documents, waivers & e-sign", values: [true, true, true] },
      { label: "Membership report", values: [true, true, true] },
      { label: "All reports (single entity)", values: [false, true, true] },
      { label: "Action Center", values: [false, true, true] },
      { label: "Consolidated cross-entity reporting", values: [false, false, SOON] },
      { label: "Saved & scheduled reports", values: [false, false, SOON] },
      { label: "API access & data export", values: [false, false, SOON] },
      { label: "Priority support & white-glove migration", values: [false, false, true] },
    ],
  },
];

const example = (() => {
  const policy = { passProcessing: false, passPlatform: false, platformRate: F.starter.platformRate, platformFixedCents: F.starter.platformFixedCents };
  return quoteCharge(10000, policy);
})();

const faqs = [
  {
    q: "How does AthletixOS make money on Starter?",
    a: `Starter has no monthly fee. AthletixOS charges a platform fee of ${describePlatformFee("starter")} on each card payment your club takes. Pro lowers it to ${describePlatformFee("pro")} and Enterprise to ${describePlatformFee("enterprise")}. Cash and check payments you record carry no fee.`,
  },
  {
    q: "Who pays the fees — my club or my members?",
    a: "You decide, separately for each fee. By default Stripe's processing fee (2.9% + $0.30) is added to the member's total and the AthletixOS platform fee comes out of your payout. Flip either switch in your payment settings and the member's total updates at checkout, with a clear line showing the fee before they pay.",
  },
  {
    q: "If I pass both fees, does my club get the full price?",
    a: "Yes. With both switches on, a $100 membership is charged so your club nets exactly $100.00 on a standard U.S. card. The total is always rounded up to the cent, so your club is never short.",
  },
  {
    q: "Do discounts change the fees?",
    a: "Discounts come off first, then the fees are worked out on the discounted price — members never pay a fee on money they didn't spend.",
  },
  {
    q: "What happens to fees on a refund?",
    a: "When you refund a card payment, the AthletixOS platform fee is refunded with it, in proportion to the amount refunded. Stripe does not return its own processing fee on refunds.",
  },
  {
    q: "Is there a free trial on Pro and Enterprise?",
    a: "Yes — 14 days. Starter is free with no time limit, so you can start there and upgrade when the labor-saving tools are worth it.",
  },
  {
    q: "Can I switch plans later?",
    a: "Yes. Upgrade or downgrade any time from your plan settings. Moving to Starter keeps all your data; Pro-only tools pause until you upgrade again.",
  },
  {
    q: "What about minors and guardians?",
    a: "Every plan includes guardian-aware accounts and billing. Guardians manage their children, pay on their behalf and receive announcements.",
  },
];

export const metadata = {
  title: "Pricing — AthletixOS | Sports Club Management Software",
  description:
    `Start free on Starter: $0/month and a ${describePlatformFee("starter")} platform fee per payment — and you choose whether your club or your members pay each fee. Pro and Enterprise lower the rate.`,
  alternates: { canonical: "/pricing" },
  openGraph: {
    title: "AthletixOS Pricing — Start free. You choose who pays which fee.",
    description:
      "Starter is $0/month. Memberships, classes, events, payments and a member portal included. Pro and Enterprise add automation and lower platform rates.",
    type: "website",
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "Product",
  name: "AthletixOS",
  description: "Club management software: memberships, classes, events, payments, member portal and staff tools.",
  brand: { "@type": "Brand", name: "AthletixOS" },
  offers: tiers.map((t) => ({
    "@type": "Offer",
    name: t.name,
    price: String(t.price),
    priceCurrency: "USD",
    description: `${t.tagline} Platform fee ${describePlatformFee(t.id)} per card payment.`,
    url: "https://athletix-os.com/pricing",
  })),
};

export default function PricingPage() {
  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F5F3EE", color: "#1C1917" }}>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      {/* ── Nav ── */}
      <header
        style={{
          position: "sticky", top: 0, zIndex: 50,
          background: "rgba(28,25,23,0.95)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 1200, margin: "0 auto",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 24px", height: 72,
          }}
        >
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.PNG" alt="AthletixOS" style={{ height: 56, width: "auto", display: "block" }} />
          </Link>
          <nav style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link href="/" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>Home</Link>
            <Link href="/pricing" style={{ color: "#fff", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>Pricing</Link>
            <Link href="/login" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>Sign in</Link>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontSize: 14, fontWeight: 500,
                padding: "7px 16px", borderRadius: 8, textDecoration: "none",
              }}
            >
              Start free
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section
        style={{
          background: "linear-gradient(135deg, #1C1917 0%, #292524 50%, #1a1560 100%)",
          padding: "80px 24px 56px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "rgba(163,230,53,0.15)",
              border: "1px solid rgba(163,230,53,0.35)",
              color: "#cdf18a",
              fontSize: 13, fontWeight: 600,
              padding: "5px 14px", borderRadius: 100,
              marginBottom: 24,
            }}
          >
            <Sparkles size={14} strokeWidth={2.5} />
            Starter is $0/month — free to start, no trial clock
          </div>
          <h1
            style={{
              fontSize: "clamp(36px, 6vw, 56px)", fontWeight: 700, lineHeight: 1.05,
              color: "#fff", marginBottom: 16, letterSpacing: "-0.02em",
              fontFamily: "var(--font-fraunces, Georgia, serif)",
            }}
          >
            Start free. You choose who pays which fee.
          </h1>
          <p style={{ fontSize: 17, color: "rgba(255,255,255,0.7)", lineHeight: 1.6 }}>
            Starter costs nothing per month — AthletixOS earns a small platform fee only when your club gets paid. Your club decides whether it or the paying member covers Stripe processing and the platform fee. No setup fees, no contracts.
          </p>
        </div>
      </section>

      {/* ── Tier cards ── */}
      <section style={{ padding: "48px 24px 80px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: 20,
              alignItems: "start",
            }}
          >
            {tiers.map((t) => (
              <div
                key={t.name}
                style={{
                  background: t.featured ? "#1C1917" : "#fff",
                  borderRadius: 16,
                  border: t.featured ? "2px solid #534AB7" : "1px solid #E7E5E4",
                  padding: "28px 24px",
                  position: "relative",
                  boxShadow: t.featured ? "0 24px 60px rgba(83,74,183,0.25)" : "0 1px 2px rgba(0,0,0,0.04)",
                }}
              >
                {t.featured && (
                  <div
                    style={{
                      position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                      background: "#534AB7", color: "#fff", fontSize: 11, fontWeight: 700,
                      padding: "4px 12px", borderRadius: 100, letterSpacing: "0.04em",
                    }}
                  >
                    START HERE
                  </div>
                )}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: t.featured ? "rgba(255,255,255,0.65)" : "#78716C", marginBottom: 6, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                    {t.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 6 }}>
                    <span style={{ fontSize: 40, fontWeight: 800, color: t.featured ? "#fff" : "#1C1917", letterSpacing: "-0.02em" }}>
                      ${t.price}
                    </span>
                    <span style={{ color: t.featured ? "rgba(255,255,255,0.45)" : "#78716C", fontSize: 14 }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 12, color: t.featured ? "rgba(163,230,53,0.85)" : "#1D9E75", fontWeight: 600, marginBottom: 4 }}>
                    Platform fee {describePlatformFee(t.id)} per payment
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: t.featured ? "#fff" : "#1C1917", marginTop: 10 }}>
                    {t.tagline}
                  </div>
                  <div style={{ fontSize: 12, color: t.featured ? "rgba(255,255,255,0.55)" : "#78716C", marginTop: 4 }}>
                    {t.desc}
                  </div>
                </div>

                <Link
                  href={t.href}
                  style={{
                    display: "block", textAlign: "center",
                    background: t.featured ? "#534AB7" : "#1C1917",
                    color: "#fff", fontWeight: 600, fontSize: 14,
                    padding: "11px 16px", borderRadius: 10,
                    textDecoration: "none", marginBottom: 20,
                  }}
                >
                  {t.cta}
                </Link>

                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
                  {t.highlights.map((h) => (
                    <li
                      key={h}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 10,
                        fontSize: 13, color: t.featured ? "rgba(255,255,255,0.78)" : "#57534e",
                      }}
                    >
                      <Check size={16} strokeWidth={2.5} style={{ color: t.featured ? "#A3E635" : "#1D9E75", flexShrink: 0, marginTop: 1 }} />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── You choose who pays which fee (headline feature) ── */}
      <section id="fees" style={{ background: "#fff", padding: "64px 24px", borderTop: "1px solid #E7E5E4" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <h2
              style={{
                fontSize: "clamp(24px, 3.4vw, 36px)", fontWeight: 700,
                fontFamily: "var(--font-fraunces, Georgia, serif)", letterSpacing: "-0.02em",
                marginBottom: 10,
              }}
            >
              You choose who pays which fee
            </h2>
            <p style={{ color: "#78716C", fontSize: 15, maxWidth: 640, margin: "0 auto", lineHeight: 1.6 }}>
              Most club software decides for you. AthletixOS gives you two independent switches — one for Stripe&apos;s
              processing fee, one for our platform fee — so you can keep prices clean for families or protect every dollar
              of your payout. Try it:
            </p>
          </div>
          <FeeChooser />
          <div style={{ marginTop: 28, background: "#FAFAF8", border: "1px solid #E7E5E4", borderRadius: 14, padding: "18px 20px" }}>
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 6 }}>Worked example: a $100 charge on Starter, club covers both fees</div>
            <p style={{ color: "#57534e", fontSize: 14, lineHeight: 1.65, margin: 0 }}>
              The member pays {formatCents(example.totalCents)}. Stripe takes 2.9% + $0.30 ({formatCents(example.stripeFeeCents)}),
              AthletixOS takes {describePlatformFee("starter")} ({formatCents(example.applicationFeeCents)}), and your club nets{" "}
              <strong>{formatCents(example.clubNetCents)}</strong>. Turn on both switches and the member pays{" "}
              {formatCents(quoteCharge(10000, { passProcessing: true, passPlatform: true, platformRate: F.starter.platformRate, platformFixedCents: F.starter.platformFixedCents }).totalCents)}
              {" "}while your club nets the full $100.00.
            </p>
          </div>
        </div>
      </section>

      {/* ── Support promise ── */}
      <section style={{ background: "#fff", padding: "64px 24px", borderTop: "1px solid #E7E5E4" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <h2
              style={{
                fontSize: "clamp(22px, 3vw, 30px)", fontWeight: 700,
                fontFamily: "var(--font-fraunces, Georgia, serif)", letterSpacing: "-0.02em",
                marginBottom: 10,
              }}
            >
              Real humans. Honest response times.
            </h2>
            <p style={{ color: "#78716C", fontSize: 15, maxWidth: 600, margin: "0 auto" }}>
              We don't promise round-the-clock chat we can't deliver. Here's exactly what every plan gets.
            </p>
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 16,
            }}
          >
            {[
              { Icon: Mail,      title: "Email support included",        desc: "Every plan. Reach a real teammate at support@athletix-os.com." },
              { Icon: Clock,     title: "3–5 business day response",      desc: "Standard reply window — most messages get a same-day answer." },
              { Icon: PhoneCall, title: "Urgent? We'll get on a call",    desc: "Operational emergencies that block your club running classes or taking payments get phone escalation." },
            ].map((c) => (
              <div
                key={c.title}
                style={{
                  background: "#FAFAF8", border: "1px solid #E7E5E4",
                  borderRadius: 14, padding: "20px 20px",
                }}
              >
                <div
                  style={{
                    width: 40, height: 40, borderRadius: 10,
                    background: "rgba(83,74,183,0.08)", color: "#534AB7",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    marginBottom: 12,
                  }}
                >
                  <c.Icon size={20} strokeWidth={2} />
                </div>
                <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{c.title}</div>
                <div style={{ color: "#78716C", fontSize: 13, lineHeight: 1.55 }}>{c.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison table ── */}
      <section style={{ background: "#fff", padding: "64px 24px 80px", borderBottom: "1px solid #E7E5E4" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h2
            style={{
              fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 700, marginBottom: 32,
              fontFamily: "var(--font-fraunces, Georgia, serif)", letterSpacing: "-0.02em",
              textAlign: "center",
            }}
          >
            Compare every plan
          </h2>
          <div style={{ overflowX: "auto", borderRadius: 12, border: "1px solid #E7E5E4" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ background: "#FAFAF8", borderBottom: "1px solid #E7E5E4" }}>
                  <th style={{ textAlign: "left", padding: "14px 16px", fontWeight: 700, color: "#78716C", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                    Feature
                  </th>
                  {tiers.map((t) => (
                    <th
                      key={t.name}
                      style={{
                        textAlign: "center", padding: "14px 16px", fontWeight: 700,
                        color: t.featured ? "#534AB7" : "#1C1917", fontSize: 13,
                      }}
                    >
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareGroups.map((g) => (
                  <Fragment key={g.group}>
                    <tr style={{ background: "#F5F3EE" }}>
                      <td colSpan={4} style={{ padding: "10px 16px", fontSize: 12, fontWeight: 700, color: "#78716C", textTransform: "uppercase", letterSpacing: "0.06em" }}>
                        {g.group}
                      </td>
                    </tr>
                    {g.rows.map((row) => (
                      <tr key={`${g.group}-${row.label}`} style={{ borderBottom: "1px solid #F1EEE8", background: "#fff" }}>
                        <td style={{ padding: "13px 16px", color: "#1C1917", fontWeight: 500 }}>{row.label}</td>
                        {row.values.map((v, j) => (
                          <td key={j} style={{ padding: "13px 16px", textAlign: "center", color: "#1C1917" }}>
                            {v === true ? (
                              <Check size={16} strokeWidth={2.5} aria-label="Included" style={{ color: "#1D9E75", display: "inline-block", verticalAlign: "middle" }} />
                            ) : v === false ? (
                              <Minus size={16} strokeWidth={2.5} aria-label="Not included" style={{ color: "#D6D3D1", display: "inline-block", verticalAlign: "middle" }} />
                            ) : v === SOON ? (
                              <span style={{ fontSize: 12, fontWeight: 600, color: "#534AB7", background: "rgba(83,74,183,0.08)", padding: "3px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>{v}</span>
                            ) : (
                              <span style={{ whiteSpace: "nowrap" }}>{v}</span>
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section style={{ padding: "80px 24px" }}>
        <div style={{ maxWidth: 780, margin: "0 auto" }}>
          <h2
            style={{
              fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 700, marginBottom: 32,
              fontFamily: "var(--font-fraunces, Georgia, serif)", letterSpacing: "-0.02em",
              textAlign: "center",
            }}
          >
            Frequently asked
          </h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {faqs.map((f) => (
              <details
                key={f.q}
                style={{
                  background: "#fff", borderRadius: 12,
                  border: "1px solid #E7E5E4", padding: "16px 20px",
                }}
              >
                <summary style={{ fontSize: 15, fontWeight: 600, color: "#1C1917", cursor: "pointer", listStyle: "none" }}>
                  {f.q}
                </summary>
                <p style={{ marginTop: 12, fontSize: 14, color: "#57534e", lineHeight: 1.65 }}>{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section style={{ background: "#534AB7", padding: "72px 24px", textAlign: "center" }}>
        <h2
          style={{
            fontSize: "clamp(24px, 3vw, 36px)", fontWeight: 700,
            color: "#fff", marginBottom: 16, letterSpacing: "-0.02em",
            fontFamily: "var(--font-fraunces, Georgia, serif)",
          }}
        >
          Start on Starter — $0/month
        </h2>
        <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 16, marginBottom: 28 }}>
          Set up your club in minutes. Upgrade only when the time-saving tools are worth it.
        </p>
        <Link
          href="/signup"
          style={{
            display: "inline-block",
            background: "#fff", color: "#534AB7", fontWeight: 700, fontSize: 16,
            padding: "14px 36px", borderRadius: 10, textDecoration: "none",
          }}
        >
          Create your club
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer style={{ background: "#1C1917", padding: "32px 24px", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <div
          style={{
            maxWidth: 1200, margin: "0 auto",
            display: "flex", alignItems: "center", justifyContent: "space-between",
            flexWrap: "wrap", gap: 16,
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.3)", fontSize: 13 }}>
            © {new Date().getFullYear()} AthletixOS. All rights reserved.
          </span>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <Link href="/" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Home</Link>
            <Link href="/pricing" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Pricing</Link>
            <Link href="/signup" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Sign up</Link>
            <Link href="/terms" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Terms</Link>
            <Link href="/privacy" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Privacy</Link>
            <a href="mailto:contact@athletix-os.com" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
