// B6 / §1k — the non-blocking payments warning on the migration page.
//
// Informational only: nothing on the page is disabled. It says what still works
// (import, review, invitations, profile setup) and how many people it holds up
// (everyone not yet at "Membership confirmed" will reach the card step), and
// links to Settings → Payments.

"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight } from "lucide-react";

export type PaymentsReadiness = { connected: boolean; chargesEnabled: boolean; heldUp?: number };

export function MigrationStripeBanner({ payments }: { payments: PaymentsReadiness | null | undefined }) {
  if (!payments || (payments.connected && payments.chargesEnabled)) return null;
  const held = payments.heldUp ?? 0;
  const title = payments.connected
    ? "Your payments account isn’t ready to take cards yet."
    : "Payments aren’t connected yet.";
  return (
    <div
      role="note"
      className="mb-4 flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-center"
      style={{ background: "var(--color-warn-surface)", borderColor: "var(--color-warn-border)" }}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--color-warn-text)" }} aria-hidden />
        <div className="min-w-0">
          <p className="text-[13.5px] font-semibold" style={{ color: "var(--color-warn-text)" }}>{title}</p>
          <p className="mt-0.5 text-[12.5px] text-text-muted">
            Importing, reviewing, invitations and profile setup all still work.
            {held > 0
              ? ` ${held.toLocaleString()} ${held === 1 ? "person" : "people"} will stop at the card step until it’s done.`
              : " Members will stop at the card step until it’s done."}{" "}
            Nobody is charged either way.
          </p>
        </div>
      </div>
      <Link
        href="/dashboard/settings/billing"
        className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1 rounded-lg border border-app-border bg-surface px-3 text-[12.5px] font-medium text-text-primary hover:bg-app-bg md:min-h-[34px]"
      >
        Settings → Payments <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </Link>
    </div>
  );
}
