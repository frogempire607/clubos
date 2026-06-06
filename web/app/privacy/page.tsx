import Link from "next/link";
import { PRIVACY_VERSION } from "@/legal/versions";

// Source of truth: legal/PRIVACY_POLICY.md (verbatim, attorney-pending).
// The DRAFT blockquote in the source file is intentionally NOT rendered here.
// Update both this page and the .md source together when the attorney returns
// changes, then bump PRIVACY_VERSION in legal/versions.ts.

export const metadata = {
  title: "Privacy Policy",
  description:
    "AthletixOS Privacy Policy. How we handle Club and Member information, our data-controller / data-processor roles, COPPA, security, and user rights.",
  alternates: { canonical: "/privacy" },
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        background: "#F5F3EE",
        color: "#1C1917",
        minHeight: "100vh",
      }}
    >
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 50,
          background: "rgba(28,25,23,0.95)",
          backdropFilter: "blur(8px)",
          borderBottom: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div
          style={{
            maxWidth: 1200,
            margin: "0 auto",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 24px",
            height: 72,
          }}
        >
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/logo.PNG" alt="AthletixOS" style={{ height: 56, width: "auto", display: "block" }} />
          </Link>
          <nav style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Link href="/pricing" style={navLink}>Pricing</Link>
            <Link href="/login" style={navLink}>Sign in</Link>
            <Link
              href="/signup"
              style={{
                background: "#534AB7",
                color: "#fff",
                fontSize: 14,
                fontWeight: 600,
                padding: "8px 16px",
                borderRadius: 8,
                textDecoration: "none",
              }}
            >
              Start free trial
            </Link>
          </nav>
        </div>
      </header>

      <article
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "64px 24px 96px",
          lineHeight: 1.7,
        }}
      >
        <h1 style={h1Style}>Privacy Policy</h1>
        <p style={lastUpdated}>
          <strong>Last updated:</strong> [DATE — fill in on publish]
        </p>

        <p style={leadStyle}>
          This Privacy Policy explains how MC Technologies Group LLC ("we," "us," "AthletixOS") handles personal
          information in connection with the AthletixOS platform ("Service"). It covers two groups:{" "}
          <strong>(1) our customers</strong> — gym and sports club owners and their staff who use the Service ("Clubs");
          and <strong>(2) the members and athletes</strong> whose information Clubs enter into the Service ("Members").
        </p>

        <h2 style={h2Style}>1. Our two roles</h2>
        <ul style={listStyle}>
          <li>
            <strong>For Club account holders, we are the data controller.</strong> We decide how their account
            information is handled.
          </li>
          <li>
            <strong>For Member data that a Club uploads, we are a data processor.</strong> The Club is the controller.
            We process Member data only on the Club's behalf to provide the Service. This distinction matters for the
            rest of this policy.
          </li>
        </ul>

        <h2 style={h2Style}>2. Information we collect</h2>
        <p><strong>From Clubs (account holders):</strong></p>
        <ul style={listStyle}>
          <li>Account details: name, email, phone, business name, role.</li>
          <li>Billing information processed through Stripe (we do not store full card numbers).</li>
          <li>Usage and device data: log data, IP address, browser type, and how you interact with the Service.</li>
        </ul>
        <p><strong>From Clubs about their Members (we process, Club controls):</strong></p>
        <ul style={listStyle}>
          <li>
            Member profile data the Club enters: names, contact details, membership and booking history, event
            participation, and any other fields the Club chooses to store.
          </li>
          <li>
            For youth athletes, this may include a minor's information and a parent/guardian's contact details (see
            Section 7).
          </li>
        </ul>

        <h2 style={h2Style}>3. How we use information</h2>
        <p>
          We use Club account and usage data to: provide and maintain the Service, process payments, provide support,
          secure the platform, communicate with you, and improve our product. We use Member data only to provide the
          Service to the Club that controls it — we do not use Member data for our own marketing.
        </p>

        <h2 style={h2Style}>4. How we share information</h2>
        <p>
          We share information with: <strong>service providers</strong> who help us operate (e.g. Stripe for payments,
          our hosting/database providers) under confidentiality obligations; <strong>as required by law</strong> or to
          protect rights and safety; and in a <strong>business transfer</strong> (merger, acquisition) with notice. We
          do not sell personal information.
        </p>

        <h2 style={h2Style}>5. Data security</h2>
        <p>
          We use technical and organizational measures to protect personal information, including encryption in transit
          and at rest, access controls, multi-tenant isolation so one Club cannot access another Club's data, and
          signature verification on payment webhooks. No method of transmission or storage is 100% secure, and we cannot
          guarantee absolute security.
        </p>

        <h2 style={h2Style}>6. Data retention and deletion</h2>
        <p>
          We retain Club account data while your account is active. After termination, Customer Data (including Member
          data) is available for export for 30 days, after which we may delete it, subject to any legal retention
          obligations. Clubs can request deletion of specific Member records at any time, and we will action such
          requests as the Club's processor.
        </p>

        <h2 style={h2Style}>7. Children's privacy and youth athletes (COPPA)</h2>
        <p>
          AthletixOS is a tool for businesses, <strong>not</strong> a service directed at children, and we do not
          knowingly collect personal information directly from children. However, Clubs may use the Service to store
          information about Members under 18, including children under 13.
        </p>
        <p>
          <strong>
            Where a Club stores a child's personal information, the Club — not AthletixOS — is responsible for complying
            with the U.S. Children's Online Privacy Protection Act ("COPPA") and any similar laws.
          </strong>{" "}
          This includes:
        </p>
        <ul style={listStyle}>
          <li>Providing required notice to parents/guardians;</li>
          <li>
            Obtaining verifiable parental consent before collecting a child's personal information, where required;
          </li>
          <li>
            Honoring parents'/guardians' rights to review, delete, or refuse further collection of their child's
            information.
          </li>
        </ul>
        <p>
          We support Clubs by acting only on their instructions as a processor, providing data export and deletion
          tools, and limiting Member data use to delivering the Service.{" "}
          <strong>
            We rely on each Club's representation (in our Terms of Service) that it has obtained any parental consent
            required before entering a minor's information into the Service.
          </strong>{" "}
          If you are a parent or guardian and believe a child's information has been provided to us without proper
          consent, contact the relevant Club, or contact us at{" "}
          <a href="mailto:support@athletix-os.com" style={linkStyle}>support@athletix-os.com</a> and we will work with
          the Club to address it.
        </p>

        <h2 style={h2Style}>8. Your rights and choices</h2>
        <p>
          Depending on your location, you may have rights to access, correct, delete, or port your personal information,
          or to object to certain processing. <strong>Club account holders</strong> can exercise these rights by
          contacting us. <strong>Members</strong> should direct requests to the Club that controls their data; we will
          assist that Club in responding.
        </p>

        <h2 style={h2Style}>9. International users</h2>
        <p>
          The Service is operated from the United States. If you access it from elsewhere, your information may be
          transferred to and processed in the U.S.
        </p>

        <h2 style={h2Style}>10. Changes to this policy</h2>
        <p>
          We may update this policy. We will post the updated version with a new "Last updated" date and provide notice
          of material changes. Continued use after changes means you accept the updated policy.
        </p>

        <h2 style={h2Style}>11. Contact</h2>
        <p>
          Questions or requests:
          <br />
          <a href="mailto:support@athletix-os.com" style={linkStyle}>support@athletix-os.com</a>
          <br />
          MC Technologies Group LLC
          <br />
          981 Dryden Rd, Ithaca, NY 14850
        </p>

        <p style={versionStyle}>
          Document version: <code style={codeStyle}>{PRIVACY_VERSION}</code>
        </p>
      </article>

      <footer style={footerStyle}>
        <div style={footerInner}>
          <span style={footerCopy}>© {new Date().getFullYear()} AthletixOS. All rights reserved.</span>
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <Link href="/pricing" style={footerLink}>Pricing</Link>
            <Link href="/terms" style={footerLink}>Terms</Link>
            <Link href="/privacy" style={footerLink}>Privacy</Link>
            <a href="mailto:contact@athletix-os.com" style={footerLink}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

const navLink: React.CSSProperties = {
  color: "rgba(255,255,255,0.65)",
  fontSize: 14,
  padding: "6px 14px",
  textDecoration: "none",
};
const h1Style: React.CSSProperties = {
  fontSize: "clamp(32px, 5vw, 44px)",
  fontWeight: 700,
  letterSpacing: "-0.02em",
  fontFamily: "var(--font-fraunces, Georgia, serif)",
  margin: "0 0 8px",
};
const h2Style: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: "-0.01em",
  fontFamily: "var(--font-fraunces, Georgia, serif)",
  margin: "40px 0 12px",
};
const lastUpdated: React.CSSProperties = { color: "#78716C", fontSize: 14, margin: "0 0 24px" };
const leadStyle: React.CSSProperties = { fontSize: 16, color: "#1C1917" };
const linkStyle: React.CSSProperties = { color: "#534AB7", textDecoration: "underline" };
const listStyle: React.CSSProperties = { paddingLeft: 22, margin: "8px 0 16px" };
const versionStyle: React.CSSProperties = { marginTop: 48, fontSize: 13, color: "#78716C", borderTop: "1px solid #E7E5E4", paddingTop: 16 };
const codeStyle: React.CSSProperties = { background: "#fff", padding: "2px 6px", borderRadius: 4, border: "1px solid #E7E5E4", fontSize: 12 };
const footerStyle: React.CSSProperties = { background: "#1C1917", padding: "32px 24px", borderTop: "1px solid rgba(255,255,255,0.06)" };
const footerInner: React.CSSProperties = {
  maxWidth: 1200,
  margin: "0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: 16,
};
const footerCopy: React.CSSProperties = { color: "rgba(255,255,255,0.3)", fontSize: 13 };
const footerLink: React.CSSProperties = { color: "rgba(255,255,255,0.55)", fontSize: 13, textDecoration: "none" };
