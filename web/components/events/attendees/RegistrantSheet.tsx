"use client";

// One registrant's registration, opened by tapping their name on the
// Attendees list: who to contact, where their payment stands, and every
// answer they gave on the signup form, each under the question as the owner
// worded it. Read-only; the row's own actions stay on the list.

import Sheet from "@/components/Sheet";
import type { AttendeeRow } from "@/lib/eventAttendees";
import { answerCell, answerColumns, type AnswerSource } from "@/lib/eventFormAnswers";
import { money, type RegDetail } from "@/components/events/attendees/types";

const label = "text-[12px] font-semibold uppercase tracking-[.05em] text-text-muted";
const dt = "text-[12.5px] text-text-muted";
const dd = "text-[14px] text-text-primary break-words";

export default function RegistrantSheet({
  row,
  statusLabel,
  detail,
  source,
  registrationForm,
  onClose,
}: {
  row: AttendeeRow;
  statusLabel: string;
  detail: RegDetail | null;
  source: AnswerSource | null;
  registrationForm: unknown;
  onClose: () => void;
}) {
  const columns = source ? answerColumns(registrationForm, [source]) : answerColumns(registrationForm, []);
  const m = detail?.money;
  const signedUp = row.createdAt ? new Date(row.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;

  return (
    <Sheet open onClose={onClose} title={row.name} description={[row.source === "MEMBER" ? "Member" : "Public signup", row.attending, signedUp ? `Signed up ${signedUp}` : null].filter(Boolean).join(" · ")}>
      <section>
        <h3 className={label}>Contact</h3>
        <dl className="mt-1.5 space-y-1.5">
          <div>
            <dt className={dt}>Email{row.emailNote ? ` (${row.emailNote})` : ""}</dt>
            <dd className={dd}>
              {row.email ? <a className="text-brand hover:underline" href={`mailto:${row.email}`}>{row.email}</a> : <span className="text-warn-text">{detail?.recipient?.reason ?? "No address on file"}</span>}
            </dd>
          </div>
          <div>
            <dt className={dt}>Phone</dt>
            <dd className={dd}>{row.phone ? <a className="text-brand hover:underline" href={`tel:${row.phone}`}>{row.phone}</a> : "—"}</dd>
          </div>
        </dl>
      </section>

      <section className="mt-5">
        <h3 className={label}>Payment</h3>
        <dl className="mt-1.5 space-y-1.5">
          <div>
            <dt className={dt}>Status</dt>
            <dd className={dd}>{statusLabel}</dd>
          </div>
          {m && (
            <div>
              <dt className={dt}>How they pay</dt>
              <dd className={dd}>{m.methodLabel} · {m.timing}</dd>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <dt className={dt}>Owes</dt>
              <dd className={`${dd} tabular-nums`}>{row.owes > 0 ? money(row.owes) : "—"}</dd>
            </div>
            <div>
              <dt className={dt}>Paid</dt>
              <dd className={`${dd} tabular-nums`}>{row.paid > 0 ? money(row.paid) : "—"}</dd>
            </div>
          </div>
          {(detail?.discountLabel || detail?.discountCode) && (
            <div>
              <dt className={dt}>Discount</dt>
              <dd className={dd}>{detail.discountLabel ?? detail.discountCode}</dd>
            </div>
          )}
          {detail?.confirmationCode && (
            <div>
              <dt className={dt}>Confirmation code</dt>
              <dd className={dd}>{detail.confirmationCode}</dd>
            </div>
          )}
        </dl>
      </section>

      <section className="mt-5">
        <h3 className={label}>Form answers</h3>
        {!row.registrationId ? (
          <p className="mt-1.5 text-[13px] text-text-muted">Booked as a member without filling in the signup form.</p>
        ) : columns.length === 0 ? (
          <p className="mt-1.5 text-[13px] text-text-muted">This event&apos;s signup form has no questions.</p>
        ) : (
          <dl className="mt-1.5 space-y-2.5">
            {columns.map((c) => {
              const v = answerCell(source, c, registrationForm);
              return (
                <div key={c.id}>
                  <dt className={dt}>{c.label}{c.removedQuestion ? " (question since removed)" : ""}</dt>
                  <dd className={`${dd} whitespace-pre-wrap`}>{v || <span className="text-text-muted">No answer</span>}</dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>
    </Sheet>
  );
}
