"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Users as UsersIcon, Mail as MailIcon, PenSquare } from "lucide-react";

// Lime accent for child-thread visual markers. Defined as constants so
// every consumer in this file uses the exact same color even when the
// Tailwind palette isn't fully available (e.g. an iOS WebKit JIT race
// on the very first paint after install). Inline style guarantees the
// color renders even if `bg-lime-100` etc. don't get compiled.
const LIME = "#A3E635";
const LIME_BG = "rgba(163, 230, 53, 0.18)";
const LIME_BORDER = "rgba(163, 230, 53, 0.55)";
const LIME_TEXT = "#3F6212";

type ForMember = { id: string; firstName: string; lastName: string };

type Conversation = {
  user: { id: string; firstName: string; lastName: string; role: string };
  lastMessage: { id: string; body: string; createdAt: string; senderId: string; readAt: string | null };
  unread: number;
  forMember?: ForMember;
};

type Group = {
  id: string;
  name: string;
  type: string;
  messages: { id: string; body: string; createdAt: string; sender: { firstName: string; lastName: string } }[];
  _count: { members: number };
};

type ChildGroup = {
  id: string;
  name: string;
  forMember: ForMember;
  lastMessage: { id: string; body: string; createdAt: string; sender: { firstName: string; lastName: string } | null } | null;
  memberCount: number;
};

// Shared pill used on the list page (and matched in the thread page
// headers) so parents see a consistent visual marker for "this thread
// is for <kid>". Inline styles — Tailwind's `bg-lime-100` etc. depend
// on the lime palette being in the compiled CSS, which is not
// guaranteed on every install of Tailwind v4. Inline styles render
// the same on every browser and every device.
function ChildBadge({ name }: { name: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold px-2 py-0.5 rounded-full flex-shrink-0"
      style={{
        background: LIME_BG,
        color: LIME_TEXT,
        border: `1px solid ${LIME_BORDER}`,
      }}
    >
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      For {name}
    </span>
  );
}

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

type LinkedChild = { id: string; firstName: string; lastName: string; hasOwnLogin: boolean };
type Subject = { id: string; name: string; kind: "self" | "child" };
type Recipient = { id: string; firstName: string; lastName: string; role: string; title: string | null };

export default function MemberMessagesPage() {
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [childConversations, setChildConversations] = useState<Conversation[]>([]);
  const [childGroups, setChildGroups] = useState<ChildGroup[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [composeOpen, setComposeOpen] = useState(false);
  // Linked-children list pulled from /api/member/portal so the page can
  // tell the parent "this is where messages for <kid> show up" even
  // before any messages exist — otherwise the section is invisible and
  // the parent has no way to know the feature is plumbed at all.
  const [linkedChildren, setLinkedChildren] = useState<LinkedChild[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // P4 — set by the API when the guardian has disabled messaging on
  // this controlled minor's account. Renders a friendly banner in
  // place of the conversations.
  const [messagingDisabled, setMessagingDisabled] = useState(false);

  useEffect(() => {
    fetch("/api/member/messages", { cache: "no-store" })
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
          if (d.messagingDisabled) setMessagingDisabled(true);
          setConversations(d.conversations || []);
          setGroups(d.groups || []);
          setChildConversations(d.childConversations || []);
          setChildGroups(d.childGroups || []);
          setSubjects(d.subjects || []);
        }
        setLoading(false);
      });

    // Coaches/owners the member can start a new conversation with.
    fetch("/api/member/messages/recipients")
      .then((r) => (r.ok ? r.json() : { recipients: [] }))
      .then((d) => setRecipients(Array.isArray(d?.recipients) ? d.recipients : []))
      .catch(() => {});

    // Best-effort fetch — used only for the empty-state "no child
    // messages yet" copy. Failure is silent.
    fetch("/api/member/portal")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d?.user?.guardianOf) return;
        const kids: LinkedChild[] = d.user.guardianOf.map(
          (g: { member: { id: string; firstName: string; lastName: string; user?: { id: string } | null } }) => ({
            id: g.member.id,
            firstName: g.member.firstName,
            lastName: g.member.lastName,
            // A child can receive coach DMs only if they have their own
            // User row (their own portal login). Otherwise they're a
            // Member-only record and the API can't surface their threads.
            hasOwnLogin: !!g.member.user,
          }),
        );
        setLinkedChildren(kids);
      })
      .catch(() => {});
  }, []);

  const isEmpty =
    !loading &&
    conversations.length === 0 &&
    groups.length === 0 &&
    childConversations.length === 0 &&
    childGroups.length === 0;

  return (
    <>
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-stone-900 mb-1">Messages</h1>
          <p className="text-sm text-stone-500">Conversations with your club.</p>
        </div>
        {!messagingDisabled && recipients.length > 0 && (
          <button
            onClick={() => setComposeOpen(true)}
            className="pbtn-accent inline-flex items-center gap-1.5 text-sm font-semibold px-3.5 py-2 rounded-xl flex-shrink-0"
          >
            <PenSquare size={15} strokeWidth={2.25} />
            New message
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-700 mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-stone-400 text-sm">Loading…</div>
      ) : messagingDisabled ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 text-center">
          <p className="text-sm font-semibold text-amber-900 mb-1">
            Messaging is managed by your guardian
          </p>
          <p className="text-xs text-amber-700">
            Your guardian has disabled messaging on your account. Ask them
            to enable it if you need to send a message — they can change
            this in their parental controls.
          </p>
        </div>
      ) : isEmpty ? (
        <div className="bg-white rounded-xl border border-stone-200 p-12 text-center">
          <div className="mx-auto mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-lime-accent/20 text-charcoal">
            <MailIcon className="h-7 w-7" strokeWidth={2} />
          </div>
          <p className="text-base font-medium text-stone-900 mb-1">No messages yet</p>
          <p className="text-sm text-stone-500">When your club sends you a message, it&apos;ll show up here.</p>
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

          {(childConversations.length > 0 || childGroups.length > 0 || linkedChildren.length > 0) && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <UsersIcon size={14} strokeWidth={2.25} style={{ color: LIME_TEXT }} />
                <h2 className="text-xs uppercase tracking-wider text-stone-500 font-medium">
                  Messages for your athletes
                </h2>
              </div>
              <p className="text-[11px] text-stone-400 mb-3">
                Threads sent to or from your linked children. Each row has a lime stripe and a "For {linkedChildren[0]?.firstName || "child"}" pill so you always know which kid the message is about.
              </p>
              {childConversations.length === 0 && childGroups.length === 0 ? (
                <div
                  className="rounded-xl p-4 text-xs text-stone-500 flex items-start gap-2"
                  style={{ background: LIME_BG, border: `1px solid ${LIME_BORDER}` }}
                >
                  <MailIcon size={14} strokeWidth={2} style={{ color: LIME_TEXT, marginTop: 1 }} />
                  <div>
                    <p className="font-medium text-stone-700 mb-0.5">No messages for your athletes yet</p>
                    <p>
                      When your club messages {linkedChildren.map((c) => c.firstName).join(", ") || "your athlete"}, you'll see it here with a lime stripe so you can spot it instantly.
                      {linkedChildren.some((c) => !c.hasOwnLogin) && (
                        <span> Some of your athletes don&apos;t have their own member login yet — only kids with their own account can receive DMs from coaches.</span>
                      )}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  {childGroups.map((g) => (
                    <Link
                      key={`${g.id}:${g.forMember.id}`}
                      href={`/member/messages/group/${g.id}?for=${g.forMember.id}&forName=${encodeURIComponent(g.forMember.firstName)}`}
                      className="block bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
                      style={{ borderLeft: `5px solid ${LIME}` }}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0 flex-wrap">
                          <h3 className="text-sm font-semibold text-stone-900 truncate">{g.name}</h3>
                          <ChildBadge name={g.forMember.firstName} />
                        </div>
                        {g.lastMessage && (
                          <span className="text-[11px] text-stone-400 flex-shrink-0 tabular-nums">{relTime(g.lastMessage.createdAt)}</span>
                        )}
                      </div>
                      {g.lastMessage ? (
                        <p className="text-sm text-stone-600 line-clamp-1">
                          {g.lastMessage.sender && (
                            <span className="font-medium text-stone-700">{g.lastMessage.sender.firstName}: </span>
                          )}
                          {g.lastMessage.body}
                        </p>
                      ) : (
                        <p className="text-xs text-stone-400">No messages yet · {g.memberCount} members</p>
                      )}
                    </Link>
                  ))}
                  {childConversations.map((c) => (
                    <Link
                      key={`${c.forMember?.id}:${c.user.id}`}
                      href={
                        c.forMember
                          ? `/member/messages/dm/${c.user.id}?about=${c.forMember.id}&forName=${encodeURIComponent(c.forMember.firstName)}`
                          : `/member/messages/dm/${c.user.id}`
                      }
                      className="block bg-white rounded-xl border border-stone-200 p-4 hover:shadow-sm transition"
                      style={{ borderLeft: `5px solid ${LIME}` }}
                    >
                      <div className="flex items-start justify-between gap-3 mb-1.5">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="w-9 h-9 rounded-full bg-stone-200 flex items-center justify-center text-xs font-bold text-stone-700 flex-shrink-0">
                            {c.user.firstName[0]}{c.user.lastName[0]}
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="text-sm font-semibold text-stone-900 truncate">
                                {c.user.firstName} {c.user.lastName}
                              </p>
                              {c.forMember && <ChildBadge name={c.forMember.firstName} />}
                            </div>
                            <p className="text-[11px] text-stone-400">
                              {c.user.role === "OWNER" ? "Owner" : c.user.role === "STAFF" ? "Staff" : "Member"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          {c.unread > 0 && (
                            <span className="text-[10px] bg-stone-900 text-white px-1.5 py-0.5 rounded-full font-semibold tabular-nums">
                              {c.unread}
                            </span>
                          )}
                          <span className="text-[11px] text-stone-400 tabular-nums">{relTime(c.lastMessage.createdAt)}</span>
                        </div>
                      </div>
                      <p className="text-sm text-stone-600 line-clamp-1">{c.lastMessage.body}</p>
                    </Link>
                  ))}
                </div>
              )}
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

      {composeOpen && (
        <NewMessageModal
          recipients={recipients}
          subjects={subjects}
          onClose={() => setComposeOpen(false)}
          onSent={(recipientId, about, forName) => {
            setComposeOpen(false);
            const q = new URLSearchParams();
            if (about) q.set("about", about);
            if (forName) q.set("forName", forName);
            const qs = q.toString();
            router.push(`/member/messages/dm/${recipientId}${qs ? `?${qs}` : ""}`);
          }}
        />
      )}
    </>
  );
}

function NewMessageModal({
  recipients,
  subjects,
  onClose,
  onSent,
}: {
  recipients: Recipient[];
  subjects: Subject[];
  onClose: () => void;
  onSent: (recipientId: string, about: string, forName: string) => void;
}) {
  const [recipientId, setRecipientId] = useState(recipients[0]?.id ?? "");
  const [about, setAbout] = useState(
    subjects.find((s) => s.kind === "self")?.id ?? subjects[0]?.id ?? "",
  );
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  async function send() {
    if (!recipientId || !body.trim()) return;
    setSending(true);
    setErr("");
    const subj = subjects.find((s) => s.id === about);
    const childAbout = subj && subj.kind === "child" ? about : null;
    const res = await fetch(`/api/member/messages/dm/${recipientId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: body.trim(), about: childAbout }),
    });
    const d = await res.json().catch(() => ({}));
    setSending(false);
    if (!res.ok) {
      setErr(typeof d.error === "string" ? d.error : "Could not send your message.");
      return;
    }
    onSent(recipientId, childAbout ?? "", subj && subj.kind === "child" ? subj.name : "");
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full max-w-md">
        <div className="px-5 py-4 border-b border-stone-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-stone-900">New message</h2>
          <button onClick={onClose} className="text-stone-400 hover:text-stone-700 text-xl leading-none">×</button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">To</label>
            <select
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
            >
              {recipients.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.firstName} {r.lastName}
                  {r.role === "OWNER" ? " (Owner)" : r.title ? ` · ${r.title}` : ""}
                </option>
              ))}
            </select>
          </div>
          {subjects.length > 1 && (
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">About</label>
              <select
                value={about}
                onChange={(e) => setAbout(e.target.value)}
                className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm bg-white focus:outline-none focus:ring-2 focus:ring-stone-900"
              >
                {subjects.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.kind === "self" ? "Me" : s.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-stone-400 mt-1">
                The coach sees which athlete this conversation is about.
              </p>
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">Message</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={4}
              placeholder="Write your message…"
              className="w-full px-3 py-2 border border-stone-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-stone-900"
            />
          </div>
          {err && <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
          <div className="flex gap-2 justify-end">
            <button onClick={onClose} className="px-4 py-2 border border-stone-300 text-stone-700 rounded-xl text-sm hover:bg-stone-50">
              Cancel
            </button>
            <button
              onClick={send}
              disabled={sending || !recipientId || !body.trim()}
              className="pbtn-accent px-5 py-2 rounded-xl text-sm font-semibold disabled:opacity-50"
            >
              {sending ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
