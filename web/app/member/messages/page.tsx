"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Conversation = {
  user: { id: string; firstName: string; lastName: string; role: string };
  lastMessage: { id: string; body: string; createdAt: string; senderId: string; readAt: string | null };
  unread: number;
};

type Group = {
  id: string;
  name: string;
  type: string;
  messages: { id: string; body: string; createdAt: string; sender: { firstName: string; lastName: string } }[];
  _count: { members: number };
};

function relTime(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function MemberMessagesPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/member/messages")
      .then(async (r) => {
        if (!r.ok) {
          const d = await r.json().catch(() => ({}));
          setError(d.error || "Could not load messages");
          return null;
        }
        return r.json();
      })
      .then((d) => {
        if (d) {
          setConversations(d.conversations || []);
          setGroups(d.groups || []);
        }
        setLoading(false);
      });
  }, []);

  const isEmpty = !loading && conversations.length === 0 && groups.length === 0;

  return (
    <>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-stone-900 mb-1">Messages</h1>
        <p className="text-sm text-stone-500">Conversations with your club.</p>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : isEmpty ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <p className="text-3xl mb-2 text-stone-200">✉</p>
          <p className="text-base font-medium text-stone-900 mb-1">No messages yet</p>
          <p className="text-sm text-stone-500">When your club sends you a message, it'll show up here.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {groups.length > 0 && (
            <div>
              <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">Groups</h2>
              <div className="space-y-2">
                {groups.map((g) => {
                  const last = g.messages[0];
                  return (
                    <Link
                      key={g.id}
                      href={`/member/messages/group/${g.id}`}
                      className="block bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
                    >
                      <div className="flex items-start justify-between gap-3 mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          <h3 className="text-sm font-semibold text-stone-900 truncate">{g.name}</h3>
                          {g.type === "BROADCAST" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-stone-100 text-stone-600 font-medium flex-shrink-0">
                              Read-only
                            </span>
                          )}
                        </div>
                        {last && (
                          <span className="text-[11px] text-stone-400 flex-shrink-0">{relTime(last.createdAt)}</span>
                        )}
                      </div>
                      {last ? (
                        <p className="text-sm text-stone-600 line-clamp-1">
                          <span className="font-medium text-stone-700">{last.sender.firstName}:</span> {last.body}
                        </p>
                      ) : (
                        <p className="text-xs text-stone-400">No messages yet · {g._count.members} members</p>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          )}

          {conversations.length > 0 && (
            <div>
              <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium mb-2">Direct messages</h2>
              <div className="space-y-2">
                {conversations.map((c) => (
                  <Link
                    key={c.user.id}
                    href={`/member/messages/dm/${c.user.id}`}
                    className="block bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
                  >
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-8 h-8 rounded-full bg-stone-200 flex items-center justify-center text-xs font-bold text-stone-700 flex-shrink-0">
                          {c.user.firstName[0]}{c.user.lastName[0]}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-stone-900 truncate">
                            {c.user.firstName} {c.user.lastName}
                          </p>
                          <p className="text-[11px] text-stone-400">
                            {c.user.role === "OWNER" ? "Owner" : c.user.role === "STAFF" ? "Staff" : "Member"}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {c.unread > 0 && (
                          <span className="text-[10px] bg-stone-900 text-white px-1.5 py-0.5 rounded-full font-semibold">
                            {c.unread}
                          </span>
                        )}
                        <span className="text-[11px] text-stone-400">{relTime(c.lastMessage.createdAt)}</span>
                      </div>
                    </div>
                    <p className="text-sm text-stone-600 line-clamp-1">{c.lastMessage.body}</p>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
