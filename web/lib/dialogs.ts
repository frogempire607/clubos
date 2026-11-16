// In-app replacements for the browser's alert(), confirm() and prompt().
//
// The browser versions are titled with the web address ("athletix-os.com
// says…"), freeze the whole screen while they are open, cannot be styled, and
// are the first thing an app reviewer notices in a wrapped website. 78 of them
// guarded everything from "delete this draft" to "charge this card now".
//
// These are promise-based so a call site changes by one word:
//
//     if (!confirm("Delete this event?")) return;
//     if (!(await confirmDialog("Delete this event?"))) return;
//
// The dialogs are drawn by <DialogHost /> (mounted once in the root layout).
// This file is the queue between the two and has no React in it, so it can be
// called from any handler and tested without a browser.

export type DialogRequest =
  | { id: number; kind: "confirm"; message: string; confirmLabel: string; cancelLabel: string; danger: boolean; resolve: (v: boolean) => void }
  | { id: number; kind: "alert"; message: string; resolve: () => void }
  | { id: number; kind: "prompt"; message: string; defaultValue: string; confirmLabel: string; resolve: (v: string | null) => void };

type Listener = (queue: readonly DialogRequest[]) => void;

let nextId = 1;
let queue: DialogRequest[] = [];
const listeners = new Set<Listener>();

function emit() {
  const snapshot = queue.slice();
  listeners.forEach((l) => l(snapshot));
}

/** Used by DialogHost. Calls back immediately with the current queue. */
export function subscribeDialogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue.slice());
  return () => { listeners.delete(listener); };
}

function settle(id: number) {
  queue = queue.filter((d) => d.id !== id);
  emit();
}

/**
 * Words that mean the action cannot simply be taken back, or moves money.
 * A dialog whose message uses one gets a red confirm button.
 */
const DANGER = /\b(delete|remove|archive|void|cancel|refund|charge|revoke|roll back|discard|deny|decline|cannot be undone|can't be undone)\b/i;

export function looksDangerous(message: string): boolean {
  return DANGER.test(message);
}

export type ConfirmOptions = { confirmLabel?: string; cancelLabel?: string; danger?: boolean };

/** Ask a yes/no question. Resolves true only when the person confirms. */
export function confirmDialog(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = nextId++;
    queue = [...queue, {
      id, kind: "confirm", message,
      confirmLabel: options.confirmLabel ?? "Confirm",
      cancelLabel: options.cancelLabel ?? "Cancel",
      danger: options.danger ?? looksDangerous(message),
      resolve: (v) => { settle(id); resolve(v); },
    }];
    emit();
  });
}

/** Tell the person something. Resolves when they dismiss it. */
export function alertDialog(message: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const id = nextId++;
    queue = [...queue, { id, kind: "alert", message, resolve: () => { settle(id); resolve(); } }];
    emit();
  });
}

/** Ask for a line of text. Resolves null when cancelled (as prompt() does). */
export function promptDialog(message: string, defaultValue = "", options: { confirmLabel?: string } = {}): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const id = nextId++;
    queue = [...queue, {
      id, kind: "prompt", message, defaultValue,
      confirmLabel: options.confirmLabel ?? "OK",
      resolve: (v) => { settle(id); resolve(v); },
    }];
    emit();
  });
}

/** Test seam: how many dialogs are waiting. */
export function pendingDialogs(): number {
  return queue.length;
}
