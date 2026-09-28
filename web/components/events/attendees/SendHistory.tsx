"use client";

// Per-row payment-link history (design handoff §3 "row notes"):
//   "Link sent 3× · last Sep 20 · Copy link · History"
// The count/date/link are EventRegistration.invoiceCount / invoicedAt /
// paymentUrl, written by lib/eventInvoicing.billOneRegistrant. The expanded
// list is the EmailSend rows logged against this registration
// (lib/eventLifecycleEmails — confirmation, approval, reminders). Payment-link
// emails themselves go out through the bare SMTP sender and are not logged one
// by one, so the panel says so rather than implying a complete history.

import type { AttendeeRow } from "@/lib/eventAttendees";
import { linkSentSummary, sendStatusText, type RowExtras, type SendEntry } from "@/lib/eventAttendeeExtras";

const shortDate = (s: string) => new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const dateTime = (s: string) =>
  new Date(s).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

const link = "text-[12.5px] text-brand hover:underline min-h-11 sm:min-h-0 px-0.5";

export function LinkSentLine({
  row,
  extras,
  sends,
  open,
  onToggle,
  onCopy,
}: {
  row: AttendeeRow;
  extras: RowExtras | undefined;
  sends: SendEntry[] | undefined;
  open: boolean;
  onToggle: () => void;
  onCopy: (url: string) => void;
}) {
  if (!row.registrationId) return null;
  const summary = linkSentSummary(extras, shortDate);
  const url = !row.removed ? extras?.paymentUrl ?? null : null;
  const hasHistory = (sends?.length ?? 0) > 0 || !!summary;
  if (!summary && !url && !hasHistory) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-[12.5px] text-text-muted">
      {summary && <span className="tabular-nums">{summary}</span>}
      {url && (
        <button type="button" className={link} onClick={() => onCopy(url)}>
          Copy link
        </button>
      )}
      {hasHistory && (
        <button type="button" className={link} aria-expanded={open} onClick={onToggle}>
          {open ? "Hide history" : "History"}
        </button>
      )}
    </div>
  );
}

export function SendHistoryPanel({
  extras,
  sends,
}: {
  extras: RowExtras | undefined;
  sends: SendEntry[] | undefined;
}) {
  const list = sends ?? [];
  const summary = linkSentSummary(extras, shortDate);
  return (
    <div className="rounded-[10px] border border-app-border bg-table-chrome px-3 py-2.5 text-[12.5px]">
      <div className="font-semibold text-text-primary">Emails about this registration</div>
      {summary ? (
        <p className="text-text-muted mt-0.5">
          Payment links: sent {extras?.invoiceCount === 1 ? "once" : `${extras?.invoiceCount} times`}
          {extras?.invoicedAt ? `, last ${dateTime(extras.invoicedAt)}` : ""}. Link emails sent from Sep 28, 2026 on are listed below; earlier ones are only counted.
        </p>
      ) : (
        <p className="text-text-muted mt-0.5">No payment link has been emailed.</p>
      )}
      {extras?.paymentUrl && (
        <p className="mt-1 text-text-muted break-all">
          Current link: <span className="text-text-primary select-all">{extras.paymentUrl}</span>
        </p>
      )}
      {list.length > 0 ? (
        <ul className="mt-2 divide-y divide-hairline">
          {list.map((s) => {
            const st = sendStatusText(s);
            const tone = st.tone === "ok" ? "text-success-text" : st.tone === "bad" ? "text-danger-text" : "text-text-muted";
            return (
              <li key={s.id} className="py-1.5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className="min-w-0 text-text-primary">{s.subject}</span>
                <span className="tabular-nums text-text-muted whitespace-nowrap">
                  {dateTime(s.at)} · <span className={`font-semibold ${tone}`}>{st.label}</span>
                </span>
                <span className="basis-full text-text-muted truncate">to {s.recipientEmail}</span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-text-muted">No other emails logged for this registration.</p>
      )}
    </div>
  );
}
