// A request's life: open → accepted → completed (or back to open).
//
// Safety rules live here as well as in ranking.js. Hiding a request from a
// board isn't enough on its own; accepting must re-check eligibility, so a
// minor can't take an in-home task through a stale screen or a direct API call.
//
// Only the REQUESTER can mark a task completed. That keeps volunteers from
// giving themselves reputation.

import { checkEligibility } from "./ranking.js";

// Backing out with less than this much notice counts against reputation.
const LATE_CANCEL_HOURS = 12;
const HOUR_MS = 60 * 60 * 1000;

export function acceptRequest(volunteer, request, now = new Date()) {
  const check = checkEligibility(volunteer, request, now);
  if (!check.ok) throw new Error(`Can't accept: ${check.reason}`);
  request.status = "accepted";
  request.acceptedBy = volunteer.id;
  request.acceptedAt = now;
  request.firstAcceptedAt ??= now; // for pilot metrics: time until first match
  return request;
}

export function completeRequest(request, volunteer, { confirmedBy }, now = new Date()) {
  assertAcceptedBy(request, volunteer);
  if (confirmedBy !== request.requesterId) {
    throw new Error("Only the requester can confirm a task was completed");
  }
  request.status = "completed";
  request.completedAt = now;
  volunteer.history.push({ outcome: "completed", at: now, requestId: request.id, requesterId: request.requesterId });
  return request;
}

/** Requester reports the volunteer never came. The request reopens for others. */
export function reportNoShow(request, volunteer, { reportedBy }, now = new Date()) {
  assertAcceptedBy(request, volunteer);
  if (reportedBy !== request.requesterId) {
    throw new Error("Only the requester can report a no-show");
  }
  volunteer.history.push({ outcome: "no_show", at: now, requestId: request.id, requesterId: request.requesterId });
  reopen(request);
  return request;
}

/** Volunteer backs out. Free with enough notice; a late cancel is recorded. */
export function cancelAcceptance(request, volunteer, now = new Date()) {
  assertAcceptedBy(request, volunteer);
  const hoursUntilStart = (request.window.start - now) / HOUR_MS;
  if (hoursUntilStart < LATE_CANCEL_HOURS) {
    volunteer.history.push({ outcome: "cancelled_late", at: now, requestId: request.id });
  }
  reopen(request);
  return request;
}

function assertAcceptedBy(request, volunteer) {
  if (request.status !== "accepted" || request.acceptedBy !== volunteer.id) {
    throw new Error("This volunteer hasn't accepted this request");
  }
}

function reopen(request) {
  request.status = "open";
  request.acceptedBy = null;
  request.acceptedAt = null;
}
