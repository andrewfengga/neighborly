// The two core objects: a help Request and a Volunteer.
// Factory functions validate input so bad data fails loudly and early.

import { TASK_TYPES } from "./tasks.js";
import { toNeighborhoodLevel } from "./geo.js";

// Random ids, so they stay unique across server restarts.
export const makeId = (prefix) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/**
 * A request for help.
 *  - window: when the help is needed { start, end } as Date objects.
 *    "end" is the deadline; the closer it is, the more urgent.
 *  - housebound: requester can't easily get out — boosts urgency.
 *  - circleId: which trust circle (church, school club...) can see it.
 *  - onBehalfOf: first name of a neighbor this was posted for (someone who
 *    doesn't use the app). The poster is still the requester who confirms.
 *  - contactPhone: shown only to the volunteer who accepts.
 */
export function createRequest({
  requesterId,
  circleId,
  taskType,
  description = "",
  location,
  window,
  housebound = false,
  privateDetails = "",
  contactPhone = "",
  onBehalfOf = "",
  createdAt = new Date(),
}) {
  if (!TASK_TYPES[taskType]) throw new Error(`Unknown task type: ${taskType}`);
  if (!location) throw new Error("Request needs a location");
  if (!window?.start || !window?.end || window.end <= window.start) {
    throw new Error("Request needs a valid time window (end after start)");
  }
  return {
    id: makeId("req"),
    requesterId,
    circleId,
    taskType,
    description,
    location: toNeighborhoodLevel(location), // never store the exact spot
    window,
    housebound,
    privateDetails, // e.g. exact address; shown only to the volunteer who accepts
    contactPhone, // same: only the volunteer who accepts
    onBehalfOf,
    status: "open", // open → accepted → completed (or cancelled)
    acceptedBy: null,
    createdAt,
  };
}

/**
 * A volunteer.
 *  - isMinor: under 18. Minors must have a guardian contact on file and
 *    can only accept doorstep/outdoor tasks (see tasks.js).
 *  - skills: task types they're good at / want to do.
 *  - availability: list of { start, end } windows when they're free.
 *  - maxDistanceMiles: how far they're willing to go.
 *  - history: [{ outcome, at }] events that feed reputation.js.
 */
export function createVolunteer({
  id = makeId("vol"),
  name,
  circleIds,
  location,
  isMinor = false,
  guardianContact = null,
  skills = [],
  availability = [],
  maxDistanceMiles = 3,
  history = [],
}) {
  if (isMinor && !guardianContact) {
    throw new Error("Volunteers under 18 need a guardian contact on file");
  }
  for (const s of skills) {
    if (!TASK_TYPES[s]) throw new Error(`Unknown skill: ${s}`);
  }
  return {
    id,
    name,
    circleIds,
    location: toNeighborhoodLevel(location),
    isMinor,
    guardianContact,
    skills: new Set(skills),
    availability,
    maxDistanceMiles,
    history, // past outcomes; see reputation.js
  };
}
