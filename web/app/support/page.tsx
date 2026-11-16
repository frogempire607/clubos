import Link from "next/link";

// Public support page. Both app stores ask for a support address that is a
// web page, works without signing in, and tells a person how to reach us.
//
// It promises exactly what /pricing already promises (email support, 3–5
// business days) and nothing more. Change both together.

export const metadata = {
  title: "AthletixOS support",
  description: "How to get help with AthletixOS: who to ask, how to reach us, and how to fix the most common sign-in problems.",
  alternates: { canonical: "/support" },
  robots: { index: true, follow: true },
};

const SUPPORT_EMAIL = "support@athletix-os.com";

export default function SupportPage() {
  const h2: React.CSSProperties = { fontSize: 20, fontWeight: 600, margin: "32px 0 8px" };
  const p: React.CSSProperties = { fontSize: 16, lineHeight: 1.65, margin: "0 0 12px" };
  const li: React.CSSProperties = { fontSize: 16, lineHeight: 1.6, marginBottom: 8 };
  const link: React.CSSProperties = { color: "#5948E8", textDecoration: "underline" };

  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F5F3EE", color: "#1C1917", minHeight: "100dvh" }}>
      <header style={{ background: "#1C1917", padding: "16px 24px" }}>
        <Link href="/" style={{ color: "#FFFFFF", fontWeight: 600, fontSize: 16, textDecoration: "none" }}>
          AthletixOS
        </Link>
      </header>
      <main style={{ maxWidth: 720, margin: "0 auto", padding: "40px 24px 80px" }}>
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 12px", lineHeight: 1.2 }}>AthletixOS support</h1>
        <p style={p}>
          AthletixOS is the app and website sports clubs use for memberships, schedules, check-in and payments,
          provided by MC Technologies Group LLC.
        </p>

        <h2 style={h2}>Contact us</h2>
        <p style={p}>
          Email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={link}>
            {SUPPORT_EMAIL}
          </a>
          . Tell us which club you belong to and what you were trying to do. We reply within 3 to 5 business days, and
          usually sooner.
        </p>

        <h2 style={h2}>Questions for your club</h2>
        <p style={p}>
          Your club sets its own prices, class times, refunds and cancellations. For anything about a charge, a
          membership, a booking or a refund, your club is the fastest place to ask: use Messages in the app, or the
          contact details on your club&apos;s page.
        </p>

        <h2 style={h2}>Common fixes</h2>
        <ul style={{ paddingLeft: 22, margin: "0 0 12px" }}>
          <li style={li}>
            <strong>I can&apos;t sign in.</strong> Use{" "}
            <Link href="/forgot-password" style={link}>
              Forgot password
            </Link>{" "}
            and check your spam folder for the email. You also need your club&apos;s code, which is in the invitation
            your club sent you.
          </li>
          <li style={li}>
            <strong>My account looks empty.</strong> If you have just signed up, open the &quot;Confirm your email&quot;
            message we sent. Your records appear once you press the button in it.
          </li>
          <li style={li}>
            <strong>The camera won&apos;t scan the door code.</strong> Allow camera access for AthletixOS in your
            phone&apos;s settings. You can also open your phone&apos;s own camera and point it at the code.
          </li>
          <li style={li}>
            <strong>I want to delete my account.</strong> See{" "}
            <Link href="/delete-account" style={link}>
              how to delete your account
            </Link>
            .
          </li>
        </ul>

        <p style={{ ...p, marginTop: 32 }}>
          <Link href="/privacy" style={link}>
            Privacy Policy
          </Link>
          {" · "}
          <Link href="/terms" style={link}>
            Terms of Service
          </Link>
        </p>
      </main>
    </div>
  );
}
