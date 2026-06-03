"use client";

import { useEffect, useState } from "react";

type EventRow = {
  id: string;
  stripeEventId: string;
  type: string;
  source: string;
  livemode: boolean;
  processed: boolean;
  errorMessage: string | null;
  createdAt: string;
  processedAt: string | null;
};

type Diagnostics = {
  club: {
    id: string;
    tier: string;
    stripeAccountId: string | null;
    stripeOnboardingComplete: boolean;
    stripeChargesEnabled: boolean;
    stripePayoutsEnabled: boolean;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    subscriptionStatus: string | null;
  };
  env: {
    webhookSecretSet: boolean;
    secretKeySet: boolean;
    priceGrowthSet: boolean;
    pricePro: boolean;
    priceEnterprise: boolean;
    nextAuthUrl: string | null;
  };
  counts: { last24h: number; last24hErrors: number; total: number };
  recentEvents: EventRow[];
};

export default function StripeDiagnosticsPage() {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);

  function load() {
    setLoading(true);
    fetch("/api/stripe/diagnostics")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setData(d);
        setLoading(false);
      });
  }

  useEffect(() => { load(); }, []);

  if (loading || !data) {
    return <div className="p-8 text-center text-text-muted text-sm">Loading…</div>;
  }

  const { club, env, counts, recentEvents } = data;

  const checklist = [
    { label: "STRIPE_SECRET_KEY set in env", ok: env.secretKeySet },
    { label: "STRIPE_WEBHOOK_SECRET set in env", ok: env.webhookSecretSet },
    { label: "NEXTAUTH_URL set (success/cancel redirects)", ok: !!env.nextAuthUrl },
    { label: "Stripe Connect onboarding complete", ok: club.stripeOnboardingComplete },
    { label: "Stripe Connect charges enabled", ok: club.stripeChargesEnabled },
    { label: "Stripe Connect payouts enabled", ok: club.stripePayoutsEnabled },
    { label: "Growth tier Price ID configured", ok: env.priceGrowthSet },
    { label: "Pro tier Price ID configured", ok: env.pricePro },
    { label: "Enterprise tier Price ID configured", ok: env.priceEnterprise },
  ];
  const passed = checklist.filter((c) => c.ok).length;

  return (
    <div className="p-8 max-w-5xl mx-auto">
      <div className="mb-6 flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-text-primary">Stripe Diagnostics</h1>
          <p className="text-sm text-text-muted mt-1">
            Verify Stripe is wired correctly and inspect recent webhook activity.
          </p>
        </div>
        <button
          onClick={load}
          className="text-sm px-3 py-1.5 border border-app-border rounded-lg text-text-primary hover:bg-app-bg"
        >
          Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Events 24h" value={String(counts.last24h)} />
        <Stat label="Errors 24h" value={String(counts.last24hErrors)} accent={counts.last24hErrors > 0 ? "red" : undefined} />
        <Stat label="Total events" value={String(counts.total)} />
        <Stat label="Current plan" value={club.tier} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
        <Card title={`Setup checklist — ${passed}/${checklist.length}`}>
          <ul className="space-y-1.5">
            {checklist.map((c) => (
              <li key={c.label} className="flex items-start gap-2 text-sm">
                <span className={c.ok ? "text-green-600" : "text-red-600"}>{c.ok ? "✓" : "✗"}</span>
                <span className={c.ok ? "text-text-primary" : "text-red-600"}>{c.label}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Connect status (member payments)">
          <KeyVal label="Account ID" value={club.stripeAccountId ?? "Not connected"} mono />
          <KeyVal label="Onboarding" value={club.stripeOnboardingComplete ? "Complete" : "Incomplete"} />
          <KeyVal label="Charges" value={club.stripeChargesEnabled ? "Enabled" : "Disabled"} />
          <KeyVal label="Payouts" value={club.stripePayoutsEnabled ? "Enabled" : "Disabled"} />
        </Card>

        <Card title="Platform subscription (ClubOS billing)">
          <KeyVal label="Customer ID" value={club.stripeCustomerId ?? "—"} mono />
          <KeyVal label="Subscription ID" value={club.stripeSubscriptionId ?? "—"} mono />
          <KeyVal label="Status" value={club.subscriptionStatus ?? "—"} />
          <KeyVal label="Tier" value={club.tier} />
        </Card>

        <Card title="Environment">
          <KeyVal label="NEXTAUTH_URL" value={env.nextAuthUrl ?? "Not set"} mono />
          <KeyVal label="Webhook secret" value={env.webhookSecretSet ? "Set" : "Missing"} />
          <KeyVal label="Live mode events" value={
            recentEvents.some((e) => e.livemode) ? "Yes (production keys)" : "No (test mode)"
          } />
        </Card>
      </div>

      <Card title="Recent webhook events">
        {recentEvents.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-sm text-text-muted mb-2">No webhook events received yet.</p>
            <p className="text-[11px] text-text-muted">
              To test locally, run <code className="bg-app-bg px-1.5 py-0.5 rounded">stripe listen --forward-to localhost:3000/api/stripe/webhook</code>
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] uppercase tracking-wider text-text-muted border-b border-app-border">
                  <th className="pb-2 font-medium">When</th>
                  <th className="pb-2 font-medium">Type</th>
                  <th className="pb-2 font-medium">Source</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Event ID</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((e) => (
                  <tr key={e.id} className="border-b border-app-border last:border-0">
                    <td className="py-2 text-text-muted whitespace-nowrap">
                      {new Date(e.createdAt).toLocaleString("en-US", {
                        month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                      })}
                    </td>
                    <td className="py-2 text-text-primary">
                      {e.type}
                      {e.livemode && (
                        <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-red-50 text-red-600">LIVE</span>
                      )}
                    </td>
                    <td className="py-2 text-text-muted">{e.source}</td>
                    <td className="py-2">
                      {e.errorMessage ? (
                        <span className="text-red-600" title={e.errorMessage}>
                          ✗ Error
                        </span>
                      ) : e.processed ? (
                        <span className="text-green-600">✓ OK</span>
                      ) : (
                        <span className="text-text-muted">Pending</span>
                      )}
                    </td>
                    <td className="py-2 text-text-muted font-mono text-[10px]">
                      {e.stripeEventId.slice(0, 18)}…
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-[11px] text-text-muted mt-4">
        Webhook URL: <code className="bg-app-bg px-1 py-0.5 rounded">{env.nextAuthUrl ?? "<NEXTAUTH_URL>"}/api/stripe/webhook</code>
        {" — "}point your Stripe webhook endpoint here and copy the signing secret into <code className="bg-app-bg px-1 py-0.5 rounded">STRIPE_WEBHOOK_SECRET</code>.
      </p>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: "red" }) {
  return (
    <div className={`rounded-xl border p-4 ${accent === "red" ? "bg-red-50 border-red-200" : "bg-surface border-app-border"}`}>
      <p className="text-xs uppercase tracking-wide mb-1 text-text-muted">{label}</p>
      <p className={`text-xl font-semibold ${accent === "red" ? "text-red-700" : "text-text-primary"}`}>{value}</p>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-surface border border-app-border rounded-xl p-5">
      <h3 className="text-sm font-semibold text-text-primary mb-3">{title}</h3>
      {children}
    </div>
  );
}

function KeyVal({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm border-b border-app-border last:border-0">
      <span className="text-text-muted">{label}</span>
      <span className={`text-text-primary text-right ${mono ? "font-mono text-xs" : ""} truncate ml-2`}>
        {value}
      </span>
    </div>
  );
}
