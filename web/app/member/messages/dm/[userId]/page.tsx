"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";

type Msg = {
  id: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  senderId: string;
  sender: { id: string; firstName: string; lastName: string };
};

type Other = { id: string; firstName: string; lastName: string; role: string };

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function MemberDmThreadPage() {
  const { userId } = useParams<{ userId: string }>();
  const { data: session } = useSession();
  const myId = session?.user?.id;

  const [other, setOther] = useState<Other | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  async function load() {
    const res = await fetch(`/api/member/messages/dm/${userId}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Could not load thread");
      setLoading(false);
      return;
    }
    const d = await res.json();
    setOther(d.other);
    setMessages(d.messages);
    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 50);
  }

  useEffect(() => {
    if (userId) load();
  }, [userId]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setError("");
    const res = await fetch(`/api/member/messages/dm/${userId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft.trim() }),
    });
    setSending(false);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Failed to send");
      return;
    }
    setDraft("");
    load();
  }

  if (loading) return <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>;
  if (!other && error) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
        <p className="text-sm text-red-600 mb-3">{error}</p>
        <Link href="/member/messages" className="text-sm text-stone-700 underline">Back to messages</Link>
      </div>
    );
  }
  if (!other) return null;

  // Group messages by date for separators
  const groups: { date: string; items: Msg[] }[] = [];
  for (const m of messages) {
    const d = fmtDate(m.createdAt);
    const last = groups[groups.length - 1];
    if (!last || last.date !== d) groups.push({ date: d, items: [m] });
    else last.items.push(m);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)] md:h-[calc(100vh-9rem)]">
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <Link href="/member/messages" className="text-stone-500 hover:text-stone-900 text-lg leading-none">‹</Link>
        <div className="w-9 h-9 rounded-full bg-stone-200 flex items-center justify-center text-sm font-bold text-stone-700">
          {other.firstName[0]}{other.lastName[0]}
        </div>
        <div>
          <h1 className="text-base font-semibold text-stone-900">{other.firstName} {other.lastName}</h1>
          <p className="text-xs text-stone-500">{other.role === "OWNER" ? "Owner" : other.role === "STAFF" ? "Staff" : "Member"}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-white rounded-xl border border-stone-200 p-4 space-y-3">
        {messages.length === 0 ? (
          <p className="text-sm text-stone-400 text-center py-6">No messages yet — say hello.</p>
        ) : (
          groups.map((g) => (
            <div key={g.date} className="space-y-2">
              <div className="text-center text-[11px] text-stone-400 my-2">{g.date}</div>
              {g.items.map((m) => {
                const mine = m.senderId === myId;
                return (
                  <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm ${
                        mine ? "bg-stone-900 text-white rounded-br-sm" : "bg-stone-100 text-stone-900 rounded-bl-sm"
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{m.body}</div>
                      <div className={`text-[10px] mt-0.5 ${mine ? "text-stone-300" : "text-stone-500"}`}>
                        {fmtTime(m.createdAt)}
                        {mine
                          ? ` · ${
                              m.readAt
                                ? `Read ${new Date(m.readAt).toLocaleString("en-US", {
                                    month: "short",
                                    day: "numeric",
                                    hour: "numeric",
                                    minute: "2-digit",
                                  })}`
                                : "Sent"
                            }`
                          : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2 mt-2">{error}</div>
      )}

      <form onSubmit={send} className="flex gap-2 mt-3 flex-shrink-0">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
        />
        <button
          type="submit"
          disabled={sending || !draft.trim()}
          className="px-4 py-2 bg-stone-900 text-white rounded-lg text-sm font-medium hover:bg-stone-700 disabled:opacity-50"
        >
          {sending ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}
