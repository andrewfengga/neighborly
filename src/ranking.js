// The matching engine. Two stages:
//
//   1. ELIGIBILITY (hard rules) — may this volunteer see this request at all?
//      Same trust circle, within their travel distance, available during the
//      request window, and allowed by the under-18 safety rules.
//
//   2. SCORING (soft ranking) — of the eligible requests, which matter most
//      for THIS volunteer right now? A weighted mix of urgency, distance,
//      and skill fit. Every score comes with its breakdown, so the app can
//      always explain WHY a request ranked where it did.

import { distanceMiles } from "./geo.js";
import { settingOf, MINOR_ALLOWED_SETTINGS } from "./tasks.js";

// How much each factor counts. They add up to 1, so a score is 0–1.
export const WEIGHTS = { urgency: 0.45, distance: 0.3, skill: 0.25 };

// Urgency halves every this-many hours of lead time.
// A request due in 24h is about half as urgent as one due right now.
const URGENCY_HALF_LIFE_HOURS = 24;
const HOUSEBOUND_BOOST = 0.25;

const HOUR_MS = 60 * 60 * 1000;

// ---------- Stage 1: eligibility ----------

function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** Returns { ok: true } or { ok: false, reason } — reasons help debugging and testing. */
export function checkEligibility(volunteer, request, now = new Date()) {
  if (request.status !== "open") return { ok: false, reason: "not open" };
  if (request.requesterId === volunteer.id) return { ok: false, reason: "own request" };
  if (request.window.end <= now) return { ok: false, reason: "expired" };

  if (!volunteer.circleIds.includes(request.circleId)) {
    return { ok: false, reason: "different trust circle" };
  }

  const setting = request.setting ?? settingOf(request.taskType);
  if (volunteer.isMinor && !MINOR_ALLOWED_SETTINGS.has(setting)) {
    return { ok: false, reason: `under-18 volunteers can't take ${setting} tasks` };
  }

  const miles = distanceMiles(volunteer.location, request.location);
  if (miles > volunteer.maxDistanceMiles) return { ok: false, reason: "too far" };

  if (!volunteer.availability.some((slot) => overlaps(slot, request.window))) {
    return { ok: false, reason: "not available then" };
  }

  return { ok: true, miles };
}

// ---------- Stage 2: scoring ----------

/** 1.0 = due now, decays toward 0 as the deadline gets further away. */
export function urgencyScore(request, now = new Date()) {
  const hoursLeft = Math.max(0, (request.window.end - now) / HOUR_MS);
  const timePressure = Math.pow(0.5, hoursLeft / URGENCY_HALF_LIFE_HOURS);
  const boost = request.housebound ? HOUSEBOUND_BOOST : 0;
  return Math.min(1, timePressure + boost);
}

/** 1.0 = right next door, 0 = at the edge of the volunteer's range. */
export function distanceScore(miles, maxMiles) {
  return Math.max(0, 1 - miles / maxMiles);
}

/**
 * Skills only change the order, never what you can see: full credit for a
 * listed skill (or for everything, if you're up for anything), partial
 * credit otherwise.
 */
export function skillScore(volunteer, request) {
  if (volunteer.anything) return 1;
  return volunteer.skills.has(request.taskType) ? 1 : 0.3;
}

/** Score one request for one volunteer, with the breakdown attached. */
export function scoreRequest(volunteer, request, miles, now = new Date()) {
  const parts = {
    urgency: urgencyScore(request, now),
    distance: distanceScore(miles, volunteer.maxDistanceMiles),
    skill: skillScore(volunteer, request),
  };
  const total =
    WEIGHTS.urgency * parts.urgency +
    WEIGHTS.distance * parts.distance +
    WEIGHTS.skill * parts.skill;
  return { total, parts, miles };
}

/** Human-readable reason, e.g. for the "why am I seeing this?" line in the UI. */
export function explain(request, scored, now = new Date(), volunteer = null) {
  const hoursLeft = Math.round((request.window.end - now) / HOUR_MS);
  const bits = [
    hoursLeft <= 36 ? `needed within ${hoursLeft}h` : `due in ${Math.round(hoursLeft / 24)} days`,
    scored.miles < 0.1 ? "right nearby" : `${scored.miles.toFixed(1)} mi away`,
    volunteer?.anything ? "you're up for anything" : scored.parts.skill === 1 ? "one of your best skills" : "not one of your top skills",
  ];
  if (request.housebound) bits.unshift("requester is housebound");
  return bits.join(" · ");
}

/** The main entry point: a volunteer's personal, ranked board. */
export function rankForVolunteer(volunteer, requests, now = new Date()) {
  const ranked = [];
  for (const request of requests) {
    const check = checkEligibility(volunteer, request, now);
    if (!check.ok) continue;
    const scored = scoreRequest(volunteer, request, check.miles, now);
    ranked.push({ request, ...scored, why: explain(request, scored, now, volunteer) });
  }
  return ranked.sort((a, b) => b.total - a.total);
}
