// Run with: npm test
// Quick-post parsing, availability slots, and pilot metrics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseQuickPost, scopeCheck } from "../src/parse.js";
import { expandSlots } from "../src/availability.js";
import { circleMetrics, impactSentence } from "../src/metrics.js";

// Wednesday, Oct 7 2026, 9am local time.
const wed = new Date(2026, 9, 7, 9);

// ---------- quick post ----------

test("understands a typical grocery request", () => {
  const p = parseQuickPost("Need help carrying groceries in Saturday morning", wed);
  assert.equal(p.taskType, "groceries");
  assert.equal(p.window.start.getDay(), 6);
  assert.equal(p.window.start.getHours(), 8);
  assert.equal(p.window.end.getHours(), 12);
});

test("'appointment' is a ride, not tech help", () => {
  assert.equal(parseQuickPost("Ride to my doctor appointment tomorrow", wed).taskType, "ride");
});

test("detects housebound requesters", () => {
  assert.equal(parseQuickPost("I'm recovering from surgery, need groceries", wed).housebound, true);
  assert.equal(parseQuickPost("need groceries", wed).housebound, false);
});

test("'no rush' gives a long window; 'asap' a short one", () => {
  const relaxed = parseQuickPost("move a bookshelf, no rush", wed).window;
  const urgent = parseQuickPost("printer broke, need help asap", wed).window;
  assert.ok(relaxed.end - relaxed.start > 14 * 864e5);
  assert.ok(urgent.end - urgent.start <= 4 * 3600e3);
});

test("blocks medical and personal-care requests", () => {
  assert.equal(scopeCheck("help with my insulin injection").ok, false);
  assert.equal(scopeCheck("help me bathe").ok, false);
  assert.equal(scopeCheck("rake my leaves").ok, true);
});

// ---------- availability ----------

test("weekend mornings expand to Saturday/Sunday 8–12 only", () => {
  const windows = expandSlots(["weekend_mornings"], wed, 7);
  assert.equal(windows.length, 2);
  for (const w of windows) {
    assert.ok([0, 6].includes(w.start.getDay()));
    assert.equal(w.start.getHours(), 8);
  }
});

test("past slots today are dropped", () => {
  const evening = new Date(2026, 9, 7, 22);
  assert.ok(expandSlots(["anytime"], evening, 1).length === 0);
});

// ---------- metrics ----------

const at = (h) => new Date(wed.getTime() + h * 3600e3).toISOString();

test("match rate and median time come from real timestamps", () => {
  const m = circleMetrics([
    { taskType: "groceries", createdAt: at(0), firstAcceptedAt: at(1), status: "completed" },
    { taskType: "ride", createdAt: at(0), firstAcceptedAt: at(3), status: "completed" },
    { taskType: "ride", createdAt: at(0), firstAcceptedAt: at(30), status: "accepted" },
    { taskType: "tech_help", createdAt: at(0), firstAcceptedAt: null, status: "open" },
  ]);
  assert.equal(m.posted, 4);
  assert.equal(m.matched, 3);
  assert.equal(m.matchedWithin, 2); // within 24h
  assert.equal(m.medianHoursToMatch, 3);
  assert.equal(m.completed, 2);
  assert.match(impactSentence(m), /4 real requests.*50% were matched/);
});

test("no data means no claim", () => {
  assert.match(impactSentence(circleMetrics([])), /No requests yet/);
});
