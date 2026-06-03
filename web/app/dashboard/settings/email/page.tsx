"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

type Data = {
  configured: boolean;
  missingVars: string[];
  sendingAddress: string;
  fromName: string;
  replyTo: string;
  defaultFromName: string;
};

export default function EmailSettingsPage() {
  const [d, setD] = useState<Data | null>(null);
  const [fromName, setFromName] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function sendTestEmail() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch("/api/club/email-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testTo ? { to: testTo } : {}),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setTestResult({ ok: true, text: `Sent to ${j.to}. Check your inbox (and spam folder).` });
      } else {
        setTestResult({ ok: false, text: j.error || "Send failed" });
      }
    } finally {
      setTesting(false);
    }
  }

  useEffect(() => {
    fetch("/api/club/email-settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((j: Data | null) => {
        if (j) {
          setD(j);
          setFromName(j.fromName);
          setReplyTo(j.replyTo);
        }
      });
  }, []);

  async function save() {
    setSaving(true);
    setError("");
    setMsg("");
    const res = await fetch("/api/club/email-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromName, replyTo }),
    });
    setSaving(false);
    if (res.ok) {
      setMsg("Saved. New emails will use this sender identity.");
      setTimeout(() => setMsg(""), 4000);
    } else {
      const j = await res.json().catch(() => ({}));
      setError(j.error || "Could not save");
    }
  }

  if (!d) return <div className="p-8 text-sm text-text-muted">Loading…</div>;

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-2">
        <Link href="/dashboard/settings" className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text-primary">
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} /> Settings
        </Link>
      </div>
      <h1 className="text-2xl font-semibold text-text-primary mb-1">Email</h1>
      <p className="text-sm text-text-muted mb-6">
        Control the name members see on emails (activation links, receipts,
        announcements) and where their replies go.
      </p>

      {/* Connection status */}
      <div
        className={`rounded-xl border p-4 mb-6 ${
          d.configured
            ? "border-lime-accent/40 bg-lime-accent/10"
            : "border-orange-accent/40 bg-orange-accent/10"
        }`}
      >
        <p className="text-sm font-semibold text-text-primary mb-1">
          {d.configured ? "✓ Email is connected" : "⚠ Email is NOT connected yet"}
        </p>
        {d.configured ? (
          <>
            <p className="text-sm text-text-muted mb-3">
              Outgoing mail is sending from{" "}
              <span className="font-mono text-text-primary">{d.sendingAddress}</span>.
              Send a test below to confirm staff invites, password resets, and
              announcements will deliver.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[200px]">
                <label className="block text-[11px] font-medium text-text-muted mb-1">
                  Send test to (leave blank to use your login email)
                </label>
                <input
                  type="email"
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
              </div>
              <button
                type="button"
                onClick={sendTestEmail}
                disabled={testing}
                className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
              >
                {testing ? "Sending…" : "Send test email"}
              </button>
            </div>
            {testResult && (
              <div
                className={`mt-3 text-sm rounded-lg px-3 py-2 ${
                  testResult.ok
                    ? "bg-lime-accent/15 border border-lime-accent/40 text-text-primary"
                    : "bg-red-50 border border-red-200 text-red-700"
                }`}
              >
                {testResult.ok ? "✓ " : "✗ "}{testResult.text}
              </div>
            )}
          </>
        ) : (
          <div className="text-sm text-text-muted space-y-2">
            <p>
              <strong className="text-text-primary">
                This is why your test email never arrived.
              </strong>{" "}
              No mail server is configured, so the app only logs emails instead of
              sending them. Nothing will be delivered until an operator sets these
              environment variables on the server:
            </p>
            <ul className="font-mono text-xs bg-charcoal text-stone-100 rounded-lg p-3 space-y-0.5">
              <li>SMTP_HOST{d.missingVars.includes("SMTP_HOST") ? "   (missing)" : ""}</li>
              <li>SMTP_PORT{d.missingVars.includes("SMTP_PORT") ? "   (missing)" : ""}</li>
              <li>SMTP_USER{d.missingVars.includes("SMTP_USER") ? "   (missing)" : ""}</li>
              <li>SMTP_PASS{d.missingVars.includes("SMTP_PASS") ? "   (missing)" : ""}</li>
              <li>EMAIL_FROM   (e.g. AthletixOS &lt;no-reply@yourdomain.com&gt;)</li>
              <li>SMTP_SECURE  (true for port 465, otherwise false)</li>
            </ul>
          </div>
        )}
      </div>

      {/* How to connect */}
      {!d.configured && (
        <div className="border border-app-border rounded-xl p-5 mb-6">
          <h2 className="text-sm font-semibold text-text-primary mb-3">
            How to officially connect an email
          </h2>
          <ol className="space-y-2 text-sm text-text-muted list-decimal list-inside">
            <li>
              Create an account with a transactional email provider —{" "}
              <strong className="text-text-primary">Resend</strong>,{" "}
              <strong className="text-text-primary">Postmark</strong>,{" "}
              <strong className="text-text-primary">SendGrid</strong>, or{" "}
              <strong className="text-text-primary">Mailgun</strong> (all have free tiers).
              Gmail also works via an “App Password” for low volume.
            </li>
            <li>
              Verify your domain in that provider and add the DNS records they give you
              (SPF + DKIM). This is what stops your emails from going to spam.
            </li>
            <li>
              Copy the provider&apos;s SMTP host, port, username, and password into the
              server environment variables listed above, and set{" "}
              <span className="font-mono text-xs">EMAIL_FROM</span> to an address on your
              verified domain (e.g.{" "}
              <span className="font-mono text-xs">no-reply@yourclub.com</span>).
            </li>
            <li>Restart the app. This page will flip to “connected”.</li>
          </ol>
          <p className="text-xs text-text-muted mt-3">
            The sending address must be on a domain you verified with the provider —
            that&apos;s a hard requirement for deliverability, so it can&apos;t be set
            per-club from this screen. The friendly name below, however, is fully yours.
          </p>
        </div>
      )}

      {/* Sender identity */}
      <div className="border border-app-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-text-primary mb-1">Sender identity</h2>
        <p className="text-xs text-text-muted mb-4">
          Members see this name in their inbox. The underlying address stays{" "}
          <span className="font-mono">{d.sendingAddress}</span> (required for
          deliverability), but replies are routed to your reply-to below.
        </p>

        <label className="block text-sm font-medium text-text-primary mb-1">
          From name
        </label>
        <input
          value={fromName}
          onChange={(e) => setFromName(e.target.value)}
          placeholder={d.defaultFromName}
          maxLength={60}
          className="w-full px-3 py-2 border border-app-border rounded-lg text-sm mb-1 focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <p className="text-xs text-text-muted mb-4">
          Inbox preview: <span className="font-medium text-text-primary">
            {(fromName || d.defaultFromName)} &lt;{d.sendingAddress.match(/<([^>]+)>/)?.[1] || d.sendingAddress}&gt;
          </span>
        </p>

        <label className="block text-sm font-medium text-text-primary mb-1">
          Reply-to email
        </label>
        <input
          value={replyTo}
          onChange={(e) => setReplyTo(e.target.value)}
          placeholder="frontdesk@yourclub.com"
          className="w-full px-3 py-2 border border-app-border rounded-lg text-sm mb-1 focus:outline-none focus:ring-2 focus:ring-brand"
        />
        <p className="text-xs text-text-muted mb-4">
          When a member hits “reply”, it goes here instead of the no-reply box.
        </p>

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3">
            {error}
          </div>
        )}
        {msg && (
          <div className="text-sm text-text-primary bg-lime-accent/15 border border-lime-accent/40 rounded-lg px-3 py-2 mb-3">
            {msg}
          </div>
        )}

        <button
          onClick={save}
          disabled={saving}
          className="px-5 py-2.5 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save sender identity"}
        </button>
      </div>
    </div>
  );
}
