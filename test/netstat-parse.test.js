import { test } from "node:test";
import assert from "node:assert/strict";

import { parseNetstatListenerPid } from "../dist/src/cli/daemon-cmd.js";

// Regression guard for the locale bug: `findPidOnPort` used to look for the WORD "LISTENING" in
// netstat's output. Windows localizes that column, so on a German machine the daemon was never
// found — `openwolf daemon stop` said "No daemon running" while one was plainly listening, and
// nothing ever cleaned up. The fixtures below are the real thing: captured from
// `netstat -ano -p tcp` on Windows 11 Pro (de-DE), including the mojibake, because netstat writes
// the OEM codepage and Node decodes it as UTF-8.

// Verbatim capture, de-DE, a Node process listening on 51999 (PID 10520).
const DE = [
  "",
  "Aktive Verbindungen",
  "",
  "  Proto  Lokale Adresse         Remoteadresse          Status          PID",
  "  TCP    0.0.0.0:51999          0.0.0.0:0              ABH�REN         10520",
  "  TCP    127.0.0.1:49670        127.0.0.1:49671        HERGESTELLT     7304",
].join("\n");

const EN = [
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    0.0.0.0:51999          0.0.0.0:0              LISTENING       10520",
].join("\n");

const FR = [
  "  TCP    0.0.0.0:51999          0.0.0.0:0              ÉCOUTE          10520",
].join("\n");

test("the listener is found no matter what language the state column speaks", () => {
  for (const [name, dump] of [["de-DE (mojibake)", DE], ["en-US", EN], ["fr-FR", FR]]) {
    assert.equal(parseNetstatListenerPid(dump, 51999), 10520, `locale: ${name}`);
  }
});

test("a TIME_WAIT row on the same port must not hand back a foreign PID", () => {
  // This is the second half of the bug: `line.includes(":18791")` also matched connections in
  // TIME_WAIT, whose last column belongs to somebody else's process — one taskkill from killing it.
  const dump = [
    "  TCP    127.0.0.1:51999        127.0.0.1:60123        WARTEND         9999",
    "  TCP    0.0.0.0:51999          0.0.0.0:0              ABH�REN         4242",
  ].join("\n");
  assert.equal(parseNetstatListenerPid(dump, 51999), 4242);
});

test("only the wildcard remote address counts as a listener", () => {
  const dump = "  TCP    127.0.0.1:51999        127.0.0.1:60123        HERGESTELLT     9999";
  assert.equal(parseNetstatListenerPid(dump, 51999), null);
});

test("IPv6 listeners are found too", () => {
  const dump = "  TCP    [::]:51999             [::]:0                 ABH�REN         777";
  assert.equal(parseNetstatListenerPid(dump, 51999), 777);
});

test("a port is matched whole — 8791 must not match 18791", () => {
  const dump = "  TCP    0.0.0.0:18791          0.0.0.0:0              LISTENING       555";
  assert.equal(parseNetstatListenerPid(dump, 8791), null);
  assert.equal(parseNetstatListenerPid(dump, 18791), 555);
});

test("no listener means null, not a crash", () => {
  assert.equal(parseNetstatListenerPid("", 51999), null);
  assert.equal(parseNetstatListenerPid("  TCP    junk", 51999), null);
});
