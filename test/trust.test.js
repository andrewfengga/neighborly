// Run with: npm test
// Reputation decay and the accept → complete lifecycle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequest, createVolunteer } from "../src/models.js";
import { reputation, decayWeight } from "../src/reputation.js";
import {
  acceptRequest, completeRequest, reportNoShow, cancelAcceptance,
} from "../src/lifecycle.js";

const now = new Date("2026-10-10T09:00:00");
const hours = (h) => new Date(now.getTime() + h * 3600 * 1000);
const daysAgo = (d) => hours(-24 * d);
const SPOT = { lat: 34.075, lng: -84.294 };
const C = "circle_a";

const volunteer = (extra = {}) =>
  createVolunteer({
    name: "V", circleIds: [C], location: SPOT, skills: ["groceries"],
    availability: [{ start: hours(0), end: hours(100) }], ...extra,
  });

const request = (extra = {}) =>
  createRequest({
    requesterId: "r", circleId: C, taskType: "groceries", location: SPOT,
    window: { start: hours(24), end: hours(28) }, ...extra,
  });

// ---------- reputation ----------

const tasks = (n, outcome = "completed") =>
  Array.from({ length: n }, () => ({ outcome, at: now }));
const scoreAfter = (n) => reputation(tasks(n), now).score;

test("everyone starts at 60", () => {
  const rep = reputation([], now);
  assert.equal(rep.score, 60);
  assert.equal(rep.label, "New volunteer");
});

test("3–4 good tasks gets you to about 80", () => {
  assert.ok(scoreAfter(3) >= 77 && scoreAfter(3) < 80, `3 tasks: ${scoreAfter(3)}`);
  assert.ok(scoreAfter(4) >= 80 && scoreAfter(4) < 84, `4 tasks: ${scoreAfter(4)}`);
});

test("80 → 95 takes many more tasks than 60 → 80", () => {
  const tasksToReach = (target) => {
    let n = 0;
    while (scoreAfter(n) < target) n++;
    return n;
  };
  const to80 = tasksToReach(80);
  const to95 = tasksToReach(95);
  assert.ok(to95 - to80 >= 4 * to80, `60→80: ${to80} tasks, 80→95: ${to95 - to80} tasks`);
  assert.ok(to95 >= 18 && to95 <= 25, `95 took ${to95} tasks`);
});

test("each extra task is worth less than the one before", () => {
  const gains = [1, 2, 5, 10, 20].map((n) => scoreAfter(n) - scoreAfter(n - 1));
  gains.slice(1).forEach((g, i) => assert.ok(g < gains[i]));
});

test("a no-show costs a lot: more than three good tasks earned at 80+", () => {
  const before = reputation(tasks(10), now).score;
  const after = reputation([...tasks(10), { outcome: "no_show", at: now }], now).score;
  assert.ok(before - after >= 15, `dropped ${before - after}`);
  assert.ok(after < scoreAfter(4), "one no-show undoes most of the progress past 80");
});

test("slip-ups slow down the consistency points", () => {
  const clean = reputation(tasks(12), now).parts;
  const slipped = reputation([...tasks(12), { outcome: "cancelled_late", at: daysAgo(170) }], now).parts;
  assert.ok(slipped.followThrough < 1);
  assert.ok(slipped.steady < clean.steady);
});

test("repeated no-shows drop a new volunteer below the starting score", () => {
  const rep = reputation(tasks(2, "no_show"), now);
  assert.ok(rep.score < 40);
  assert.equal(rep.label, "Mixed history");
});

test("old events count less than recent ones", () => {
  assert.ok(decayWeight(daysAgo(90), now) < decayWeight(daysAgo(1), now));
  assert.equal(decayWeight(daysAgo(90), now).toFixed(2), "0.50");
});

test("a recent no-show hurts more than an old one", () => {
  const steady = Array.from({ length: 5 }, (_, i) => ({ outcome: "completed", at: daysAgo(10 + i) }));
  const recentMiss = reputation([...steady, { outcome: "no_show", at: daysAgo(1) }], now);
  const oldMiss = reputation([...steady, { outcome: "no_show", at: daysAgo(300) }], now);
  assert.ok(recentMiss.score < oldMiss.score);
});

test("a run of recent completions earns 'Very reliable'", () => {
  const history = Array.from({ length: 15 }, (_, i) => ({ outcome: "completed", at: daysAgo(i * 3) }));
  assert.equal(reputation(history, now).label, "Very reliable");
});

// ---------- lifecycle ----------

test("accepting re-checks safety rules (minor can't accept in-home)", () => {
  const minor = volunteer({ isMinor: true, guardianContact: "x" });
  assert.throws(() => acceptRequest(minor, request({ taskType: "tech_help" }), now), /under-18/);
});

test("a request can't be accepted twice", () => {
  const r = request();
  acceptRequest(volunteer(), r, now);
  assert.throws(() => acceptRequest(volunteer(), r, now), /not open/);
});

test("only the requester can confirm completion", () => {
  const v = volunteer();
  const r = acceptRequest(v, request(), now);
  assert.throws(() => completeRequest(r, v, { confirmedBy: v.id }, now), /requester/);
  completeRequest(r, v, { confirmedBy: "r" }, now);
  assert.equal(r.status, "completed");
  assert.equal(v.history.length, 1);
});

test("completing a task raises reputation", () => {
  const v = volunteer();
  const before = reputation(v.history, now).score;
  completeRequest(acceptRequest(v, request(), now), v, { confirmedBy: "r" }, now);
  assert.ok(reputation(v.history, now).score > before);
});

test("a no-show reopens the request and is recorded", () => {
  const v = volunteer();
  const r = acceptRequest(v, request(), now);
  reportNoShow(r, v, { reportedBy: "r" }, now);
  assert.equal(r.status, "open");
  assert.equal(v.history[0].outcome, "no_show");
});

test("cancelling with notice is free; cancelling late is recorded", () => {
  const early = volunteer();
  cancelAcceptance(acceptRequest(early, request(), now), early, now); // 24h notice
  assert.equal(early.history.length, 0);

  const late = volunteer();
  const r = request({ window: { start: hours(2), end: hours(5) } });
  cancelAcceptance(acceptRequest(late, r, now), late, now); // 2h notice
  assert.equal(late.history[0].outcome, "cancelled_late");
});

test("anti-collusion: only 2 tasks per neighbor per 30 days count", () => {
  const forFriend = (daysAgoN) => ({ outcome: "completed", at: daysAgo(daysAgoN), requesterId: "friend" });
  const farmed = reputation([forFriend(1), forFriend(2), forFriend(3), forFriend(4), forFriend(5)], now);
  const honest = reputation([forFriend(5), forFriend(4)], now); // the first two are the ones that count
  assert.equal(farmed.score, honest.score);
  assert.equal(farmed.uncounted, 3);
  // ...but helping the same neighbor again next month counts.
  const later = reputation([forFriend(1), forFriend(2), forFriend(40)], now);
  assert.equal(later.uncounted, 0);
});

test("completing a task records who asked, so the cap can apply", () => {
  const v = volunteer();
  completeRequest(acceptRequest(v, request(), now), v, { confirmedBy: "r" }, now);
  assert.equal(v.history[0].requesterId, "r");
});
