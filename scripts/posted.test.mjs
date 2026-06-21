// Contract spec for classifyPosted (issue #75 post-verify). Run-scoped by commit_id===head_sha and
// bot login. Run: node --test scripts/posted.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyPosted } from "./posted.mjs";

const BOT = "cc-review[bot]";
const HEAD = "abc123";
const rev = (login, commit) => ({ user: { login }, commit_id: commit });

test("APPROVE on this head by the bot → landed", () => {
  assert.deepEqual(classifyPosted([rev(BOT, HEAD)], [], HEAD, BOT), { reviews: 1, actionItems: 0, landed: true });
});
test("inline action items on this head → landed", () => {
  const v = classifyPosted([], [rev(BOT, HEAD), rev(BOT, HEAD)], HEAD, BOT);
  assert.equal(v.landed, true);
  assert.equal(v.actionItems, 2);
});
test("only a PRIOR run's review (older commit) → NOT landed (run-scoped)", () => {
  assert.equal(classifyPosted([rev(BOT, "oldsha")], [], HEAD, BOT).landed, false);
});
test("a human review on this head → NOT landed (bot-scoped)", () => {
  assert.equal(classifyPosted([rev("alice", HEAD)], [], HEAD, BOT).landed, false);
});
test("nothing posted → NOT landed", () => {
  assert.equal(classifyPosted([], [], HEAD, BOT).landed, false);
});
test("tolerates missing fields / non-arrays", () => {
  assert.equal(classifyPosted(null, undefined, HEAD, BOT).landed, false);
  assert.equal(classifyPosted([{}], [{ user: {} }], HEAD, BOT).landed, false);
});

test("empty headSha never matches a commit_id-less object → NOT landed", () => {
  // guard: "" === "" must not count a bot review whose commit_id is absent.
  assert.deepEqual(classifyPosted([{ user: { login: BOT } }], [], "", BOT), { reviews: 0, actionItems: 0, landed: false });
});
