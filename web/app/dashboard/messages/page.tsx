"use client";

import { useEffect, useRef, useState } from "react";
import { useSession } from "next-auth/react";
import { MessageSquare } from "lucide-react";

type GroupMessage = {
  id: string;
  body: string;
  createdAt: string;
  sender: { id: string; firstName: string; lastName: string };
  readCount?: number;
  readByMe?: boolean;
  readers?: { userId: string; firstName: string; lastName: string; readAt: string }[];
};

type MessageGroup = {
  id: string;
  name: string;
  type: string;
  filterType: string | null;
  filterValue: string | null;
  members: { user: { id: string; firstName: string; lastName: string; role: string } }[];
  messages: GroupMessage[];
  createdAt: string;
};

type ClubMember = {
  id: string;
  userId?: string | null;
  firstName: string;
  lastName: string;
  email?: string | null;
  phone?: string | null;
  tags: string | null;
  status: string;
  isMinor?: boolean;
  guardianName?: string | null;
  guardianEmail?: string | null;
  membership: { name: string } | null;
};

type AudienceMember = {
  id: string;
  userId?: string | null;
  firstName: string;
  lastName: string;
  email?: string | null;
  tags: string | null;
  status: string;
  isMinor?: boolean;
  membership: { name: string } | null;
  membershipNames: string[];
};

type DMUser = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
};

type DMMessage = {
  id: string;
  body: string;
  createdAt: string;
  readAt?: string | null;
  sender: { id: string; firstName: string; lastName: string };
};

type Conversation = {
  user: DMUser;
  lastMessage: { body: string; createdAt: string };
  unread: number;
};

export default function MessagesPage() {
  const [tab, setTab] = useState<"groups" | "dms">("groups");

  return (
    <div className="p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-3xl font-semibold text-text-primary mb-1">Messages</h1>
        <p className="text-sm text-text-muted">Group chats and direct messages. Posting to the whole club? Use <a href="/dashboard/announcements" className="text-brand hover:underline font-medium">Announcements</a>.</p>
      </div>

      <div className="flex gap-1 bg-app-bg rounded-lg p-1 mb-6 w-fit">
        {(["groups", "dms"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`text-sm px-4 py-1.5 rounded-md transition ${
              tab === t ? "bg-white shadow-sm text-text-primary font-medium" : "text-text-muted"
            }`}
          >
            {t === "groups" ? "Group Messages" : "Direct Messages"}
          </button>
        ))}
      </div>

      {tab === "groups" && <GroupsTab />}
      {tab === "dms" && <DMsTab />}
    </div>
  );
}

/* ─── Group Messages ─── */

function GroupsTab() {
  const { data: session } = useSession();
  const [groups, setGroups] = useState<MessageGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<MessageGroup | null>(null);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  // Per-message "Read N" expand toggle so coaches can see which member read
  // the broadcast and when.
  const [expandedReadersId, setExpandedReadersId] = useState<string | null>(null);
  const [msgBody, setMsgBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function loadGroups() {
    const res = await fetch("/api/messages/groups");
    if (res.ok) setGroups(await res.json());
    setLoading(false);
  }

  async function loadMessages(groupId: string) {
    const res = await fetch(`/api/messages/groups/${groupId}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(data.messages || []);
    }
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  useEffect(() => { loadGroups(); }, []);

  useEffect(() => {
    if (activeGroup) loadMessages(activeGroup.id);
  }, [activeGroup]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!activeGroup || !msgBody.trim()) return;
    setSending(true);
    const res = await fetch(`/api/messages/groups/${activeGroup.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: msgBody.trim() }),
    });
    setSending(false);
    if (res.ok) {
      setMsgBody("");
      loadMessages(activeGroup.id);
    }
  }

  async function deleteGroup(id: string) {
    if (!confirm("Delete this group and all its messages?")) return;
    await fetch(`/api/messages/groups/${id}`, { method: "DELETE" });
    setActiveGroup(null);
    setMessages([]);
    loadGroups();
  }

  return (
    <>
      <div className="flex justify-end mb-4">
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover"
        >
          + New group
        </button>
      </div>

      {loading ? (
        <div className="p-8 text-center text-text-muted text-sm">Loading…</div>
      ) : groups.length === 0 ? (
        <div className="bg-white rounded-xl border border-app-border p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <MessageSquare className="h-7 w-7" strokeWidth={2} />
          </div>
          <h3 className="text-lg font-medium text-text-primary mb-1">No groups yet</h3>
          <p className="text-sm text-text-muted mb-4">Create a group to message a specific team, class, or set of members.</p>
          <button onClick={() => setShowCreate(true)}
            className="px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover">
            Create first group
          </button>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-app-border overflow-hidden" style={{ height: 560 }}>
          <div className="flex h-full">
            {/* Group list */}
            <div className="w-64 border-r border-app-border flex flex-col flex-shrink-0">
              <div className="px-4 py-3 border-b border-app-border">
                <span className="text-sm font-semibold text-text-primary">Groups ({groups.length})</span>
              </div>
              <div className="flex-1 overflow-y-auto">
                {groups.map((g) => {
                  const lastMsg = g.messages?.[0];
                  const isBroadcast = g.type === "BROADCAST";
                  return (
                    <button
                      key={g.id}
                      onClick={() => setActiveGroup(g)}
                      className={`w-full text-left px-4 py-3 border-b border-app-border hover:bg-app-bg ${activeGroup?.id === g.id ? "bg-app-bg" : ""}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-medium flex-shrink-0 ${isBroadcast ? "bg-orange-accent text-orange-accent" : "bg-app-border text-text-primary"}`}>
                          {isBroadcast ? "📢" : g.name[0]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <span className="text-xs font-medium text-text-primary truncate">{g.name}</span>
                            {isBroadcast && (
                              <span className="text-[9px] px-1 py-0.5 rounded bg-orange-accent/10 text-orange-accent font-medium flex-shrink-0">Broadcast</span>
                            )}
                          </div>
                          <p className="text-[10px] text-text-muted">
                            {g.members.length} member{g.members.length !== 1 ? "s" : ""}
                          </p>
                          {lastMsg && (
                            <p className="text-[10px] text-text-muted truncate mt-0.5">{lastMsg.body}</p>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Thread */}
            <div className="flex-1 flex flex-col min-w-0">
              {!activeGroup ? (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <MessageSquare className="h-7 w-7 text-text-muted mx-auto mb-2" strokeWidth={2} />
                    <p className="text-sm text-text-muted">Select a group to view messages</p>
                  </div>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">{activeGroup.name}</span>
                        {activeGroup.type === "BROADCAST" && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-orange-accent/10 text-orange-accent font-medium">Broadcast</span>
                        )}
                      </div>
                      <p className="text-xs text-text-muted">
                        {activeGroup.members.map((m) => `${m.user.firstName} ${m.user.lastName}`).join(", ")}
                      </p>
                    </div>
                    <button
                      onClick={() => deleteGroup(activeGroup.id)}
                      className="text-xs text-red-600 hover:bg-red-50 px-2 py-1 rounded"
                    >
                      Delete
                    </button>
                  </div>

                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {messages.length === 0 ? (
                      <div className="text-center text-sm text-text-muted pt-8">No messages yet. Say something!</div>
                    ) : (
                      messages.map((m) => {
                        const mine = m.sender.id === session?.user?.id;
                        return (
                          <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                            {!mine && (
                              <div className="w-6 h-6 rounded-full bg-app-border flex items-center justify-center text-[10px] font-medium text-text-primary mr-2 flex-shrink-0 mt-1">
                                {m.sender.firstName[0]}
                              </div>
                            )}
                            <div className={`max-w-[70%] ${mine ? "" : ""}`}>
                              {!mine && (
                                <p className="text-[10px] text-text-muted mb-0.5">{m.sender.firstName} {m.sender.lastName}</p>
                              )}
                              <div className={`px-3 py-2 rounded-xl text-sm ${mine ? "bg-brand text-white" : "bg-app-bg text-text-primary"}`}>
                                <p>{m.body}</p>
                                <p className={`text-[10px] mt-1 ${mine ? "text-white/75" : "text-text-muted"}`}>
                                  {new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                                  {mine && typeof m.readCount === "number" && m.readCount > 0 ? (
                                    <>
                                      {" · "}
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setExpandedReadersId(
                                            expandedReadersId === m.id ? null : m.id,
                                          )
                                        }
                                        className={`underline ${mine ? "text-white/80 hover:text-white" : "hover:text-text-primary"}`}
                                      >
                                        Read {m.readCount}
                                      </button>
                                    </>
                                  ) : mine && typeof m.readCount === "number" ? (
                                    " · Sent"
                                  ) : null}
                                </p>
                                {mine && expandedReadersId === m.id && m.readers && m.readers.length > 0 && (
                                  <ul className={`mt-1 text-[10px] space-y-0.5 ${mine ? "text-white/80" : "text-text-muted"}`}>
                                    {m.readers.map((r) => (
                                      <li key={r.userId}>
                                        {r.firstName} {r.lastName} ·{" "}
                                        {new Date(r.readAt).toLocaleString("en-US", {
                                          month: "short",
                                          day: "numeric",
                                          hour: "numeric",
                                          minute: "2-digit",
                                        })}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={bottomRef} />
                  </div>

                  <form onSubmit={sendMessage} className="p-3 border-t border-app-border flex gap-2">
                    <input
                      type="text"
                      value={msgBody}
                      onChange={(e) => setMsgBody(e.target.value)}
                      placeholder="Type a message…"
                      className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                    />
                    <button type="submit" disabled={sending || !msgBody.trim()}
                      className="px-3 py-2 bg-brand text-white rounded-lg text-sm hover:bg-brand-hover disabled:opacity-50">
                      Send
                    </button>
                  </form>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showCreate && (
        <CreateGroupModal
          onClose={() => setShowCreate(false)}
          onSaved={() => { setShowCreate(false); loadGroups(); }}
        />
      )}
    </>
  );
}

function CreateGroupModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"GROUP" | "BROADCAST">("GROUP");
  const [filterMode, setFilterMode] = useState<"manual" | "tag" | "membership" | "class" | "status">("manual");
  const [filterValue, setFilterValue] = useState("");
  const [members, setMembers] = useState<AudienceMember[]>([]);
  const [staff, setStaff] = useState<{ id: string; firstName: string; lastName: string; role: string }[]>([]);
  const [classes, setClasses] = useState<{ id: string; name: string; memberIds: string[] }[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/messages/audience")
      .then((r) => (r.ok ? r.json() : { members: [], staff: [], classes: [] }))
      .then((d) => {
        setMembers(d.members ?? []);
        setStaff(d.staff ?? []);
        setClasses(d.classes ?? []);
      });
  }, []);

  const allUsers = [
    ...staff.map((s) => ({
      id: s.id,
      firstName: s.firstName,
      lastName: s.lastName,
      role: s.role,
      tags: null as string | null,
      status: "ACTIVE",
      membershipNames: [] as string[],
    })),
    ...members
      .filter((m) => m.status !== "INACTIVE")
      .map((m) => ({
        id: m.id,
        firstName: m.firstName,
        lastName: m.lastName,
        role: "MEMBER",
        tags: m.tags,
        status: m.status,
        membershipNames: m.membershipNames ?? [],
      })),
  ];

  const classRoster = classes.find((c) => c.id === filterValue);

  const filteredUsers = allUsers.filter((u) => {
    if (filterMode === "tag" && filterValue) {
      const tags = (u.tags || "").split(",").map((t) => t.trim().toLowerCase());
      return tags.includes(filterValue.toLowerCase());
    }
    if (filterMode === "status" && filterValue) {
      return u.status === filterValue;
    }
    if (filterMode === "membership" && filterValue) {
      return u.membershipNames.includes(filterValue);
    }
    if (filterMode === "class" && filterValue) {
      return !!classRoster && classRoster.memberIds.includes(u.id);
    }
    return true;
  });

  const allTags = Array.from(new Set(
    members.flatMap((m) => (m.tags || "").split(",").map((t) => t.trim()).filter(Boolean))
  ));
  const allMemberships = Array.from(new Set(
    members.flatMap((m) => m.membershipNames ?? [])
  )).sort();

  function toggleUser(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(filteredUsers.map((u) => u.id)));
  }

  function clearAll() {
    setSelectedIds(new Set());
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (selectedIds.size === 0) {
      setError("Select at least one member");
      return;
    }
    setSaving(true);
    setError("");
    const res = await fetch("/api/messages/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        type,
        memberUserIds: Array.from(selectedIds),
        filterType: filterMode !== "manual" ? filterMode : null,
        filterValue: filterMode !== "manual" ? filterValue : null,
      }),
    });
    setSaving(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Failed to create group");
      return;
    }
    onSaved();
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-white">
          <h2 className="text-lg font-semibold text-text-primary">Create group</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Group name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} required
              placeholder="Varsity Team, Morning Class, Parents…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand" />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Type</label>
            <div className="grid grid-cols-2 gap-2">
              {(["GROUP", "BROADCAST"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setType(t)}
                  className={`px-3 py-2 rounded-lg text-sm border text-left transition ${
                    type === t
                      ? "border-brand bg-app-bg font-medium text-text-primary"
                      : "border-app-border text-text-muted"
                  }`}
                >
                  <div className="font-medium">{t === "GROUP" ? "Group chat" : "Broadcast"}</div>
                  <div className="text-xs text-text-muted mt-0.5">
                    {t === "GROUP" ? "Everyone can reply" : "Owner sends, no replies"}
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="pt-2 border-t border-app-border">
            <p className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">Filter members</p>
            <div className="flex gap-2 flex-wrap mb-3">
              {([
                { val: "manual", label: "Select manually" },
                { val: "tag", label: "By tag" },
                { val: "membership", label: "By membership" },
                { val: "class", label: "By class" },
                { val: "status", label: "By status" },
              ] as const).map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => { setFilterMode(opt.val); setFilterValue(""); }}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${
                    filterMode === opt.val
                      ? "border-brand bg-brand text-white"
                      : "border-app-border text-text-muted hover:border-app-border"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {filterMode === "tag" && (
              <select value={filterValue} onChange={(e) => setFilterValue(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white mb-2 focus:outline-none">
                <option value="">All tags</option>
                {allTags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            )}
            {filterMode === "membership" && (
              <select value={filterValue} onChange={(e) => setFilterValue(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white mb-2 focus:outline-none">
                <option value="">All memberships</option>
                {allMemberships.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            )}
            {filterMode === "membership" && allMemberships.length === 0 && (
              <p className="text-xs text-text-muted mb-2">No members have a membership assigned yet.</p>
            )}
            {filterMode === "class" && (
              <select value={filterValue} onChange={(e) => setFilterValue(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white mb-2 focus:outline-none">
                <option value="">Select a class…</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            {filterMode === "class" && classes.length === 0 && (
              <p className="text-xs text-text-muted mb-2">No class attendance recorded yet — rosters build from check-ins.</p>
            )}
            {filterMode === "status" && (
              <select value={filterValue} onChange={(e) => setFilterValue(e.target.value)}
                className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white mb-2 focus:outline-none">
                <option value="">All statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="PROSPECT">Prospect</option>
                <option value="PAUSED">Paused</option>
              </select>
            )}

            {/* Member list */}
            <div className="border border-app-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-3 py-2 bg-app-bg border-b border-app-border">
                <span className="text-xs text-text-muted font-medium">
                  {filteredUsers.length} people · {selectedIds.size} selected
                </span>
                <div className="flex gap-2">
                  <button type="button" onClick={selectAll} className="text-[10px] text-text-muted hover:text-text-primary">Select all</button>
                  <button type="button" onClick={clearAll} className="text-[10px] text-text-muted hover:text-text-muted">Clear</button>
                </div>
              </div>
              <div className="max-h-48 overflow-y-auto">
                {filteredUsers.map((u) => (
                  <label key={u.id} className="flex items-center gap-2 px-3 py-2 hover:bg-app-bg cursor-pointer border-b border-app-border last:border-0">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(u.id)}
                      onChange={() => toggleUser(u.id)}
                      className="w-3.5 h-3.5 accent-stone-900 flex-shrink-0"
                    />
                    <span className="text-sm text-text-primary">{u.firstName} {u.lastName}</span>
                    <span className="text-xs text-text-muted">{u.role.charAt(0) + u.role.slice(1).toLowerCase()}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose}
              className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {saving ? "Creating…" : "Create group"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Direct Messages ─── */

function DMsTab() {
  const { data: session } = useSession();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeUser, setActiveUser] = useState<DMUser | null>(null);
  const [messages, setMessages] = useState<DMMessage[]>([]);
  const [msgBody, setMsgBody] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showCompose, setShowCompose] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  async function loadConversations() {
    const res = await fetch("/api/messages/dm");
    if (res.ok) setConversations(await res.json());
    setLoading(false);
  }

  async function loadMessages(userId: string) {
    const res = await fetch(`/api/messages/dm/${userId}`);
    if (res.ok) setMessages(await res.json());
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }

  useEffect(() => { loadConversations(); }, []);
  useEffect(() => { if (activeUser) loadMessages(activeUser.id); }, [activeUser]);

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault();
    if (!activeUser || !msgBody.trim()) return;
    setSending(true);
    setStatus(null);
    const res = await fetch(`/api/messages/dm/${activeUser.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: msgBody.trim() }),
    });
    setSending(false);
    if (res.ok) {
      setMsgBody("");
      setStatus({ type: "success", text: "Message sent." });
      loadMessages(activeUser.id);
      loadConversations();
    } else {
      const data = await res.json().catch(() => ({}));
      setStatus({ type: "error", text: data.error?.toString() || "Message failed to send." });
    }
  }

  return (
    <div className="bg-white rounded-xl border border-app-border overflow-hidden" style={{ height: 520 }}>
      <div className="flex h-full">
        {/* Sidebar */}
        <div className="w-64 border-r border-app-border flex flex-col flex-shrink-0">
          <div className="px-4 py-3 border-b border-app-border flex items-center justify-between">
            <span className="text-sm font-semibold text-text-primary">Direct Messages</span>
            <button
              onClick={() => setShowCompose(true)}
              className="text-xs px-2 py-1 rounded bg-brand text-white hover:bg-brand-hover"
            >
              + New
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="p-4 text-sm text-text-muted text-center">Loading…</div>
            ) : conversations.length === 0 ? (
              <div className="p-4 text-xs text-text-muted text-center">No conversations yet.</div>
            ) : (
              conversations.map((c) => (
                <button
                  key={c.user.id}
                  onClick={() => setActiveUser(c.user)}
                  className={`w-full text-left px-4 py-3 border-b border-app-border hover:bg-app-bg ${activeUser?.id === c.user.id ? "bg-app-bg" : ""}`}
                >
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary flex-shrink-0">
                      {c.user.firstName[0]}{c.user.lastName[0]}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text-primary">{c.user.firstName} {c.user.lastName}</span>
                        {c.unread > 0 && (
                          <span className="text-[10px] bg-brand text-white rounded-full w-4 h-4 flex items-center justify-center">{c.unread}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-text-muted truncate">{c.lastMessage.body}</p>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Thread */}
        <div className="flex-1 flex flex-col min-w-0">
          {!activeUser ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <MessageSquare className="h-7 w-7 text-text-muted mx-auto mb-2" strokeWidth={2} />
                <p className="text-sm text-text-muted">Select a conversation or start a new one</p>
              </div>
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-app-border flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-app-border flex items-center justify-center text-xs font-medium text-text-primary">
                  {activeUser.firstName[0]}{activeUser.lastName[0]}
                </div>
                <span className="text-sm font-semibold text-text-primary">{activeUser.firstName} {activeUser.lastName}</span>
                <span className="text-xs text-text-muted">{activeUser.role.charAt(0) + activeUser.role.slice(1).toLowerCase()}</span>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.map((m) => {
                  const mine = m.sender.id === session?.user?.id;
                  return (
                    <div key={m.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[70%] px-3 py-2 rounded-xl text-sm ${mine ? "bg-brand text-white" : "bg-app-bg text-text-primary"}`}>
                        <p>{m.body}</p>
                        {/* Timestamp + read/sent receipt. Use white/75 on the
                            violet bubble for legibility — text-text-muted on
                            purple is effectively invisible. */}
                        <p className={`text-[10px] mt-1 ${mine ? "text-white/75" : "text-text-muted"}`}>
                          {new Date(m.createdAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
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
                        </p>
                      </div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>

              <form onSubmit={sendMessage} className="p-3 border-t border-app-border flex gap-2">
                <input
                  type="text"
                  value={msgBody}
                  onChange={(e) => setMsgBody(e.target.value)}
                  placeholder="Type a message…"
                  className="flex-1 px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand"
                />
                <button type="submit" disabled={sending || !msgBody.trim()}
                  className="px-3 py-2 bg-brand text-white rounded-lg text-sm hover:bg-brand-hover disabled:opacity-50">
                  Send
                </button>
              </form>
              {status && (
                <div className={`px-3 pb-3 text-xs ${status.type === "success" ? "text-text-primary" : "text-red-600"}`}>
                  {status.text}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showCompose && (
        <DMComposeModal
          onClose={() => setShowCompose(false)}
          onSent={(user) => { setShowCompose(false); setActiveUser(user); loadConversations(); }}
        />
      )}
    </div>
  );
}

function DMComposeModal({
  onClose,
  onSent,
}: {
  onClose: () => void;
  onSent: (user: DMUser) => void;
}) {
  const [staffList, setStaffList] = useState<DMUser[]>([]);
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [targetType, setTargetType] = useState<"member" | "staff">("member");
  const [selected, setSelected] = useState("");
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  useEffect(() => {
    Promise.all([
      fetch("/api/staff?includeOwners=true").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/members").then((r) => (r.ok ? r.json() : [])),
    ]).then(([staff, memberRows]) => {
      setStaffList(staff);
      setMembers(memberRows.filter((m: ClubMember) => m.status !== "INACTIVE"));
    });
  }, []);

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!selected || !body.trim()) return;
    setSending(true);
    setError("");
    setSuccess("");
    const res = await fetch(targetType === "member" ? "/api/messages/dm" : `/api/messages/dm/${selected}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(targetType === "member" ? { memberId: selected, body: body.trim() } : { body: body.trim() }),
    });
    setSending(false);
    if (!res.ok) {
      const data = await res.json();
      setError(data.error?.toString() || "Failed to send");
      return;
    }
    setSuccess("Message sent.");
    if (targetType === "staff") {
      const user = staffList.find((u) => u.id === selected);
      if (user) onSent(user);
      return;
    }
    const member = members.find((m) => m.id === selected);
    if (member?.userId) {
      onSent({ id: member.userId, firstName: member.firstName, lastName: member.lastName, role: "MEMBER" });
    } else {
      setBody("");
      setSelected("");
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-xl w-full max-w-md">
        <div className="px-6 py-4 border-b border-app-border flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text-primary">New direct message</h2>
          <button onClick={onClose} className="text-text-muted hover:text-text-primary text-xl leading-none">×</button>
        </div>
        <form onSubmit={handleSend} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">To</label>
            <div className="grid grid-cols-2 gap-2 mb-2">
              {(["member", "staff"] as const).map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => { setTargetType(type); setSelected(""); setError(""); setSuccess(""); }}
                  className={`px-3 py-2 rounded-lg text-sm border ${targetType === type ? "border-brand bg-app-bg text-text-primary font-medium" : "border-app-border text-text-muted"}`}
                >
                  {type === "member" ? "Member" : "Staff / owner"}
                </button>
              ))}
            </div>
            <select value={selected} onChange={(e) => setSelected(e.target.value)} required
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-brand">
              <option value="">Select {targetType === "member" ? "a member" : "a staff member"}…</option>
              {targetType === "member"
                ? members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.firstName} {m.lastName}{m.isMinor ? ` (minor, guardian: ${m.guardianName || m.guardianEmail || "required"})` : ""}
                    </option>
                  ))
                : staffList.map((u) => (
                    <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                  ))}
            </select>
            {targetType === "member" && (
              <p className="text-xs text-text-muted mt-1">
                Minor messages include the linked guardian account and the athlete account when available.
              </p>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-text-primary mb-1">Message</label>
            <textarea value={body} onChange={(e) => setBody(e.target.value)} required rows={4}
              placeholder="Type your message…"
              className="w-full px-3 py-2 border border-app-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand resize-none" />
          </div>
          {error && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
          {success && <div className="text-sm text-text-primary bg-lime-accent/30 border border-lime-accent rounded-lg px-3 py-2">{success}</div>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="flex-1 px-4 py-2 border border-app-border text-text-primary rounded-lg text-sm hover:bg-app-bg">Cancel</button>
            <button type="submit" disabled={sending} className="flex-1 px-4 py-2 bg-brand text-white rounded-lg text-sm font-medium hover:bg-brand-hover disabled:opacity-50">
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
