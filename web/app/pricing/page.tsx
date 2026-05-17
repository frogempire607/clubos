import Link from "next/link";

const tiers = [
  {
    name: "Growth",
    price: 50,
    tagline: "Everything you need to run your club.",
    desc: "Best for newer and single-location clubs.",
    cta: "Start with Growth",
    href: "/signup",
    featured: true,
    highlights: [
      "Up to 200 members",
      "1 location",
      "Classes & events",
      "Memberships & billing",
      "Attendance tracking",
      "Direct & group messaging + announcements",
      "Private lessons & packages",
      "Stripe Connect payouts",
      "Reports & analytics",
      "CSV import & custom fields",
    ],
  },
  {
    name: "Pro",
    price: 99,
    tagline: "Built for growing, professional organizations.",
    desc: "For established clubs scaling operations.",
    cta: "Start with Pro",
    href: "/signup",
    featured: false,
    highlights: [
      "Everything in Growth",
      "Unlimited members",
      "Up to 3 locations",
      "Plaid bank reconciliation & sync",
      "Email + SMS messaging",
      "Branded iOS + Android app",
      "Advanced analytics",
      "Priority support",
    ],
  },
  {
    name: "Enterprise",
    price: 199,
    tagline: "Powerful infrastructure for large-scale operations.",
    desc: "For large organizations and multi-location brands.",
    cta: "Contact sales",
    href: "mailto:hello@clubos.app",
    featured: false,
    highlights: [
      "Everything in Pro",
      "Unlimited locations",
      "API access",
      "SSO",
      "Advanced permissions",
      "Custom onboarding",
      "Dedicated account manager",
      "Enterprise analytics & reporting",
    ],
  },
];

const compareRows = [
  { label: "Members",                values: ["200",       "Unlimited", "Unlimited"] },
  { label: "Locations",              values: ["1",         "3",         "Unlimited"] },
  { label: "AthletixOS platform fee",values: ["0%",        "0%",        "0%"] },
  { label: "Stripe Connect payouts", values: ["✓",         "✓",         "✓"] },
  { label: "Classes & events",       values: ["✓",         "✓",         "✓"] },
  { label: "Memberships & billing",  values: ["✓",         "✓",         "✓"] },
  { label: "Attendance tracking",    values: ["✓",         "✓",         "✓"] },
  { label: "Messaging & announcements", values: ["✓",      "✓",         "✓"] },
  { label: "Private lessons",        values: ["✓",         "✓",         "✓"] },
  { label: "Reports & analytics",    values: ["✓",         "Advanced",  "Enterprise"] },
  { label: "Plaid bank sync",        values: ["—",         "✓",         "✓"] },
  { label: "Email + SMS",            values: ["—",         "✓",         "✓"] },
  { label: "Branded mobile app",     values: ["—",         "✓",         "✓"] },
  { label: "API access",             values: ["—",         "—",         "✓"] },
  { label: "SSO + advanced permissions", values: ["—",     "—",         "✓"] },
  { label: "Support",                values: ["Standard",  "Priority",  "Dedicated"] },
];

const faqs = [
  {
    q: "Are there any per-transaction fees from AthletixOS?",
    a: "No. AthletixOS charges 0% on every plan — your flat monthly subscription is all you pay us. Stripe charges its own standard processing fee (2.9% + $0.30) on each payment; you can optionally pass that fee to members at checkout from your settings, so the club nets the full amount.",
  },
  {
    q: "Can members be charged the processing fee instead of the club?",
    a: "Yes. Enable “Pass processing fees to customer” in payment settings and the fee is transparently added to the member's checkout total with a clear breakdown before they pay.",
  },
  {
    q: "Can I switch plans later?",
    a: "Yes. Upgrade or downgrade at any time from your billing settings. Upgrades take effect immediately and are prorated; downgrades take effect at the end of your billing period.",
  },
  {
    q: "Do members pay for AthletixOS?",
    a: "No. AthletixOS is billed to the club owner. Members pay you directly for memberships, classes, events, and drop-ins.",
  },
  {
    q: "What about minors and guardians?",
    a: "Every plan includes guardian-aware billing and messaging. Minors don't need their own logins; guardians sign documents, receive announcements, and pay on their behalf.",
  },
  {
    q: "Can I cancel anytime?",
    a: "Yes. No contracts. Cancel from settings and your data export is yours to keep.",
  },
];

export default function PricingPage() {
  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F5F3EE", color: "#1C1917" }}>
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
            <img
              src="/brand/logo.PNG"
              alt="AthletixOS"
              style={{ height: 56, width: "auto", display: "block" }}
            />
          </Link>
          <nav style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link href="/" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>
              Home
            </Link>
            <Link href="/pricing" style={{ color: "#fff", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>
              Pricing
            </Link>
            <Link href="/login" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>
              Sign in
            </Link>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontSize: 14, fontWeight: 500,
                padding: "7px 16px", borderRadius: 8, textDecoration: "none",
              }}
            >
              Get started
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section
        style={{
          background: "linear-gradient(135deg, #1C1917 0%, #292524 50%, #1a1560 100%)",
          padding: "80px 24px 64px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1
            style={{
              fontSize: "clamp(36px, 6vw, 56px)", fontWeight: 700, lineHeight: 1.1,
              color: "#fff", marginBottom: 16, letterSpacing: "-0.02em",
              fontFamily: "var(--font-fraunces, Georgia, serif)",
            }}
          >
            Pricing for every stage of your club
          </h1>
          <p style={{ fontSize: 17, color: "rgba(255,255,255,0.65)", lineHeight: 1.6 }}>
            One flat monthly price. 0% platform fee on every plan. No setup fees, no contracts, no surprise charges.
          </p>
        </div>
      </section>

      {/* ── Tier cards ── */}
      <section style={{ padding: "48px 24px 96px" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
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
                }}
              >
                {t.featured && (
                  <div
                    style={{
                      position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)",
                      background: "#534AB7", color: "#fff", fontSize: 11, fontWeight: 600,
                      padding: "3px 12px", borderRadius: 100,
                    }}
                  >
                    Most popular
                  </div>
                )}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.featured ? "rgba(255,255,255,0.6)" : "#78716C", marginBottom: 4 }}>
                    {t.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 38, fontWeight: 700, color: t.featured ? "#fff" : "#1C1917" }}>
                      ${t.price}
                    </span>
                    <span style={{ color: t.featured ? "rgba(255,255,255,0.4)" : "#78716C", fontSize: 14 }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 12, color: t.featured ? "rgba(255,255,255,0.45)" : "#78716C" }}>
                    0% platform fee · cancel anytime
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: t.featured ? "#fff" : "#1C1917", marginTop: 10 }}>
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
                    color: "#fff", fontWeight: 500, fontSize: 14,
                    padding: "10px 16px", borderRadius: 8,
                    textDecoration: "none", marginBottom: 20,
                  }}
                >
                  {t.cta}
                </Link>

                <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                  {t.highlights.map((h) => (
                    <li
                      key={h}
                      style={{
                        display: "flex", alignItems: "flex-start", gap: 8,
                        fontSize: 13, color: t.featured ? "rgba(255,255,255,0.7)" : "#57534e",
                      }}
                    >
                      <span style={{ color: "#1D9E75", flexShrink: 0, marginTop: 1 }}>✓</span>
                      {h}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison table ── */}
      <section style={{ background: "#fff", padding: "80px 24px", borderTop: "1px solid #E7E5E4", borderBottom: "1px solid #E7E5E4" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <h2
            style={{
              fontSize: "clamp(24px, 3vw, 34px)", fontWeight: 700, marginBottom: 32,
              fontFamily: "var(--font-fraunces, Georgia, serif)", letterSpacing: "-0.02em",
              textAlign: "center",
            }}
          >
            Compare plans
          </h2>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #E7E5E4" }}>
                  <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 600, color: "#78716C", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    Feature
                  </th>
                  {tiers.map((t) => (
                    <th key={t.name} style={{ textAlign: "center", padding: "12px 16px", fontWeight: 600, color: "#1C1917" }}>
                      {t.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {compareRows.map((row, i) => (
                  <tr key={row.label} style={{ borderBottom: "1px solid #F5F3EE", background: i % 2 === 0 ? "#FAFAF8" : "#fff" }}>
                    <td style={{ padding: "14px 16px", color: "#1C1917", fontWeight: 500 }}>{row.label}</td>
                    {row.values.map((v, j) => (
                      <td key={j} style={{ padding: "14px 16px", textAlign: "center", color: v === "—" ? "#A8A29E" : "#1C1917" }}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section style={{ padding: "80px 24px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
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
                  background: "#fff",
                  borderRadius: 12,
                  border: "1px solid #E7E5E4",
                  padding: "16px 20px",
                }}
              >
                <summary style={{ fontSize: 15, fontWeight: 600, color: "#1C1917", cursor: "pointer", listStyle: "none" }}>
                  {f.q}
                </summary>
                <p style={{ marginTop: 12, fontSize: 14, color: "#57534e", lineHeight: 1.6 }}>{f.a}</p>
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
          Set up your club in under 5 minutes
        </h2>
        <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 16, marginBottom: 28 }}>
          Start on Growth and scale up the moment you need more. Cancel anytime.
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
          <div style={{ display: "flex", gap: 24 }}>
            <Link href="/" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Home</Link>
            <Link href="/pricing" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Pricing</Link>
            <Link href="/signup" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Sign up</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
