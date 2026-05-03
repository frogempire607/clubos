import Link from "next/link";

const features = [
  {
    icon: "◉",
    title: "Members & Families",
    desc: "Full roster management with guardian accounts for minors, sibling linking, custom fields, tags, and CSV import.",
  },
  {
    icon: "◈",
    title: "Classes & Events",
    desc: "Recurring class schedules with auto-generated sessions. One-off clinics, camps, and tournaments with per-session pricing.",
  },
  {
    icon: "◇",
    title: "Memberships & Billing",
    desc: "Flexible membership plans with multiple pricing options. Stripe Connect sends payments directly to your bank.",
  },
  {
    icon: "✓",
    title: "Attendance Tracking",
    desc: "Check in members by session. Track present, absent, late, trial, and drop-in. Full attendance history per member.",
  },
  {
    icon: "✉",
    title: "Messaging & Announcements",
    desc: "Direct messages, group threads, and broadcast announcements. Guardian auto-include for messages to minors.",
  },
  {
    icon: "▦",
    title: "Reports & Financials",
    desc: "Revenue by month, active subscriptions, transaction history, and CSV exports for every major data section.",
  },
];

const tiers = [
  {
    name: "Starter",
    price: 0,
    fee: "2.5%",
    desc: "For new clubs getting started",
    highlights: ["Up to 150 members", "1 location", "Classes & events", "Attendance tracking", "Basic announcements"],
    cta: "Start free",
    featured: false,
  },
  {
    name: "Growth",
    price: 49,
    fee: "1.25%",
    desc: "For growing clubs ready to scale",
    highlights: ["Unlimited members", "Up to 3 locations", "Direct messaging", "Reports & analytics", "Plaid bank sync"],
    cta: "Start Growth",
    featured: true,
  },
  {
    name: "Pro",
    price: 99,
    fee: "0%",
    desc: "For established clubs wanting more",
    highlights: ["Everything in Growth", "Email & SMS messaging", "Branded iOS + Android app", "Full analytics", "Priority support"],
    cta: "Start Pro",
    featured: false,
  },
  {
    name: "Enterprise",
    price: 199,
    fee: "0%",
    desc: "Multi-location organizations",
    highlights: ["Unlimited locations", "Multi-location analytics", "Custom onboarding", "API access", "Dedicated support"],
    cta: "Contact us",
    featured: false,
  },
];

export default function Home() {
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
            <Link
              href="/pricing"
              style={{
                color: "rgba(255,255,255,0.65)", fontSize: 14,
                padding: "6px 14px", borderRadius: 8,
                textDecoration: "none",
              }}
            >
              Pricing
            </Link>
            <Link
              href="/login"
              style={{
                color: "rgba(255,255,255,0.65)", fontSize: 14,
                padding: "6px 14px", borderRadius: 8,
                textDecoration: "none",
              }}
            >
              Sign in
            </Link>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontSize: 14, fontWeight: 500,
                padding: "7px 16px", borderRadius: 8, textDecoration: "none",
              }}
            >
              Get started free
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section
        style={{
          background: "linear-gradient(135deg, #1C1917 0%, #292524 50%, #1a1560 100%)",
          padding: "100px 24px 80px",
          textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <div
            style={{
              display: "inline-block",
              background: "rgba(83,74,183,0.2)",
              border: "1px solid rgba(83,74,183,0.4)",
              color: "#a89ef8",
              fontSize: 13, fontWeight: 500,
              padding: "4px 14px", borderRadius: 100,
              marginBottom: 28,
            }}
          >
            Built for wrestling, BJJ, MMA, gymnastics, and every sport in between
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/tagline.png"
            alt="AthletixOS — Run your club. All in one system."
            style={{
              display: "block",
              maxWidth: "min(100%, 720px)",
              width: "100%",
              height: "auto",
              margin: "0 auto 24px",
            }}
          />
          {/* Visually-hidden H1 for SEO/screen readers since the headline is now inside the image */}
          <h1 style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
            Run your club. All in one system.
          </h1>
          <p
            style={{
              fontSize: 18, color: "rgba(255,255,255,0.65)",
              lineHeight: 1.6, marginBottom: 40, maxWidth: 520, margin: "0 auto 40px",
            }}
          >
            AthletixOS is the all-in-one platform for gym and sports club owners — members,
            classes, payments, messaging, and more in one place.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontWeight: 600, fontSize: 16,
                padding: "14px 32px", borderRadius: 10, textDecoration: "none",
                display: "inline-block",
              }}
            >
              Start for free — no credit card
            </Link>
            <Link
              href="/login"
              style={{
                background: "rgba(255,255,255,0.1)", color: "#fff", fontWeight: 500, fontSize: 16,
                padding: "14px 32px", borderRadius: 10, textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.15)",
                display: "inline-block",
              }}
            >
              Sign in to your club
            </Link>
          </div>
        </div>

        {/* Dashboard preview mockup */}
        <div
          style={{
            maxWidth: 960, margin: "64px auto 0",
            background: "#1C1917", borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.12)",
            overflow: "hidden", boxShadow: "0 40px 80px rgba(0,0,0,0.5)",
          }}
        >
          <div
            style={{
              background: "#292524", padding: "10px 16px",
              display: "flex", alignItems: "center", gap: 8,
              borderBottom: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#ef4444" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#f59e0b" }} />
            <div style={{ width: 10, height: 10, borderRadius: "50%", background: "#22c55e" }} />
            <div style={{ flex: 1, background: "rgba(255,255,255,0.06)", borderRadius: 6, height: 24, maxWidth: 240, margin: "0 auto" }} />
          </div>
          <div style={{ display: "flex", minHeight: 340 }}>
            <div style={{ width: 160, background: "#1C1917", padding: "16px 10px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
              {["Dashboard","Members","Staff","Purchase Options","Classes & Events","Attendance","Messaging"].map((item, i) => (
                <div
                  key={item}
                  style={{
                    padding: "7px 12px", borderRadius: 8, marginBottom: 2,
                    background: i === 0 ? "#534AB7" : "transparent",
                    color: i === 0 ? "#fff" : "rgba(255,255,255,0.35)",
                    fontSize: 11, fontWeight: i === 0 ? 500 : 400,
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, padding: 24 }}>
              <div style={{ color: "#fff", fontWeight: 600, fontSize: 18, marginBottom: 16 }}>Dashboard</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  { label: "Total Members", val: "148" },
                  { label: "Active Memberships", val: "93" },
                  { label: "Monthly Revenue", val: "$4,820" },
                ].map((s) => (
                  <div key={s.label} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ color: "rgba(255,255,255,0.4)", fontSize: 10, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
                    <div style={{ color: "#fff", fontSize: 22, fontWeight: 700 }}>{s.val}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "12px 16px", color: "rgba(255,255,255,0.35)", fontSize: 11 }}>
                Recent members • Upcoming classes • Revenue chart
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "96px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 64 }}>
          <h2
            style={{
              fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 700, marginBottom: 16,
              letterSpacing: "-0.02em",
              fontFamily: "var(--font-fraunces, Georgia, serif)",
            }}
          >
            Everything your club needs
          </h2>
          <p style={{ color: "#78716C", fontSize: 17, maxWidth: 480, margin: "0 auto" }}>
            One platform instead of seven apps. Built for the way sports clubs actually operate.
          </p>
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
            gap: 24,
          }}
        >
          {features.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#fff", borderRadius: 16,
                border: "1px solid #E7E5E4",
                padding: 28,
              }}
            >
              <div
                style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: "rgba(83,74,183,0.08)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 20, marginBottom: 16,
                }}
              >
                {f.icon}
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 600, marginBottom: 8 }}>{f.title}</h3>
              <p style={{ color: "#78716C", fontSize: 14, lineHeight: 1.6 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Pricing ── */}
      <section
        style={{
          background: "#fff",
          padding: "96px 24px",
          borderTop: "1px solid #E7E5E4",
          borderBottom: "1px solid #E7E5E4",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 64 }}>
            <h2
              style={{
                fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 700, marginBottom: 16,
                letterSpacing: "-0.02em",
                fontFamily: "var(--font-fraunces, Georgia, serif)",
              }}
            >
              Simple, honest pricing
            </h2>
            <p style={{ color: "#78716C", fontSize: 17 }}>
              Start free. Upgrade when you&apos;re ready. No hidden fees.
            </p>
          </div>
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
                  background: t.featured ? "#1C1917" : "#F5F3EE",
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
                    <span style={{ fontSize: 36, fontWeight: 700, color: t.featured ? "#fff" : "#1C1917" }}>
                      ${t.price}
                    </span>
                    <span style={{ color: t.featured ? "rgba(255,255,255,0.4)" : "#78716C", fontSize: 14 }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 12, color: t.featured ? "rgba(255,255,255,0.45)" : "#78716C" }}>
                    + {t.fee} per transaction
                  </div>
                  <div style={{ fontSize: 13, color: t.featured ? "rgba(255,255,255,0.55)" : "#78716C", marginTop: 8 }}>
                    {t.desc}
                  </div>
                </div>

                <Link
                  href="/signup"
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
                    <li key={h} style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: t.featured ? "rgba(255,255,255,0.7)" : "#57534e" }}>
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

      {/* ── Final CTA ── */}
      <section
        style={{
          background: "#534AB7",
          padding: "80px 24px",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontSize: "clamp(28px, 4vw, 40px)", fontWeight: 700,
            color: "#fff", marginBottom: 16, letterSpacing: "-0.02em",
            fontFamily: "var(--font-fraunces, Georgia, serif)",
          }}
        >
          Ready to run a better club?
        </h2>
        <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 17, marginBottom: 32 }}>
          Join hundreds of clubs already using AthletixOS. Start free in under 5 minutes.
        </p>
        <Link
          href="/signup"
          style={{
            display: "inline-block",
            background: "#fff", color: "#534AB7", fontWeight: 700, fontSize: 16,
            padding: "14px 36px", borderRadius: 10, textDecoration: "none",
          }}
        >
          Create your club — it&apos;s free
        </Link>
      </section>

      {/* ── Footer ── */}
      <footer
        style={{
          background: "#1C1917",
          padding: "32px 24px",
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
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
            <Link href="/pricing" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Pricing</Link>
            <Link href="/signup" style={{ color: "rgba(255,255,255,0.35)", fontSize: 13, textDecoration: "none" }}>Sign up</Link>
            <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13 }}>Contact</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
