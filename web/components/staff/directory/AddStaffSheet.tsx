"use client";

// B21 — Add staff: a quick dialog (bottom sheet on phones). Access, pay,
// schedule and lessons are set on the new person's profile afterwards.
// Uses the existing invite flow exactly: POST /api/staff with sendSetupLink.
import { useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import { CheckCircle2 } from "lucide-react";
import Sheet from "@/components/Sheet";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Created = { id: string; firstName: string; email: string; emailed: boolean; setupUrl: string | null };

function errorText(raw: unknown, fallback: string): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((x) => {
        if (typeof x === "string") return x;
        const i = x as { message?: string; path?: unknown[] };
        return i?.path?.length ? `${String(i.path[0])}: ${i.message}` : i?.message;
      })
      .filter(Boolean);
    if (parts.length) return parts.join(", ");
  }
  return fallback;
}

const inputCls =
  "w-full min-h-[44px] rounded-lg border border-app-border bg-surface px-3 text-[14px] text-text-primary focus:outline-none focus:ring-2 focus:ring-brand md:min-h-[38px]";
const btn = "inline-flex min-h-[44px] items-center justify-center rounded-lg px-4 text-[13.5px] font-medium md:min-h-[36px]";

const ROLES = [
  { v: "STAFF" as const, label: "Staff", desc: "Access you choose, area by area." },
  { v: "OWNER" as const, label: "Owner", desc: "Full access to everything." },
];

export default function AddStaffSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful invite so the directory can reload. */
  onAdded: () => void;
}) {
  const { data: session } = useSession();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [title, setTitle] = useState("");
  const [role, setRole] = useState<"STAFF" | "OWNER">("STAFF");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  function reset() {
    setFirstName("");
    setLastName("");
    setEmail("");
    setTitle("");
    setRole("STAFF");
    setError(null);
    setCreated(null);
    setCopied(false);
  }
  useEffect(() => {
    if (open) reset();
  }, [open]);

  const emailValid = EMAIL_RE.test(email.trim());
  const canSend = firstName.trim().length > 0 && emailValid && !saving;

  async function send() {
    if (!canSend) return;
    if (!lastName.trim()) {
      setError("Add a last name too — every staff account needs one.");
      return;
    }
    setSaving(true);
    setError(null);
    const res = await fetch("/api/staff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        sendSetupLink: true,
        title: title.trim(),
        accountRole: role,
      }),
    });
    const d = await res.json().catch(() => ({}));
    setSaving(false);
    if (!res.ok) {
      setError(errorText(d?.error, "Couldn't add this person. Please try again."));
      return;
    }
    setCreated({
      id: d.id,
      firstName: d.firstName ?? firstName.trim(),
      email: d.email ?? email.trim().toLowerCase(),
      emailed: !!d.emailed,
      setupUrl: d.setupUrl ?? null,
    });
    onAdded();
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const me = session?.user?.name || "you";

  if (created) {
    const first = created.firstName;
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={created.emailed ? `Invite sent to ${first}` : `${first} is added — the email didn't send`}
        footer={
          <>
            <button type="button" onClick={reset} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
              Add another
            </button>
            <Link href={`/dashboard/staff/${created.id}`} className={`${btn} bg-brand text-white hover:bg-brand-hover`}>
              Open {first}&apos;s profile
            </Link>
          </>
        }
      >
        <div className="space-y-3">
          <div className="flex items-start gap-2.5">
            <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--color-success-icon)" }} aria-hidden />
            <p className="text-[13.5px] text-text-primary">
              {created.emailed ? (
                <>
                  Sent to <strong className="font-semibold">{created.email}</strong>. {first} shows as Invited until they set a
                  password. Next, set their access, pay and schedule on their profile.
                </>
              ) : (
                <>
                  We couldn&apos;t email <strong className="font-semibold">{created.email}</strong>. Copy the setup link below and
                  send it to {first} yourself. It works for 14 days.
                </>
              )}
            </p>
          </div>
          {created.setupUrl && !created.emailed && (
            <div className="space-y-2">
              <div className="break-all rounded-lg border border-app-border bg-app-bg p-3 font-mono text-[12.5px] text-text-primary">
                {created.setupUrl}
              </div>
              <button type="button" onClick={() => copy(created.setupUrl!)} className={`${btn} w-full border border-app-border text-text-primary hover:bg-app-bg sm:w-auto`}>
                {copied ? "Copied" : "Copy link"}
              </button>
            </div>
          )}
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add staff"
      description="They get an email to set their own password. Access, pay, schedule and lessons are set on their profile next."
      footer={
        <div className="flex w-full flex-col-reverse gap-2 sm:flex-row sm:items-center">
          <span className="text-[12px] text-text-muted sm:mr-auto">Recorded under {me}</span>
          <button type="button" onClick={onClose} className={`${btn} border border-app-border text-text-primary hover:bg-app-bg`}>
            Cancel
          </button>
          <button type="button" onClick={send} disabled={!canSend} className={`${btn} bg-brand text-white hover:bg-brand-hover disabled:opacity-50`}>
            {saving ? "Sending…" : "Send invite"}
          </button>
        </div>
      }
    >
      <form
        className="space-y-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">First name</span>
            <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="off" />
          </label>
          <label className="block">
            <span className="mb-1 block text-[13px] font-medium text-text-primary">Last name</span>
            <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} autoComplete="off" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-text-primary">Login email</span>
          <input type="email" inputMode="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
          <span className="mt-1 block text-[12px] text-text-muted">The email they&apos;ll sign in with. The invite goes here.</span>
          {email.trim() !== "" && !emailValid && (
            <span className="mt-0.5 block text-[12px]" style={{ color: "var(--color-danger-text)" }}>Enter a valid email address.</span>
          )}
        </label>
        <label className="block">
          <span className="mb-1 block text-[13px] font-medium text-text-primary">Title</span>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Head Coach, Assistant Coach, Front Desk…" />
        </label>

        <fieldset>
          <legend className="mb-1.5 block text-[13px] font-medium text-text-primary">Role</legend>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="radiogroup">
            {ROLES.map((r) => {
              const on = role === r.v;
              return (
                <button
                  key={r.v}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setRole(r.v)}
                  className={`min-h-[44px] rounded-lg border px-3 py-2.5 text-left transition-colors motion-reduce:transition-none ${
                    on ? "border-brand bg-brand/10" : "border-app-border hover:bg-app-bg"
                  }`}
                >
                  <span className={`block text-[13.5px] font-semibold ${on ? "text-brand" : "text-text-primary"}`}>{r.label}</span>
                  <span className="block text-[12px] text-text-muted">{r.desc}</span>
                </button>
              );
            })}
          </div>
          {role === "OWNER" && (
            <p
              className="mt-2 rounded-lg px-3 py-2 text-[12.5px]"
              style={{ background: "var(--color-warn-surface)", color: "var(--color-warn-text)", border: "1px solid var(--color-warn-border)" }}
            >
              Owners see and change everything and can&apos;t be limited.
            </p>
          )}
        </fieldset>

        {error && (
          <div role="alert" className="rounded-lg px-3 py-2 text-[13px]" style={{ background: "var(--color-danger-surface)", color: "var(--color-danger-text)" }}>
            {error}
          </div>
        )}
      </form>
    </Sheet>
  );
}
