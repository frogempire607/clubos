import Link from "next/link";
import { TERMS_VERSION } from "@/legal/versions";

// Source of truth: legal/TERMS_OF_SERVICE.md (verbatim, attorney-pending).
// The DRAFT blockquote in the source file is intentionally NOT rendered here.
// Update both this page and the .md source together when the attorney returns
// changes, then bump TERMS_VERSION in legal/versions.ts.

export const metadata = {
  title: "Terms of Service",
  description:
    "AthletixOS Terms of Service. Subscription, billing, data ownership, minors and COPPA, acceptable use, and governing law.",
  alternates: { canonical: "/terms" },
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <div
      style={{
        fontFamily: "Inter, system-ui, sans-serif",
        background: "#F5F3EE",
        color: "#1C1917",
        minHeight: "100vh",
      }}
    >
      {/* ── Top nav (same chrome as marketing pages) ── */}
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
        <h1 style={h1Style}>Terms of Service</h1>
        <p style={lastUpdated}>
          <strong>Last updated:</strong> June 11, 2026
        </p>

        <p style={leadStyle}>
          These Terms of Service ("Terms") govern your access to and use of the AthletixOS platform ("Service"),
          operated by MC Technologies Group LLC ("we," "us," "AthletixOS"). By creating an account or using the Service,
          you ("you," "Club," "Customer") agree to these Terms.
        </p>

        <h2 style={h2Style}>1. The Service</h2>
        <p>
          AthletixOS is a multi-tenant software platform that helps gym and sports club owners manage members,
          memberships, events, bookings, billing, and related operations. We grant you a non-exclusive, non-transferable,
          revocable right to use the Service during your subscription, subject to these Terms.
        </p>

        <h2 style={h2Style}>2. Accounts and eligibility</h2>
        <p>
          You must be at least 18 years old and authorized to bind your organization to these Terms. You are responsible
          for the accuracy of your account information, for all activity under your account, and for keeping your
          credentials secure. Notify us promptly of any unauthorized use.
        </p>

        <h2 style={h2Style}>3. Subscription plans and billing</h2>
        <p>
          The Service is offered in tiers: Starter (free), Growth ($49/mo), Pro ($99/mo plus setup fee), and Enterprise
          ($199/mo plus setup fee). Paid plans renew automatically each billing period unless cancelled. Fees are billed
          in advance and are non-refundable except where required by law. We may change pricing with 30 days' notice;
          changes apply at your next renewal.
        </p>
        <p>
          Payments are processed by Stripe. By subscribing you also agree to Stripe's applicable terms. We do not store
          your full payment card details.
        </p>

        <h2 style={h2Style}>4. Your data and your members' data</h2>
        <p>
          <strong>You own your data.</strong> As between you and us, you and your organization own all member records,
          event data, and other content you upload ("Customer Data"). We claim no ownership of it.
        </p>
        <p>
          <strong>We act as your processor.</strong> We store and process Customer Data only to provide the Service to
          you, as described in our Privacy Policy. You are the data controller for your members' personal information
          and are responsible for having a lawful basis to collect it and for obtaining any consents required — including
          parental consent for members under 18 where applicable (see our Privacy Policy and Section 5 below).
        </p>
        <p>
          <strong>Our rights.</strong> You grant us a limited license to host, copy, transmit, and display Customer Data
          solely to operate and improve the Service and as needed for backups and security.
        </p>

        <h2 style={h2Style}>5. Minors and youth athletes</h2>
        <p>
          Many clubs using AthletixOS serve athletes under 18, including children under 13.{" "}
          <strong>
            You are responsible for collecting any parental or guardian consent required by law (including the U.S.
            Children's Online Privacy Protection Act, "COPPA") before entering a minor's personal information into the
            Service.
          </strong>{" "}
          You represent that you have obtained such consent. We provide tools to store this information but do not
          collect it directly from children and are not responsible for your failure to obtain required consents. See our{" "}
          <Link href="/privacy" style={linkStyle}>Privacy Policy</Link> for details.
        </p>

        <h2 style={h2Style}>6. Acceptable use</h2>
        <p>
          You agree not to: (a) use the Service unlawfully or to store unlawful content; (b) attempt to access another
          club's data or any part of the Service you're not authorized to access; (c) reverse engineer, scrape, or copy
          the Service or its code; (d) resell or sublicense the Service without our written permission; (e) upload
          malware or attempt to disrupt the Service; or (f) infringe anyone's intellectual property.
        </p>

        <h2 style={h2Style}>7. Intellectual property</h2>
        <p>
          The Service — including all software, code, design, branding, the AthletixOS name and logo, and associated
          content — is owned by us or our licensors and protected by copyright, trademark, and other laws. These Terms
          grant you no rights in our intellectual property except the limited right to use the Service. Feedback you
          provide may be used by us without obligation to you.
        </p>

        <h2 style={h2Style}>8. Third-party services</h2>
        <p>
          The Service integrates with third parties such as Stripe. We are not responsible for third-party services, and
          your use of them is governed by their terms.
        </p>

        <h2 style={h2Style}>9. Termination</h2>
        <p>
          You may cancel at any time; cancellation takes effect at the end of your current billing period. We may suspend
          or terminate your access for breach of these Terms, non-payment, or to comply with law. On termination, your
          right to use the Service ends. We will make Customer Data available for export for 30 days after termination,
          after which we may delete it (see Privacy Policy).
        </p>

        <h2 style={h2Style}>10. Disclaimers</h2>
        <p style={uppercaseLegal}>
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED,
          INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. We do not warrant that the
          Service will be uninterrupted or error-free.
        </p>

        <h2 style={h2Style}>11. Limitation of liability</h2>
        <p style={uppercaseLegal}>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, WE WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR LOSS OF PROFITS OR DATA. OUR TOTAL LIABILITY FOR ANY CLAIM WILL NOT
          EXCEED THE AMOUNTS YOU PAID US IN THE 12 MONTHS BEFORE THE CLAIM AROSE.
        </p>

        <h2 style={h2Style}>12. Indemnification</h2>
        <p>
          You agree to indemnify and hold us harmless from claims arising out of your Customer Data and any content you
          or your members upload or post to the Service (including claims that such content infringes a third party&apos;s
          copyright, trademark, publicity, or privacy rights), your use of the Service, your violation of these Terms,
          or your failure to obtain required consents (including parental consent for minors).
        </p>

        <h2 style={h2Style}>13. Changes to these Terms</h2>
        <p>
          We may update these Terms. We will post the updated version with a new "Last updated" date and, for material
          changes, provide reasonable notice. Continued use after changes means you accept them.
        </p>

        <h2 style={h2Style}>14. Governing law</h2>
        <p>
          These Terms are governed by the laws of the State of New York, without regard to conflict-of-laws rules.
          Disputes will be resolved in the state or federal courts located in Tompkins County, New York, unless the
          parties agree otherwise.
        </p>

        <h2 style={h2Style}>15. Copyright complaints (DMCA)</h2>
        <p>
          We respect intellectual property rights and respond to notices that comply with the Digital Millennium
          Copyright Act (17 U.S.C. § 512). If you believe content on the Service infringes your copyright, send a
          written notice to our Designated Copyright Agent including: (a) your physical or electronic signature; (b)
          identification of the copyrighted work claimed to be infringed; (c) identification of the material and its
          location on the Service; (d) your contact information; (e) a statement that you have a good-faith belief the
          use is not authorized by the copyright owner, its agent, or the law; and (f) a statement, under penalty of
          perjury, that the notice is accurate and you are authorized to act for the copyright owner.
        </p>
        <p>
          Designated Copyright Agent: Copyright Agent, MC Technologies Group LLC, 981 Dryden Rd, Ithaca, NY 14850 —{" "}
          <a href="mailto:dmca@athletix-os.com" style={linkStyle}>dmca@athletix-os.com</a>. We may remove or disable
          access to allegedly infringing material, notify the user who posted it (who may submit a counter-notification
          under § 512(g)), and terminate repeat infringers&apos; accounts.
        </p>

        <h2 style={h2Style}>16. Contact</h2>
        <p>
          Questions about these Terms:
          <br />
          <a href="mailto:support@athletix-os.com" style={linkStyle}>support@athletix-os.com</a>
          <br />
          MC Technologies Group LLC
          <br />
          981 Dryden Rd, Ithaca, NY 14850
        </p>

        <p style={versionStyle}>
          Document version: <code style={codeStyle}>{TERMS_VERSION}</code>
        </p>
      </article>

      {/* ── Footer ── */}
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

/* ── Inline style constants — kept local so the page is self-contained ── */
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
const uppercaseLegal: React.CSSProperties = { fontSize: 14, color: "#1C1917", lineHeight: 1.7 };
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
