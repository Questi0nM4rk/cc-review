// Contract spec for isBotThread (bot-thread ownership filter). The `threads` adapter verbs must
// return ONLY bot-owned threads: the review brain resolves/replies to every returned thread, so a
// human-opened thread leaking through would let the bot close a conversation it doesn't own.
// Run: node --test scripts/threads.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBotThread } from "./threads.mjs";

const BOT = "cc-review[bot]";
const MARKER = "<!-- cc-review:finding a1b2c3d4 -->";

test("author login === botLogin → owned", () => {
  assert.equal(isBotThread(BOT, "some finding body", BOT), true);
});

test("finding marker in body → owned regardless of author (old/in-session bot threads)", () => {
  assert.equal(isBotThread("alice", `Fix the null deref\n\n${MARKER}`, BOT), true);
});

test("finding marker with any id still matches (substring, id-agnostic)", () => {
  assert.equal(isBotThread("bob", "<!-- cc-review:finding deadbeef -->", BOT), true);
});

test("neither login nor marker → NOT owned", () => {
  assert.equal(isBotThread("alice", "a human reviewer's comment", BOT), false);
});

test("null/undefined body and login do not crash → NOT owned", () => {
  assert.equal(isBotThread(null, null, BOT), false);
  assert.equal(isBotThread(undefined, undefined, BOT), false);
});

test("null login but marker present → owned", () => {
  assert.equal(isBotThread(null, MARKER, BOT), true);
});

test("empty/undefined botLogin: only the marker can match", () => {
  assert.equal(isBotThread("alice", MARKER, ""), true);
  assert.equal(isBotThread("alice", "human comment", ""), false);
  assert.equal(isBotThread("alice", MARKER, undefined), true);
  assert.equal(isBotThread("alice", "human comment", undefined), false);
});

test("empty botLogin does NOT match an empty/missing author login", () => {
  // guard: "" === "" must not falsely own a thread whose author login is absent.
  assert.equal(isBotThread("", "human comment", ""), false);
  assert.equal(isBotThread(null, "human comment", ""), false);
});
