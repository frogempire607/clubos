"use client";

// One set of rules for everything that opens over the page — Sheet, the dialog
// host, and the older hand-built modals and drawers (crash audit 2026-11-18,
// docs/CRASH-AUDIT-2026-11-18.md).
//
// A sheet closes when the person closes it, and at no other time. Three things
// used to break that, each of them written separately in a couple of dozen
// components:
//
//   1. BACKDROP. `onClick={onClose}` sat on the full-screen element that also
//      CONTAINS the panel. Select the text in a field by dragging, let go a
//      few pixels past the panel edge, and the browser reports a click on that
//      container: the sheet closed, with whatever had been typed.
//      → backdropDismiss(): the press must both start and end on the backdrop.
//
//   2. ESCAPE. Every sheet listened for Escape on `document` by itself. With a
//      "Discard changes?" dialog open over an edit drawer, one press answered
//      the dialog AND closed (or re-prompted) the drawer underneath.
//      → useOverlayLayer / useEscapeToClose: only the top layer hears Escape.
//
//   3. SCROLL LOCK. Each sheet saved and restored `body.style.overflow` on its
//      own, so two sheets closing in the "wrong" order left the page unable to
//      scroll until a reload.
//      → one counted lock, released when the last layer closes.
//
// scripts/sheet-stability-guard.ts fails the build if a component goes back to
// doing any of these by hand.

import { useEffect, useRef } from "react";
import type { MouseEvent, PointerEvent } from "react";

// ── 1. backdrop ─────────────────────────────────────────────────────────────

// Where the current press began and where it was let go. One pointer is down
// at a time, so one slot each. The browser reports a click on the nearest
// element containing BOTH points, so `click` alone cannot tell a click on the
// backdrop from a drag that merely crossed it.
let pressStartedOn: EventTarget | null = null;
let pressEndedOn: EventTarget | null = null;

/**
 * Props for a backdrop that closes on a real click on the backdrop only.
 *
 *   <div className="fixed inset-0 …" {...backdropDismiss(onClose)}>
 *     <div className="panel">…</div>
 *   </div>
 *
 * Works on the container around the panel and on a separate backdrop element.
 * A press that starts or ends inside the panel (a text selection, a slider, a
 * scroll drag) never closes it.
 */
export function backdropDismiss(onClose: (() => void) | undefined | null) {
  const down = (e: { target: EventTarget }) => { pressStartedOn = e.target; pressEndedOn = null; };
  const up = (e: { target: EventTarget }) => { pressEndedOn = e.target; };
  return {
    onPointerDown: down as (e: PointerEvent<HTMLElement>) => void,
    onPointerUp: up as (e: PointerEvent<HTMLElement>) => void,
    // Older WebViews without pointer events still send mouse events.
    onMouseDown: down as (e: MouseEvent<HTMLElement>) => void,
    onMouseUp: up as (e: MouseEvent<HTMLElement>) => void,
    onClick: (e: MouseEvent<HTMLElement>) => {
      const started = pressStartedOn, ended = pressEndedOn;
      pressStartedOn = null;
      pressEndedOn = null;
      if (!onClose) return;
      if (e.target === e.currentTarget && started === e.currentTarget && ended === e.currentTarget) onClose();
    },
  };
}

// ── 2 + 3. layers ───────────────────────────────────────────────────────────

type Layer = { id: number; onEscape: () => void; lock: boolean };
const layers: Layer[] = [];
let nextId = 1;
let locks = 0;
let overflowBeforeLock = "";
let listening = false;

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  const top = layers[layers.length - 1];
  if (top) top.onEscape();
}

function lockScroll() {
  if (typeof document === "undefined") return;
  if (locks === 0) {
    overflowBeforeLock = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  locks++;
}

function unlockScroll() {
  if (typeof document === "undefined") return;
  locks = Math.max(0, locks - 1);
  if (locks === 0) document.body.style.overflow = overflowBeforeLock;
}

function open(layer: Layer) {
  layers.push(layer);
  if (!listening && typeof document !== "undefined") {
    document.addEventListener("keydown", onKeyDown);
    listening = true;
  }
  if (layer.lock) lockScroll();
}

function close(layer: Layer) {
  const i = layers.indexOf(layer);
  if (i >= 0) layers.splice(i, 1);
  if (layer.lock) unlockScroll();
  if (layers.length === 0 && listening && typeof document !== "undefined") {
    document.removeEventListener("keydown", onKeyDown);
    listening = false;
  }
}

/** True while any sheet, drawer, dialog or menu registered here is open. */
export function hasOpenOverlay(): boolean {
  return layers.length > 0;
}

/**
 * Register an open sheet. While `open`, Escape reaches `onEscape` only if this
 * is the top layer, and (with `lockScroll`) the page behind does not scroll.
 *
 * `onEscape` may be a new function on every render: it is read at the moment
 * of the key press, so a parent re-rendering never re-registers the layer.
 */
export function useOverlayLayer(open_: boolean, opts: { onEscape?: (() => void) | null; lockScroll?: boolean } = {}) {
  const escape = useRef(opts.onEscape);
  escape.current = opts.onEscape;
  const lock = !!opts.lockScroll;
  useEffect(() => {
    if (!open_) return;
    const layer: Layer = { id: nextId++, onEscape: () => escape.current?.(), lock };
    open(layer);
    return () => close(layer);
  }, [open_, lock]);
}

/** Escape closes this — unless something else is open on top of it. */
export function useEscapeToClose(onClose: (() => void) | undefined | null, enabled = true) {
  useOverlayLayer(enabled, { onEscape: onClose });
}

/**
 * Hold the page still behind something open, without taking Escape. Counted
 * together with every sheet's lock, so the order things close in never leaves
 * the page stuck.
 */
export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    lockScroll();
    return unlockScroll;
  }, [active]);
}
