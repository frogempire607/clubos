import Link from "next/link";
import {
  Users,
  CalendarDays,
  CreditCard,
  CheckCircle2,
  MessageSquare,
  BarChart3,
  Sparkles,
  Check,
  ArrowRight,
  ShieldCheck,
  Smartphone,
  Zap,
  type LucideIcon,
} from "lucide-react";

const features: { Icon: LucideIcon; title: string; desc: string }[] = [
  {
    Icon: Users,
    title: "Members & families",
    desc: "Full roster with guardian accounts for minors, sibling linking, custom fields, tags, and CSV import.",
  },
  {
    Icon: CalendarDays,
    title: "Classes & events",
    desc: "Recurring class schedules that auto-generate sessions. One-off clinics, camps, and tournaments with per-session pricing.",
  },
  {
    Icon: CreditCard,
    title: "Memberships & billing",
    desc: "Flexible membership plans with multiple pricing options. Stripe Connect sends payments straight to your bank — 0% platform fee.",
  },
  {
    Icon: CheckCircle2,
    title: "Attendance tracking",
    desc: "Check in members by session. Present, absent, late, trial, drop-in — full attendance history per athlete.",
  },
  {
    Icon: MessageSquare,
    title: "Messaging & announcements",
    desc: "Direct messages, group threads, broadcast announcements. Guardians auto-included on every minor's thread.",
  },
  {
    Icon: BarChart3,
    title: "Reports & financials",
    desc: "Revenue by month, active subscriptions, transaction history, and CSV exports for every major data section.",
  },
];

const tiers = [
  {
    name: "Growth",
    price: 50,
    desc: "Everything you need to run your club.",
    highlights: ["Up to 200 members", "1 location", "Classes, events & attendance", "Memberships & billing", "Messaging & private lessons", "Reports & analytics"],
    cta: "Start free trial",
    featured: true,
  },
  {
    name: "Pro",
    price: 99,
    desc: "Built for growing, professional organizations.",
    highlights: ["Everything in Growth", "Unlimited members", "Up to 3 locations", "Plaid bank sync", "Email & SMS messaging", "Branded iOS + Android app"],
    cta: "Start free trial",
    featured: false,
  },
  {
    name: "Enterprise",
    price: 199,
    desc: "Powerful infrastructure for large-scale operations.",
    highlights: ["Everything in Pro", "Unlimited locations", "API access", "SSO & advanced permissions", "Custom onboarding", "Dedicated account manager"],
    cta: "Contact us",
    featured: false,
  },
];

const useCases = [
  { sport: "Wrestling academies", note: "Practice scheduling, weight-class rosters, dual-meet management." },
  { sport: "BJJ & MMA gyms",       note: "Belt promotions, open-mat tracking, private lesson packages." },
  { sport: "Gymnastics clubs",     note: "Level-based class enrollment, meet sign-ups, parent portal." },
  { sport: "Youth sports",         note: "Season memberships, tournaments, guardian-aware billing." },
];

const valueProps = [
  {
    Icon: Zap,
    title: "Replace 7 apps with 1",
    desc: "Stop juggling spreadsheets, group chats, Venmo, paper waivers, and a separate scheduler. AthletixOS is one login for your whole club.",
  },
  {
    Icon: ShieldCheck,
    title: "0% platform fee. Ever.",
    desc: "Your flat monthly subscription is all we charge. Members pay you directly through Stripe Connect — every dollar lands in your bank.",
  },
  {
    Icon: Smartphone,
    title: "Native iOS + Android shell",
    desc: "Members get an app that feels like an app — push-ready, offline-aware, and branded to your club on Pro+.",
  },
];

export const metadata = {
  title: "AthletixOS — Sports Club Management Software for Wrestling, Martial Arts & Youth Sports",
  description:
    "Run your gym without spreadsheets. Members, classes, payments, attendance, messaging — all in one. 14-day free trial. 0% platform fee. Built for wrestling, BJJ, MMA, gymnastics, and youth sports.",
  alternates: { canonical: "/" },
  openGraph: {
    title: "AthletixOS — Run your club. All in one system.",
    description:
      "All-in-one platform for gym and sports club owners. 14-day free trial. 0% platform fee.",
    type: "website",
  },
};

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
            <img src="/brand/logo.PNG" alt="AthletixOS" style={{ height: 56, width: "auto", display: "block" }} />
          </Link>
          <nav style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link href="/pricing" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>Pricing</Link>
            <Link href="/login" style={{ color: "rgba(255,255,255,0.65)", fontSize: 14, padding: "6px 14px", textDecoration: "none" }}>Sign in</Link>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontSize: 14, fontWeight: 600,
                padding: "8px 16px", borderRadius: 8, textDecoration: "none",
              }}
            >
              Start free trial
            </Link>
          </nav>
        </div>
      </header>

      {/* ── Hero ── */}
      <section
        style={{
          background: "linear-gradient(135deg, #0F0E1A 0%, #1C1917 45%, #1a1560 100%)",
          padding: "96px 24px 72px",
          textAlign: "center",
          position: "relative", overflow: "hidden",
        }}
      >
        {/* subtle radial glow */}
        <div
          aria-hidden
          style={{
            position: "absolute", top: -200, left: "50%", transform: "translateX(-50%)",
            width: 900, height: 900, borderRadius: "50%",
            background: "radial-gradient(circle, rgba(163,230,53,0.08) 0%, transparent 60%)",
            pointerEvents: "none",
          }}
        />
        <div style={{ maxWidth: 860, margin: "0 auto", position: "relative" }}>
          <div
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "rgba(163,230,53,0.15)",
              border: "1px solid rgba(163,230,53,0.35)",
              color: "#cdf18a",
              fontSize: 13, fontWeight: 600,
              padding: "5px 14px", borderRadius: 100,
              marginBottom: 28,
            }}
          >
            <Sparkles size={14} strokeWidth={2.5} />
            14-day free trial · 0% platform fee
          </div>

          <h1
            style={{
              fontSize: "clamp(40px, 7vw, 72px)", fontWeight: 800, lineHeight: 1.02,
              color: "#fff", marginBottom: 24, letterSpacing: "-0.03em",
              fontFamily: "var(--font-fraunces, Georgia, serif)",
            }}
          >
            Run your club.<br />
            <span style={{ color: "#A3E635" }}>All in one system.</span>
          </h1>
          <p
            style={{
              fontSize: 19, color: "rgba(255,255,255,0.72)",
              lineHeight: 1.6, marginBottom: 36, maxWidth: 600, margin: "0 auto 36px",
            }}
          >
            AthletixOS is the all-in-one platform for wrestling, martial arts, gymnastics, and youth sports clubs.
            Members, classes, payments, attendance, and messaging — finally in one place.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 20 }}>
            <Link
              href="/signup"
              style={{
                background: "#534AB7", color: "#fff", fontWeight: 700, fontSize: 16,
                padding: "15px 32px", borderRadius: 10, textDecoration: "none",
                display: "inline-flex", alignItems: "center", gap: 8,
                boxShadow: "0 10px 30px rgba(83,74,183,0.45)",
              }}
            >
              Start your free trial
              <ArrowRight size={18} strokeWidth={2.5} />
            </Link>
            <Link
              href="/pricing"
              style={{
                background: "rgba(255,255,255,0.08)", color: "#fff", fontWeight: 600, fontSize: 16,
                padding: "15px 32px", borderRadius: 10, textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.15)",
                display: "inline-block",
              }}
            >
              See pricing
            </Link>
          </div>
          <p style={{ fontSize: 13, color: "rgba(255,255,255,0.45)" }}>
            No credit card required to start · Cancel anytime
          </p>

          {/* Visually-hidden H1 alt for screen readers if hero typography changes */}
          <span style={{ position: "absolute", left: -9999, width: 1, height: 1, overflow: "hidden" }}>
            AthletixOS sports club management software
          </span>
        </div>

        {/* Dashboard preview mockup */}
        <div
          style={{
            maxWidth: 980, margin: "64px auto 0",
            background: "#1C1917", borderRadius: 16,
            border: "1px solid rgba(255,255,255,0.12)",
            overflow: "hidden", boxShadow: "0 40px 80px rgba(0,0,0,0.5)",
            position: "relative",
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
          <div style={{ display: "flex", minHeight: 360 }}>
            <div style={{ width: 170, background: "#1C1917", padding: "16px 10px", borderRight: "1px solid rgba(255,255,255,0.06)" }}>
              {["Dashboard","Members","Staff","Purchase Options","Classes & Events","Attendance","Messaging","Reports"].map((item, i) => (
                <div
                  key={item}
                  style={{
                    padding: "8px 12px", borderRadius: 8, marginBottom: 2,
                    background: i === 0 ? "#534AB7" : "transparent",
                    color: i === 0 ? "#fff" : "rgba(255,255,255,0.38)",
                    fontSize: 11, fontWeight: i === 0 ? 600 : 500,
                  }}
                >
                  {item}
                </div>
              ))}
            </div>
            <div style={{ flex: 1, padding: 24 }}>
              <div style={{ color: "#fff", fontWeight: 700, fontSize: 18, marginBottom: 16 }}>Good morning, Coach</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 }}>
                {[
                  { label: "Active members",     val: "148",     trend: "+12" },
                  { label: "Active subscriptions", val: "93",    trend: "+5" },
                  { label: "Monthly revenue",    val: "$4,820", trend: "+8%" },
                ].map((s) => (
                  <div key={s.label} style={{ background: "rgba(255,255,255,0.05)", borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ color: "rgba(255,255,255,0.42)", fontSize: 10, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>{s.label}</div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <div style={{ color: "#fff", fontSize: 22, fontWeight: 700 }}>{s.val}</div>
                      <div style={{ color: "#A3E635", fontSize: 11, fontWeight: 600 }}>{s.trend}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ background: "rgba(255,255,255,0.04)", borderRadius: 10, padding: "14px 16px", color: "rgba(255,255,255,0.55)", fontSize: 11 }}>
                Mini-calendar · Recent members · Upcoming classes · Revenue chart
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Trusted by line (placeholder, no fake logos) ── */}
      <section style={{ background: "#1C1917", padding: "28px 24px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto", textAlign: "center" }}>
          <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, fontWeight: 500, letterSpacing: "0.04em" }}>
            Built for wrestling, BJJ, MMA, gymnastics, jiu-jitsu, youth sports — and every coach who's tired of spreadsheets.
          </p>
        </div>
      </section>

      {/* ── Value props ── */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "96px 24px 48px" }}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <h2
            style={{
              fontSize: "clamp(30px, 4.5vw, 48px)", fontWeight: 700, marginBottom: 16,
              letterSpacing: "-0.025em",
              fontFamily: "var(--font-fraunces, Georgia, serif)",
            }}
          >
            Why coaches choose AthletixOS
          </h2>
          <p style={{ color: "#78716C", fontSize: 17, maxWidth: 560, margin: "0 auto" }}>
            We're built for the way sports clubs actually run — not generic gym software adapted from yoga studios.
          </p>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 20 }}>
          {valueProps.map((v) => (
            <div
              key={v.title}
              style={{
                background: "#fff", borderRadius: 16,
                border: "1px solid #E7E5E4", padding: 28,
              }}
            >
              <div
                style={{
                  width: 48, height: 48, borderRadius: 12,
                  background: "linear-gradient(135deg, rgba(83,74,183,0.12), rgba(163,230,53,0.12))",
                  color: "#534AB7",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 16,
                }}
              >
                <v.Icon size={24} strokeWidth={2} />
              </div>
              <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8, letterSpacing: "-0.01em" }}>{v.title}</h3>
              <p style={{ color: "#57534e", fontSize: 14, lineHeight: 1.6 }}>{v.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section style={{ maxWidth: 1200, margin: "0 auto", padding: "48px 24px 96px" }}>
        <div style={{ textAlign: "center", marginBottom: 56 }}>
          <h2
            style={{
              fontSize: "clamp(28px, 4vw, 42px)", fontWeight: 700, marginBottom: 16,
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20 }}>
          {features.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#fff", borderRadius: 16,
                border: "1px solid #E7E5E4", padding: 28,
                transition: "transform 0.2s, box-shadow 0.2s",
              }}
            >
              <div
                style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: "rgba(83,74,183,0.08)",
                  color: "#534AB7",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  marginBottom: 16,
                }}
              >
                <f.Icon size={22} strokeWidth={2} />
              </div>
              <h3 style={{ fontSize: 17, fontWeight: 700, marginBottom: 8 }}>{f.title}</h3>
              <p style={{ color: "#78716C", fontSize: 14, lineHeight: 1.6 }}>{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Use cases ── */}
      <section style={{ background: "#1C1917", padding: "96px 24px" }}>
        <div style={{ maxWidth: 1100, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <h2
              style={{
                fontSize: "clamp(28px, 4vw, 42px)", fontWeight: 700, marginBottom: 16,
                letterSpacing: "-0.02em", color: "#fff",
                fontFamily: "var(--font-fraunces, Georgia, serif)",
              }}
            >
              Built for your sport
            </h2>
            <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 17, maxWidth: 560, margin: "0 auto" }}>
              Not a generic gym CRM. AthletixOS understands the way combat sports, gymnastics, and youth athletic programs actually operate.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 16 }}>
            {useCases.map((u) => (
              <div
                key={u.sport}
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  borderRadius: 14, padding: 24,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <Check size={16} strokeWidth={2.5} style={{ color: "#A3E635" }} />
                  <div style={{ fontWeight: 700, color: "#fff", fontSize: 16 }}>{u.sport}</div>
                </div>
                <div style={{ color: "rgba(255,255,255,0.6)", fontSize: 13, lineHeight: 1.55 }}>{u.note}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing snapshot ── */}
      <section
        style={{
          background: "#fff",
          padding: "96px 24px",
          borderTop: "1px solid #E7E5E4",
          borderBottom: "1px solid #E7E5E4",
        }}
      >
        <div style={{ maxWidth: 1200, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 56 }}>
            <h2
              style={{
                fontSize: "clamp(28px, 4vw, 42px)", fontWeight: 700, marginBottom: 16,
                letterSpacing: "-0.02em",
                fontFamily: "var(--font-fraunces, Georgia, serif)",
              }}
            >
              Simple, honest pricing
            </h2>
            <p style={{ color: "#78716C", fontSize: 17 }}>
              One flat monthly price. 0% platform fee. 14-day free trial on every plan.
            </p>
          </div>
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
                  background: t.featured ? "#1C1917" : "#F5F3EE",
                  borderRadius: 16,
                  border: t.featured ? "2px solid #534AB7" : "1px solid #E7E5E4",
                  padding: "28px 24px",
                  position: "relative",
                  boxShadow: t.featured ? "0 24px 60px rgba(83,74,183,0.25)" : "none",
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
                    MOST POPULAR
                  </div>
                )}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: t.featured ? "rgba(255,255,255,0.65)" : "#78716C", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                    {t.name}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
                    <span style={{ fontSize: 38, fontWeight: 800, color: t.featured ? "#fff" : "#1C1917", letterSpacing: "-0.02em" }}>
                      ${t.price}
                    </span>
                    <span style={{ color: t.featured ? "rgba(255,255,255,0.4)" : "#78716C", fontSize: 14 }}>/mo</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: t.featured ? "rgba(163,230,53,0.85)" : "#1D9E75" }}>
                    14-day free trial · 0% platform fee
                  </div>
                  <div style={{ fontSize: 13, color: t.featured ? "rgba(255,255,255,0.6)" : "#78716C", marginTop: 8 }}>
                    {t.desc}
                  </div>
                </div>

                <Link
                  href="/signup"
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
                    <li key={h} style={{ display: "flex", alignItems: "flex-start", gap: 10, fontSize: 13, color: t.featured ? "rgba(255,255,255,0.75)" : "#57534e" }}>
                      <Check size={16} strokeWidth={2.5} style={{ color: t.featured ? "#A3E635" : "#1D9E75", flexShrink: 0, marginTop: 1 }} />
                      <span>{h}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", marginTop: 32 }}>
            <Link
              href="/pricing"
              style={{
                color: "#534AB7", fontWeight: 600, fontSize: 14,
                textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6,
              }}
            >
              Compare every feature
              <ArrowRight size={16} strokeWidth={2.5} />
            </Link>
          </div>
        </div>
      </section>

      {/* ── Final CTA ── */}
      <section
        style={{
          background: "linear-gradient(135deg, #534AB7 0%, #1a1560 100%)",
          padding: "96px 24px",
          textAlign: "center",
        }}
      >
        <h2
          style={{
            fontSize: "clamp(30px, 4.5vw, 44px)", fontWeight: 700,
            color: "#fff", marginBottom: 16, letterSpacing: "-0.02em",
            fontFamily: "var(--font-fraunces, Georgia, serif)",
          }}
        >
          Ready to run a better club?
        </h2>
        <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 17, marginBottom: 32, maxWidth: 520, margin: "0 auto 32px" }}>
          Start your 14-day free trial. Set up your club in under 5 minutes. No credit card required.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <Link
            href="/signup"
            style={{
              display: "inline-flex", alignItems: "center", gap: 8,
              background: "#fff", color: "#1C1917", fontWeight: 700, fontSize: 16,
              padding: "15px 36px", borderRadius: 10, textDecoration: "none",
            }}
          >
            Create your club
            <ArrowRight size={18} strokeWidth={2.5} />
          </Link>
          <Link
            href="/pricing"
            style={{
              display: "inline-block",
              background: "rgba(255,255,255,0.12)", color: "#fff", fontWeight: 600, fontSize: 16,
              padding: "15px 36px", borderRadius: 10, textDecoration: "none",
              border: "1px solid rgba(255,255,255,0.18)",
            }}
          >
            See pricing
          </Link>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer
        style={{
          background: "#1C1917",
          padding: "40px 24px",
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
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.PNG" alt="AthletixOS" style={{ height: 32, width: "auto", display: "block", opacity: 0.65 }} />
            <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 13 }}>
              © {new Date().getFullYear()} AthletixOS. All rights reserved.
            </span>
          </div>
          <div style={{ display: "flex", gap: 24 }}>
            <Link href="/pricing" style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, textDecoration: "none" }}>Pricing</Link>
            <Link href="/login" style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, textDecoration: "none" }}>Sign in</Link>
            <Link href="/signup" style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, textDecoration: "none" }}>Sign up</Link>
            <a href="mailto:hello@athletixos.app" style={{ color: "rgba(255,255,255,0.55)", fontSize: 13, textDecoration: "none" }}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
