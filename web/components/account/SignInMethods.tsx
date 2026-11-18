"use client";

import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/lib/dialogs";
import { startSocial } from "@/lib/socialClient";
import { socialErrorText } from "@/lib/socialErrors";
import { memberErrorText } from "@/lib/memberErrorText";
import type { SocialProvider } from "@/lib/socialAuth";
import { AppleMark, GoogleMark, socialButtonClass } from "@/components/auth/SocialButtons";

// My account → Sign-in methods. Every way into this account: the password
// (when there is one) and each connected Google / Apple sign-in. Any of them
// can be removed except the last one. Staff and owners connect Google or
// Apple here, after signing in with their password: their logins are never
// connected by an email match (lib/socialAuth decideSocialSignIn).

type Method = { id: string; provider: "GOOGLE" | "APPLE"; label: string; email: string | null; hiddenEmail: boolean; removable: boolean };
type Payload = { hasPassword: boolean; accountEmail: string; clubSlug: string; methods: Method[]; connectable: SocialProvider[] };

export default function SignInMethods({ variant = "dashboard" }: { variant?: "dashboard" | "member" }) {
  const [data, setData] = useState<Payload | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/account/sign-in-methods", { cache: "no-store" });
      if (r.ok) setData((await r.json()) as Payload);
    } catch {
      /* the card just doesn't show */
    }
  }, []);

  useEffect(() => {
    void load();
    // Back from connecting on the website: ?connected=google / ?social_error=…
    const sp = new URLSearchParams(window.location.search);
    const c = sp.get("connected");
    const e = sp.get("social_error");
    if (c === "google" || c === "apple") setMsg({ ok: true, text: `${c === "google" ? "Google" : "Apple"} is connected. You can use it to sign in.` });
    else if (e) setMsg({ ok: false, text: socialErrorText(e) });
  }, [load]);

  const card = variant === "member" ? "pcard p-5" : "bg-surface border border-app-border rounded-xl p-5";
  const muted = variant === "member" ? "text-stone-500" : "text-text-muted";
  const strong = variant === "member" ? "text-stone-900" : "text-text-primary";

  if (!data) return null;
  if (data.methods.length === 0 && data.connectable.length === 0) return null;

  async function remove(m: Method) {
    if (!(await confirmDialog(`Remove ${m.label} from this account? You won't be able to sign in with it until you connect it again.`))) return;
    setBusy(m.id);
    setMsg(null);
    const r = await fetch(`/api/account/sign-in-methods?id=${encodeURIComponent(m.id)}`, { method: "DELETE" });
    const d = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) return setMsg({ ok: false, text: memberErrorText(d, "Could not remove it.") });
    setMsg({ ok: true, text: `${m.label} removed.` });
    void load();
  }

  async function connect(p: SocialProvider) {
    setBusy(p);
    setMsg(null);
    const r = await startSocial({
      provider: p,
      mode: "connect",
      onDone: (res) => {
        setBusy(null);
        if (res.connected) {
          setMsg({ ok: true, text: `${p === "google" ? "Google" : "Apple"} is connected. You can use it to sign in.` });
          void load();
        } else if (res.error) setMsg({ ok: false, text: res.error });
      },
    });
    if (!r.ok) {
      setBusy(null);
      setMsg({ ok: false, text: r.error });
    }
  }

  async function sendPasswordLink() {
    if (!data?.clubSlug) return;
    setBusy("password");
    const r = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: data?.accountEmail, clubSlug: data?.clubSlug }),
    }).catch(() => null);
    setBusy(null);
    setMsg(
      r?.ok
        ? { ok: true, text: `We emailed a link to ${data?.accountEmail}. Open it to choose a password.` }
        : { ok: false, text: "Could not send the link. Try again in a moment." },
    );
  }

  return (
    <section className={card} aria-labelledby="sign-in-methods">
      <h2 id="sign-in-methods" className={`text-sm font-semibold ${strong} mb-1`}>Sign-in methods</h2>
      <p className={`text-xs ${muted} mb-3`}>The ways you can sign in to this account. One must always remain.</p>
      <ul className="divide-y divide-app-border border border-app-border rounded-lg">
        <li className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
          <div className="min-w-0">
            <div className={`font-medium ${strong}`}>Email and password</div>
            <div className={`text-xs ${muted} truncate`}>{data.hasPassword ? data.accountEmail : "No password set"}</div>
          </div>
          {!data.hasPassword && (
            <button type="button" disabled={busy !== null} onClick={sendPasswordLink} className="min-h-11 text-sm font-medium text-brand hover:underline disabled:opacity-50">
              {busy === "password" ? "Sending…" : "Add a password"}
            </button>
          )}
        </li>
        {data.methods.map((m) => (
          <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm">
            <div className="min-w-0 flex items-center gap-2.5">
              {m.provider === "APPLE" ? <AppleMark /> : <GoogleMark />}
              <div className="min-w-0">
                <div className={`font-medium ${strong}`}>{m.label}</div>
                <div className={`text-xs ${muted} truncate`}>{m.hiddenEmail ? "Email hidden by Apple" : m.email ?? ""}</div>
              </div>
            </div>
            {m.removable ? (
              <button type="button" disabled={busy !== null} onClick={() => remove(m)} className="min-h-11 text-sm text-red-600 hover:underline disabled:opacity-50">
                {busy === m.id ? "Removing…" : "Remove"}
              </button>
            ) : (
              <span className={`text-xs ${muted}`}>Your only way in</span>
            )}
          </li>
        ))}
      </ul>
      {data.connectable.length > 0 && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {data.connectable.map((p) => (
            <button key={p} type="button" disabled={busy !== null} onClick={() => connect(p)} className={socialButtonClass(p)}>
              {p === "apple" ? <AppleMark /> : <GoogleMark />}
              {busy === p ? "Opening…" : `Connect ${p === "apple" ? "Apple" : "Google"}`}
            </button>
          ))}
        </div>
      )}
      {msg && (
        <p className={`mt-3 text-sm rounded-lg px-3 py-2 ${msg.ok ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {msg.text}
        </p>
      )}
    </section>
  );
}
