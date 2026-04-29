"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
    <div className="mb-4 px-4 py-3 rounded-lg flex items-center gap-3" style={{ background: "#FAEEDA", color: "#633806" }}>
      <span className="text-base">⚠</span>
      <div className="flex-1 text-sm">
        <span className="font-medium">Connect Stripe to {feature}.</span>{" "}
        Until you connect, members won't be able to pay you.
      </div>
      <Link href="/dashboard/settings/billing" className="text-xs px-3 py-1.5 rounded-md font-medium whitespace-nowrap" style={{ background: "#633806", color: "white" }}>
        Connect Stripe →
      </Link>
    </div>
  );
}
