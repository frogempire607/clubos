// What the Android back button does. PURE.
//
// On Android, "back" is the main way people move around; an app that ignores
// it (or quits on the first press) reads as a website in a box. The order:
//   1. something is open on top of the screen  → close it
//   2. there is a screen to go back to          → go back
//   3. this is a top-level screen               → leave the app (it stays
//                                                 open in the background)

/** Screens where "back" has nowhere sensible to go inside the app. */
const ROOT_PATHS = new Set(["/member", "/dashboard", "/login"]);

export type BackAction = "CLOSE_DIALOG" | "GO_BACK" | "LEAVE_APP";

export function backAction(input: { hasOpenDialog: boolean; pathname: string; historyLength: number }): BackAction {
  if (input.hasOpenDialog) return "CLOSE_DIALOG";
  const path = input.pathname.replace(/\/+$/, "") || "/";
  if (ROOT_PATHS.has(path)) return "LEAVE_APP";
  // A screen opened directly (a link from outside) has no history of ours.
  if (input.historyLength <= 1) return "LEAVE_APP";
  return "GO_BACK";
}
