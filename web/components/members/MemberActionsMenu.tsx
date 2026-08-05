// Phase 4.5.2 §1g — the `⋯` menu.
//
// ── Two rules that are the whole point ───────────────────────────────────────
//
// 1. FIXED ORDER, IDENTICAL EVERYWHERE. The row menu, the mobile card menu and
//    the profile menu render this same component in this same order. Muscle
//    memory is the feature: staff work this list all day, and an action that
//    moves position between surfaces costs more than a slow page.
//
// 2. PERMISSION-GATED ITEMS STAY VISIBLE, GREYED, WITH THE REQUIRED ROLE NAMED.
//    Hiding them is what made the dashboard feel arbitrary — a coach saw a
//    shorter menu than the owner, with no explanation, and reasonably concluded
//    the feature did not exist. A locked row with "Owner" next to it tells the
//    truth and ends the support conversation.

"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  CalendarCheck,
  GitMerge,
  KeyRound,
  Lock,
  MoreHorizontal,
  Pencil,
  Send,
  Ticket,
  Trash2,
  User,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

type MenuMember = { id: string; fullName: string };

type Item =
  | { kind: "divider" }
  | {
      kind: "item";
      key: string;
      label: string;
      Icon: LucideIcon;
      /** null = always allowed */
      requires: "members" | "billing" | "owner" | null;
      destructive?: boolean;
      href?: (m: MenuMember) => string;
    };

/**
 * The canonical order from the handoff. Do not reorder to "group related
 * things" — the grouping is already expressed by the dividers.
 */
const ITEMS: Item[] = [
  { kind: "item", key: "view", label: "View profile", Icon: User, requires: null, href: (m) => `/dashboard/members/${m.id}` },
  { kind: "item", key: "edit", label: "Edit member", Icon: Pencil, requires: "members", href: (m) => `/dashboard/members/${m.id}?edit=1` },
  { kind: "item", key: "resend", label: "Resend invitation", Icon: Send, requires: "members" },
  { kind: "item", key: "reset", label: "Send password reset", Icon: KeyRound, requires: "members" },
  { kind: "item", key: "migration", label: "Continue migration", Icon: GitMerge, requires: "members", href: (m) => `/dashboard/members/migration?member=${m.id}` },
  { kind: "divider" },
  { kind: "item", key: "assign", label: "Assign membership", Icon: Ticket, requires: "billing" },
  { kind: "item", key: "relationship", label: "Add relationship", Icon: User, requires: "members" },
  { kind: "item", key: "checkin", label: "Check in to class", Icon: CalendarCheck, requires: "members" },
  { kind: "divider" },
  { kind: "item", key: "archive", label: "Archive member", Icon: Trash2, requires: "owner", destructive: true },
];

const ROLE_BADGE: Record<string, string> = { members: "Members", billing: "Billing", owner: "Owner" };

export function MemberActionsMenu({
  member,
  canEdit,
  canBill,
  isOwner = false,
  size = 28,
  onAction,
}: {
  member: MenuMember;
  canEdit: boolean;
  canBill: boolean;
  isOwner?: boolean;
  size?: number;
  onAction?: (key: string, member: MenuMember) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // ── Why this menu is a portal ────────────────────────────────────────────
  // The roster's table lives in a `overflow-x-auto` wrapper so wide rows scroll
  // instead of blowing out the page. CSS resolves the other axis to `auto` too,
  // which means an absolutely-positioned dropdown inside it is CLIPPED — the
  // menu opened fine on the top rows and was cut off on the lower ones, so the
  // actions were literally unreachable for most of the roster.
  //
  // Rendering to document.body with fixed coordinates takes the menu out of
  // that clipping context entirely. It also lets the menu flip above the button
  // when there isn't room below, which matters on the last row of every page.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (!b) return;
    const MENU_W = 238;
    const h = menuRef.current?.offsetHeight ?? 320;
    const below = window.innerHeight - b.bottom;
    const top = below < h + 12 && b.top > h + 12 ? b.top - h - 6 : b.bottom + 6;
    // Right-align to the button, then clamp so it can never sit off-screen.
    const left = Math.max(8, Math.min(b.right - MENU_W, window.innerWidth - MENU_W - 8));
    setPos({ top, left });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    // A fixed menu doesn't travel with its row, so follow the button rather
    // than closing. Closing on scroll looked tidier but broke the common case:
    // clicking a ⋯ near the fold scrolls it into view, which fired the handler
    // and dismissed the menu the same gesture had just opened.
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  function allowed(requires: "members" | "billing" | "owner" | null): boolean {
    if (requires === null) return true;
    if (requires === "owner") return isOwner;
    if (requires === "billing") return canBill;
    return canEdit;
  }

  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        aria-label={`Actions for ${member.fullName}`}
        aria-expanded={open}
        style={{ width: size, height: size }}
        className="inline-flex shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-app-bg hover:text-text-primary"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {open && typeof document !== "undefined" && createPortal(
        <div
          ref={menuRef}
          role="menu"
          className="w-[238px] rounded-[10px] bg-surface p-[5px]"
          style={{
            position: "fixed",
            top: pos?.top ?? -9999,
            left: pos?.left ?? -9999,
            zIndex: 60,
            visibility: pos ? "visible" : "hidden",
            boxShadow: "0 12px 32px rgba(17,17,17,.14)",
            border: "1px solid var(--color-border)",
          }}
        >
          {ITEMS.map((it, i) => {
            if (it.kind === "divider") {
              return <div key={`d${i}`} className="my-1 h-px" style={{ background: "var(--color-hairline)" }} />;
            }
            const ok = allowed(it.requires);
            return (
              <button
                key={it.key}
                role="menuitem"
                disabled={!ok}
                title={ok ? undefined : `Requires ${ROLE_BADGE[it.requires as string]} permission`}
                onClick={() => {
                  if (!ok) return;
                  setOpen(false);
                  if (it.href) router.push(it.href(member));
                  else onAction?.(it.key, member);
                }}
                className={`flex w-full items-center gap-[9px] rounded-md px-2 py-[7px] text-left text-[13px] transition-colors ${
                  !ok
                    ? "cursor-not-allowed text-[#9CA3AF]"
                    : it.destructive
                      ? "hover:bg-app-bg"
                      : "text-text-primary hover:bg-app-bg"
                }`}
                style={ok && it.destructive ? { color: "var(--color-danger-text)" } : undefined}
              >
                {ok ? <it.Icon className="h-3.5 w-3.5 shrink-0" /> : <Lock className="h-3.5 w-3.5 shrink-0" />}
                <span className="flex-1 truncate">{it.label}</span>
                {!ok && it.requires && (
                  <span
                    className="rounded-[4px] px-1 text-[10px] font-semibold uppercase"
                    style={{ background: "var(--color-chip-surface)", color: "var(--color-chip-text)" }}
                  >
                    {ROLE_BADGE[it.requires]}
                  </span>
                )}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}

/** Exported so the 4.5.11 fixtures can assert order and gating without a DOM. */
export const MEMBER_MENU_ORDER = ITEMS.filter((i): i is Extract<Item, { kind: "item" }> => i.kind === "item").map(
  (i) => i.key,
);
export const MEMBER_MENU_ITEMS = ITEMS;
