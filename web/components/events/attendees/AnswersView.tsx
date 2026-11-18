"use client";

// "Form answers": everyone's answers to the signup form in one place, one row
// per registrant and one column per question, so a question such as "Are you
// willing to go up a weight?" can be read down a single column. The table is
// lib/eventFormAnswers.answersTable over the same ledger the list shows; the
// CSV button downloads that same table from the export route.

import { Download } from "lucide-react";
import type { AttendeeRow } from "@/lib/eventAttendees";
import { attendeeStatusText } from "@/lib/eventAttendeeExtras";
import { answersTable, type AnswerSource } from "@/lib/eventFormAnswers";

export default function AnswersView({
  eventId,
  rows,
  answers,
  registrationForm,
  onOpen,
}: {
  eventId: string;
  rows: AttendeeRow[];
  answers: Record<string, AnswerSource>;
  registrationForm: unknown;
  onOpen: (r: AttendeeRow) => void;
}) {
  const live = rows.filter((r) => !r.removed && r.registrationId);
  const t = answersTable(rows, (id) => answers[id] ?? null, registrationForm, { statusText: (r) => attendeeStatusText(r) });
  const bookedOnly = rows.filter((r) => !r.removed && !r.registrationId).length;

  return (
    <div className="px-4 sm:px-5 py-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[12.5px] text-text-muted">
          {live.length} {live.length === 1 ? "registration" : "registrations"} · {t.columns.length} {t.columns.length === 1 ? "question" : "questions"}
          {bookedOnly > 0 ? ` · ${bookedOnly} booked without the form` : ""}
        </p>
        <a
          href={`/api/events/${eventId}/attendees/export?view=answers`}
          download
          className="min-h-11 px-3 rounded-[10px] text-[13.5px] font-semibold border border-app-border text-text-primary inline-flex items-center gap-1.5 hover:bg-app-bg"
        >
          <Download size={16} strokeWidth={2} /> Download CSV
        </a>
      </div>

      {t.columns.length === 0 ? (
        <div className="p-10 text-center text-[14px] text-text-muted">This event&apos;s signup form has no questions.</div>
      ) : live.length === 0 ? (
        <div className="p-10 text-center text-[14px] text-text-muted">Nobody has filled in the form yet.</div>
      ) : (
        <div className="mt-3 rounded-[12px] border border-app-border overflow-x-auto">
          <table className="min-w-full text-[13.5px] border-collapse">
            <thead>
              <tr className="bg-table-chrome text-left">
                <th scope="col" className="sticky left-0 bg-table-chrome px-3 py-2 text-[12px] font-semibold uppercase tracking-[.05em] text-text-muted whitespace-nowrap">Name</th>
                {t.columns.map((c) => (
                  <th key={c.id} scope="col" className="px-3 py-2 text-[12px] font-semibold text-text-muted min-w-[140px] max-w-[260px] align-bottom">
                    {c.label}{c.removedQuestion ? " (removed)" : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {live.map((r, i) => (
                <tr key={r.id}>
                  <th scope="row" className="sticky left-0 bg-surface px-3 py-1 text-left font-semibold whitespace-nowrap">
                    <button type="button" className="min-h-11 text-brand hover:underline text-left" onClick={() => onOpen(r)}>{r.name}</button>
                  </th>
                  {t.columns.map((c, j) => {
                    const v = String(t.rows[i][4 + j] ?? "");
                    return <td key={c.id} className="px-3 py-2 text-text-primary align-top max-w-[260px] break-words">{v || <span className="text-text-muted">—</span>}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
