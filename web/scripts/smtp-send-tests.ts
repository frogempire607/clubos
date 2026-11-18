/**
 * A real SMTP send through nodemailer, end to end, on this machine.
 *
 *   npx tsx scripts/smtp-send-tests.ts
 *
 * Added with the nodemailer 7 → 10 upgrade (dependency audit 2026-11-18).
 * lib/email.ts is the app's only use of nodemailer and nothing exercised it:
 * every other test stops at "sendEmail was called". This starts a small SMTP
 * server on 127.0.0.1, sends through the real `sendEmail`, and reads what
 * arrived on the wire — so a library upgrade that changed the conversation,
 * the headers or the encoding fails here instead of in a family's inbox.
 *
 * It also pins what the upgrade was for: text placed in a recipient, a subject
 * or a display name cannot add a recipient or a header.
 *
 * No network beyond 127.0.0.1, no database, no real mailbox.
 */
import net from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failed++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok || !detail ? "" : `  — ${detail}`}`);
}

type Received = { auth: string | null; from: string; rcpt: string[]; data: string };

/** The smallest SMTP server that a real client will complete a send against. */
function startSink(): Promise<{ port: number; messages: Received[]; connections: () => number; close: () => Promise<void> }> {
  const messages: Received[] = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections++;
    let buffer = "";
    let inData = false;
    let cur: Received = { auth: null, from: "", rcpt: [], data: "" };
    let awaitingLogin: "user" | "pass" | null = null;
    const say = (line: string) => socket.write(`${line}\r\n`);
    say("220 sink.local ESMTP");
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buffer.slice(0, end).replace(/^\.\./gm, ".");
          buffer = buffer.slice(end + 5);
          inData = false;
          messages.push(cur);
          cur = { auth: cur.auth, from: "", rcpt: [], data: "" };
          say("250 2.0.0 queued");
          continue;
        }
        const nl = buffer.indexOf("\r\n");
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const up = line.toUpperCase();
        if (awaitingLogin === "user") { awaitingLogin = "pass"; say("334 UGFzc3dvcmQ6"); }
        else if (awaitingLogin === "pass") { awaitingLogin = null; cur.auth = "LOGIN"; say("235 2.7.0 ok"); }
        else if (up.startsWith("EHLO")) { socket.write("250-sink.local\r\n250-SIZE 10485760\r\n250-8BITMIME\r\n250 AUTH PLAIN LOGIN\r\n"); }
        else if (up.startsWith("HELO")) say("250 sink.local");
        else if (up.startsWith("AUTH PLAIN")) { cur.auth = "PLAIN"; say("235 2.7.0 ok"); }
        else if (up.startsWith("AUTH LOGIN")) { awaitingLogin = "user"; say("334 VXNlcm5hbWU6"); }
        else if (up.startsWith("MAIL FROM:")) { cur.from = line.slice(10).trim(); say("250 2.1.0 ok"); }
        else if (up.startsWith("RCPT TO:")) { cur.rcpt.push(line.slice(8).trim()); say("250 2.1.5 ok"); }
        else if (up === "DATA") { inData = true; say("354 go ahead"); }
        else if (up === "RSET") say("250 ok");
        else if (up === "QUIT") { say("221 bye"); socket.end(); }
        else say("250 ok");
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ port, messages, connections: () => connections, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

/** Header value by name from a raw message (unfolded). */
function header(raw: string, name: string): string | null {
  const head = raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}:[ \\t]*(.*)$`, "im").exec(head);
  return m ? m[1].trim() : null;
}
/** Decode RFC 2047 words (=?UTF-8?Q?…?= / =?UTF-8?B?…?=) the way a mail app shows them. */
function decoded(value: string | null): string {
  if (!value) return "";
  return value
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?([QB])\?([^?]*)\?=/gi, (_, kind: string, text: string) =>
      kind.toUpperCase() === "B"
        ? Buffer.from(text, "base64").toString("utf8")
        : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8"));
}
const headerNames = (raw: string) => raw.split("\r\n\r\n")[0].replace(/\r\n[ \t]+/g, " ").split("\r\n").map((l) => l.split(":")[0].toLowerCase());
/** The HTML part, whatever transfer encoding the library chose. */
function body(raw: string): string {
  const rest = raw.slice(raw.indexOf("\r\n\r\n") + 4);
  const enc = (header(raw, "Content-Transfer-Encoding") ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(rest.replace(/\s+/g, ""), "base64").toString("utf8");
  if (enc === "quoted-printable") {
    const joined = rest.replace(/=\r\n/g, "");
    return Buffer.from(joined.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  }
  return rest;
}

async function main() {
  const sink = await startSink();
  process.env.SMTP_HOST = "127.0.0.1";
  process.env.SMTP_PORT = String(sink.port);
  process.env.SMTP_SECURE = "false";
  process.env.SMTP_USER = "local-test-user";
  process.env.SMTP_PASS = "local-test-pass";
  process.env.EMAIL_FROM = "AthletixOS <noreply@sink.local>";
  const { sendEmail, isEmailConfigured } = await import("../lib/email");

  console.log("\n§1 the library in use");
  const version = JSON.parse(readFileSync(join(__dirname, "..", "node_modules", "nodemailer", "package.json"), "utf8")).version as string;
  check(`nodemailer ${version} — 10 or newer`, Number(version.split(".")[0]) >= 10);
  check("the app counts as configured to send", isEmailConfigured());

  console.log("\n§2 an ordinary send arrives intact");
  const html = `<p>Hi Shannan — Titus is booked for <strong>Tuesday 6:00 PM EST</strong>.</p><p>Fee: $25.00 · café ☕</p>`;
  await sendEmail({
    to: "shannan@family.test",
    subject: "You're booked: MS/HS Wrestling — Tuesday",
    html,
    fromName: "Frog Empire Wrestling",
    replyTo: "frontdesk@club.test",
    listUnsubscribeUrl: "https://athletix-os.com/api/unsubscribe?t=abc",
  });
  const m = sink.messages[0];
  check("one message was delivered", sink.messages.length === 1);
  check("it signed in before sending", !!m?.auth, `auth ${m?.auth}`);
  check("envelope sender is the configured mailbox", /<noreply@sink\.local>/.test(m?.from ?? ""), m?.from);
  check("envelope recipient is exactly the one address", m?.rcpt.length === 1 && /<shannan@family\.test>/.test(m.rcpt[0]), JSON.stringify(m?.rcpt));
  check("From shows the club's name over our mailbox", /Frog Empire Wrestling/.test(header(m.data, "From") ?? "") && /<noreply@sink\.local>/.test(header(m.data, "From") ?? ""), header(m.data, "From") ?? "");
  check("To, Reply-To and Subject are as given", header(m.data, "To") === "shannan@family.test" && header(m.data, "Reply-To") === "frontdesk@club.test" && decoded(header(m.data, "Subject")) === "You're booked: MS/HS Wrestling — Tuesday", `To=${header(m.data, "To")} Reply-To=${header(m.data, "Reply-To")} Subject=${header(m.data, "Subject")}`);
  check("one-click unsubscribe headers are present and unchanged", header(m.data, "List-Unsubscribe") === "<https://athletix-os.com/api/unsubscribe?t=abc>" && header(m.data, "List-Unsubscribe-Post") === "List-Unsubscribe=One-Click");
  check("it is sent as HTML", /text\/html/i.test(header(m.data, "Content-Type") ?? ""));
  check("the body arrives byte for byte, accents and symbols included", body(m.data).trim() === html, body(m.data).slice(0, 120));
  check("it has a Message-ID and a Date", !!header(m.data, "Message-ID") && !!header(m.data, "Date"));

  console.log("\n§3 a transactional email carries no unsubscribe header");
  await sendEmail({ to: "coach@club.test", subject: "Password reset", html: "<p>Reset link</p>" });
  const t = sink.messages[1];
  check("delivered, with the default From", !!t && /AthletixOS/.test(header(t.data, "From") ?? ""));
  check("no List-Unsubscribe, no Reply-To", header(t.data, "List-Unsubscribe") === null && header(t.data, "Reply-To") === null);

  console.log("\n§4 text in a field cannot add a recipient or a header");
  // Found by this test on its first run, on nodemailer 7 AND 10: the library
  // reads a recipient as an address list, so "parent@…\r\nBcc: evil@…" was
  // delivered to evil@… only. lib/email.ts now sends to one plain address or
  // not at all.
  const tryFor = async (label: string, args: Parameters<typeof sendEmail>[0], expectSent: boolean) => {
    const from = sink.messages.length;
    let refused = false;
    try { await sendEmail(args); } catch { refused = true; }
    const sent = sink.messages.slice(from);
    const everyRcpt = sent.flatMap((x) => x.rcpt).join(" ");
    const names = sent.flatMap((x) => headerNames(x.data));
    check(`${label}: nobody extra is in the envelope`, !/attacker\.test/.test(everyRcpt), everyRcpt);
    check(`${label}: no Bcc or forged header appears`, !names.includes("bcc") && !names.includes("x-injected"), names.join(","));
    check(`${label}: ${expectSent ? "the real recipient still gets the email" : "it is refused, not sent somewhere else"}`, expectSent ? sent.length === 1 && /<parent@family\.test>/.test(sent[0].rcpt.join(" ")) : refused && sent.length === 0, `refused=${refused} sent=${sent.length}`);
  };
  await tryFor("a recipient with a line break and a second address", { to: "parent@family.test\r\nBcc: evil@attacker.test", subject: "x", html: "<p>x</p>" }, false);
  await tryFor("two recipients in one field", { to: "parent@family.test, evil@attacker.test", subject: "x", html: "<p>x</p>" }, false);
  await tryFor("a display-name trick", { to: "\"parent@family.test\" <evil@attacker.test>", subject: "x", html: "<p>x</p>" }, false);
  await tryFor("a comment trick", { to: "parent@family.test (evil@attacker.test)", subject: "x", html: "<p>x</p>" }, false);
  await tryFor("a subject with a line break", { to: "parent@family.test", subject: "Hello\r\nBcc: evil@attacker.test\r\nX-Injected: 1", html: "<p>x</p>" }, true);
  await tryFor("a club name with a line break", { to: "parent@family.test", subject: "x", html: "<p>x</p>", fromName: "Club\r\nBcc: evil@attacker.test" }, true);
  await tryFor("a reply-to with a second address", { to: "parent@family.test", subject: "x", html: "<p>x</p>", replyTo: "desk@club.test\r\nX-Injected: 1, evil@attacker.test" }, true);
  await tryFor("an unsubscribe link with a line break", { to: "parent@family.test", subject: "x", html: "<p>x</p>", listUnsubscribeUrl: "https://athletix-os.com/u>\r\nX-Injected: 1\r\nBcc: <evil@attacker.test" }, true);
  const started = Date.now();
  try { await sendEmail({ to: `${"(".repeat(4000)}a@b.test`, subject: "x", html: "<p>x</p>" }); } catch { /* refused */ }
  check("a pathological address is refused at once", Date.now() - started < 300, `${Date.now() - started}ms`);

  const { plainEmailAddress } = await import("../lib/email");
  for (const ok of ["shannan@family.test", "  Coach.O'Brien+wrestling@club-name.co.uk ", "a_b-c.d@sub.domain.org"]) check(`accepted: ${ok.trim()}`, plainEmailAddress(ok) === ok.trim());
  for (const bad of ["", "no-at-sign", "two@@signs.test", "a@b", "a b@c.test", "a@b.test\nBcc: c@d.test", "Name <a@b.test>", "a@b.test,c@d.test", "a@b.test;c@d.test", "a@[127.0.0.1]", `${"x".repeat(250)}@b.test`]) check(`refused: ${JSON.stringify(bad).slice(0, 34)}`, plainEmailAddress(bad) === null);
  const club = readFileSync(join(__dirname, "..", "lib", "sendClubEmail.ts"), "utf8");
  check("the Resend path applies the same rule before either provider is called", club.indexOf("plainEmailAddress(recipientEmail)") > 0 && club.indexOf("plainEmailAddress(recipientEmail)") < club.indexOf("client.emails.send("));

  console.log("\n§5 with no mail server configured, nothing is attempted");
  const conns = sink.connections();
  process.env.SMTP_HOST = "";
  await sendEmail({ to: "nobody@family.test", subject: "not sent", html: "<p>x</p>" });
  check("no connection was opened", sink.connections() === conns);

  await sink.close();
}

main().then(() => {
  console.log(failed ? `\n${failed} FAILED` : "\nall passed");
  process.exit(failed ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
