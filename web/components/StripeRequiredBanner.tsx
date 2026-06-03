"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";

type Status = {
  connected: boolean;
  stripeChargesEnabled: boolean;
};

export default function StripeRequiredBanner({ feature = "accept payments" }: { feature?: string }) {
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    fetch("/api/stripe/status").then((r) => r.json()).then(setStatus).catch(() => {});
  }, []);

  if (!status) return null;
  if (status.connected && status.stripeChargesEnabled) return null;

  return (
    <div className="mb-4 px-4 py-3 rounded-lg flex items-center gap-3" style={{ background: "var(--color-warning)", color: "#fff" }}>
      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2} />
      <div className="flex-1 text-sm">
        <span className="font-medium">Connect Stripe to {feature}.</span>{" "}
        Until you connect, members won't be able to pay you.
      </div>
      <Link href="/dashboard/settings/billing" className="inline-flex items-center gap-1 text-xs px-3 py-1.5 rounded-md font-semibold whitespace-nowrap" style={{ background: "#fff", color: "var(--color-warning)" }}>
        Connect Stripe <ArrowRight className="h-3 w-3" strokeWidth={2.5} />
      </Link>
    </div>
  );
}
