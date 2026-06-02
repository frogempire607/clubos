"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useSession } from "next-auth/react";

type GroupMsg = {
  id: string;
  body: string;
  createdAt: string;
  readCount?: number;
  readByMe?: boolean;
  senderId: string;
  sender: { id: string; firstName: string; lastName: string };
};

type Group = {
  id: string;
  name: string;
  type: "GROUP" | "BROADCAST";
  members: { user: { id: string; firstName: string; lastName: string; role: string } }[];
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

export default function MemberGroupThreadPage() {
  return (
    <Suspense fallback={<div className="text-center py-8 text-stone-400 text-sm">Loading…</div>}>
      <MemberGroupThreadInner />
    </Suspense>
  );
}

function MemberGroupThreadInner() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  // `forName` is plumbed from the messages list when this group thread
  // belongs to a linked child. Used purely for the header pill so a
  // parent never loses context about which kid the conversation is for.
  const forName = searchParams.get("forName");
  const { data: session } = useSession();
  const myId = session?.user?.id;

  const [group, setGroup] = useState<Group | null>(null);
  const [messages, setMessages] = useState<GroupMsg[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  async function load() {
    const res = await fetch(`/api/member/messages/groups/${id}`);
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      setError(d.error || "Could not load group");
      setLoading(false);
      return;
    }
    const d = await res.json();
    setGroup(d.group);
    setMessages(d.messages);
    setLoading(false);
    setTimeout(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }), 50);
  }

  useEffect(() => {
    if (id) load();
  }, [id]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setSending(true);
    setError("");
    const res = await fetch(`/api/member/messages/groups/${id}`, {
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
  if (!group && error) {
    return (
      <div className="bg-white rounded-xl border border-stone-200 p-8 text-center">
        <p className="text-sm text-red-600 mb-3">{error}</p>
        <Link href="/member/messages" className="text-sm text-stone-700 underline">Back to messages</Link>
      </div>
    );
  }
  if (!group) return null;

  const isBroadcast = group.type === "BROADCAST";
  const groups: { date: string; items: GroupMsg[] }[] = [];
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
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base font-semibold text-stone-900 truncate">{group.name}</h1>
            {isBroadcast && (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-600 font-medium">
                Read-only
              </span>
            )}
            {forName && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full bg-lime-100 text-lime-800 border border-lime-300">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                For {forName}
              </span>
            )}
          </div>
          <p className="text-xs text-stone-500">
            {group.members.length} members
            {forName && <span className="ml-1">· This group is about {forName}</span>}
          </p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-white rounded-xl border border-stone-200 p-4 space-y-3">
        {messages.length === 0 ? (
          <p className="text-sm text-stone-400 text-center py-6">No messages in this group yet.</p>
        ) : (
          groups.map((g) => (
            <div key={g.date} className="space-y-2">
              <div className="text-center text-[11px] text-stone-400 my-2">{g.date}</div>
              {g.items.map((m) => {
                const mine = m.senderId === myId;
                return (
                  <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                    <div className={`max-w-[80%] ${mine ? "" : ""}`}>
                      {!mine && (
                        <div className="text-[11px] text-stone-500 mb-0.5 ml-2">
                          {m.sender.firstName} {m.sender.lastName}
                        </div>
                      )}
                      <div
                        className={`rounded-2xl px-3 py-2 text-sm ${
                          mine
                            ? "bg-stone-900 text-white rounded-br-sm"
                            : "bg-stone-100 text-stone-900 rounded-bl-sm"
                        }`}
                      >
                        <div className="whitespace-pre-wrap">{m.body}</div>
                        <div className={`text-[10px] mt-0.5 ${mine ? "text-stone-400" : "text-stone-500"}`}>
                          {fmtTime(m.createdAt)}
                          {mine && typeof m.readCount === "number" ? ` · Read ${m.readCount}` : ""}
                        </div>
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

      {isBroadcast ? (
        <div className="text-xs text-stone-400 text-center mt-3 flex-shrink-0">
          This is a broadcast group. Replies are disabled.
        </div>
      ) : (
        <form onSubmit={send} className="flex gap-2 mt-3 flex-shrink-0">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Message the group…"
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
      )}
    </div>
  );
}
