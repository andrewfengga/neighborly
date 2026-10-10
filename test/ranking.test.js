// Run with: npm test
// These tests are your proof (to yourself and to judges) that the rules work.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequest, createVolunteer } from "../src/models.js";
import { checkEligibility, rankForVolunteer, urgencyScore } from "../src/ranking.js";

const now = new Date("2026-10-10T09:00:00");
const hours = (h) => new Date(now.getTime() + h * 3600 * 1000);
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
    window: { start: hours(1), end: hours(5) }, ...extra,
  });

test("minors must have a guardian contact", () => {
  assert.throws(() => volunteer({ isMinor: true }), /guardian/);
});

test("minors cannot see in-home or vehicle tasks", () => {
  const minor = volunteer({ isMinor: true, guardianContact: "x" });
  assert.equal(checkEligibility(minor, request({ taskType: "tech_help" }), now).ok, false);
  assert.equal(checkEligibility(minor, request({ taskType: "ride" }), now).ok, false);
  assert.equal(checkEligibility(minor, request({ taskType: "groceries" }), now).ok, true);
});

test("requests outside your trust circle are hidden", () => {
  const r = request({ circleId: "some_other_group" });
  assert.equal(checkEligibility(volunteer(), r, now).reason, "different trust circle");
});

test("requests beyond travel distance are hidden", () => {
  const r = request({ location: { lat: 34.3, lng: -84.0 } });
  assert.equal(checkEligibility(volunteer(), r, now).reason, "too far");
});

test("exact locations are rounded for privacy", () => {
  const r = request({ location: { lat: 34.07531, lng: -84.29412 } });
  assert.deepEqual(r.location, { lat: 34.08, lng: -84.29 });
});

test("sooner deadlines are more urgent", () => {
  assert.ok(urgencyScore(request(), now) > urgencyScore(request({ window: { start: hours(1), end: hours(72) } }), now));
});

test("housebound requester gets an urgency boost", () => {
  assert.ok(urgencyScore(request({ housebound: true }), now) > urgencyScore(request(), now));
});

test("urgent housebound request outranks a relaxed one", () => {
  const urgent = request({ housebound: true });
  const relaxed = request({ window: { start: hours(1), end: hours(24 * 6) } });
  const board = rankForVolunteer(volunteer(), [relaxed, urgent], now);
  assert.equal(board[0].request.id, urgent.id);
  assert.match(board[0].why, /housebound/);
});
