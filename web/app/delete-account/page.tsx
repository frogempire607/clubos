import Link from "next/link";
import { planAccountDeletion } from "@/lib/accountDeletion";

// Public page: how to delete an AthletixOS account and what happens to the
// data. Google Play requires a web address for this that works without the
// app and without signing in, and names the app; Apple accepts the in-app
// path on its own. The lists below are generated from the same rules the
// in-app screen uses (lib/accountDeletion.ts), so this page cannot promise
// something the product does not do.

export const metadata = {
  title: "Delete your AthletixOS account",
  description:
    "How to delete your AthletixOS account and the data connected to it, what is removed, and what a club must keep.",
  alternates: { canonical: "/delete-account" },
  robots: { index: true, follow: true },
};

const SUPPORT_EMAIL = "support@athletix-os.com";

export default function DeleteAccountPage() {
  // A representative member and staff plan, for the wording only.
  const member = planAccountDeletion({ role: "MEMBER", otherOwners: 0, hasOwnMemberProfile: true, children: [], liveCardMemberships: [] });
  const staff = planAccountDeletion({ role: "STAFF", otherOwners: 0, hasOwnMemberProfile: false, children: [], liveCardMemberships: [] });
  const kept = Array.from(new Set([...member.kept, ...staff.kept]));

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
        <h1 style={{ fontSize: 30, fontWeight: 700, margin: "0 0 12px", lineHeight: 1.2 }}>Delete your AthletixOS account</h1>
        <p style={p}>
          AthletixOS is the app and website that sports clubs use for memberships, schedules, check-in and payments,
          provided by MC Technologies Group LLC. Anyone with an account can delete it themselves, at any time: members,
          parents and guardians, club staff and club owners.
        </p>

        <h2 style={h2}>Delete it yourself</h2>
        <ol style={{ paddingLeft: 22, margin: "0 0 12px" }}>
          <li style={li}>
            Sign in to the AthletixOS app, or at <Link href="/login" style={link}>athletix-os.com/login</Link>.
          </li>
          <li style={li}>
            <strong>Members and parents:</strong> open <strong>More</strong>, then <strong>Account</strong>, and choose{" "}
            <strong>Delete account</strong>.
            <br />
            <strong>Staff and owners:</strong> open your name at the top right, then <strong>My account</strong>, and
            choose <strong>Delete my account</strong>.
          </li>
          <li style={li}>Read what will be removed and what is kept, type the word shown, and confirm.</li>
        </ol>
        <p style={p}>Deletion takes effect immediately. You are signed out on every device and the email address is released.</p>

        <h2 style={h2}>If you cannot sign in</h2>
        <p style={p}>
          Email <a href={`mailto:${SUPPORT_EMAIL}?subject=Delete%20my%20AthletixOS%20account`} style={link}>{SUPPORT_EMAIL}</a>{" "}
          from the address on your account and tell us which club you belong to. We confirm the request with you and
          delete the account within 30 days.
        </p>

        <h2 style={h2}>What is deleted</h2>
        <ul style={{ paddingLeft: 22, margin: "0 0 12px" }}>
          {member.removed.map((t) => <li key={t} style={li}>{t}</li>)}
          <li style={li}>For staff and owners: {staff.removed[staff.removed.length - 1].charAt(0).toLowerCase() + staff.removed[staff.removed.length - 1].slice(1)}</li>
        </ul>

        <h2 style={h2}>What a club keeps, and why</h2>
        <ul style={{ paddingLeft: 22, margin: "0 0 12px" }}>
          {kept.map((t) => <li key={t} style={li}>{t}</li>)}
        </ul>
        <p style={p}>
          These records belong to the club you joined, which keeps them for as long as tax and accounting rules
          require.
        </p>

        <h2 style={h2}>Children on your account</h2>
        <p style={p}>
          A child&apos;s record belongs to the club and the family, not to one sign-in. If another parent or guardian has
          access, they keep it. If you were the only one, the child&apos;s record stays with the club but nobody can book,
          pay or sign for them online until the club adds a guardian. To have a child&apos;s information removed as well,
          ask the club directly, or write to us and we will pass the request to the club.
        </p>

        <h2 style={h2}>Memberships that are still being paid</h2>
        <p style={p}>
          Deleting your account does not cancel a club membership by itself: a membership is an agreement with the club.
          When you delete an account that still has a card-paid membership, we send the club a cancellation request on
          your behalf, and billing follows the club&apos;s terms until the club confirms.
        </p>

        <h2 style={h2}>Deleting only some of your data</h2>
        <p style={p}>
          You can change or remove your phone number, address and photo yourself under Account. For anything else, email{" "}
          <a href={`mailto:${SUPPORT_EMAIL}`} style={link}>{SUPPORT_EMAIL}</a>.
        </p>

        <p style={{ ...p, marginTop: 32 }}>
          See also our <Link href="/privacy" style={link}>Privacy Policy</Link> and <Link href="/terms" style={link}>Terms of Service</Link>.
        </p>
      </main>
    </div>
  );
}
