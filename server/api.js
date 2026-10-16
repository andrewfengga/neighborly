// Every action the app can take, as plain functions over the database.
// The HTTP layer (index.js) only handles auth and JSON; all rules live here
// or in src/, so nothing depends on the browser behaving.
//
// Data model:
//   people       one account each: profile, home location, reputation history
//   circles      neighborhoods: name, city/state, center, private or listed
//   memberships  person × circle: role (organizer/member) and status
//                (active, pending, denied, removed, left)
//   requests     help requests, each inside one circle
//   reports      private safety reports to a circle's organizers
//   activity     what happened to each request, for the organizer's feed

import crypto from "node:crypto";
import { createRequest, createVolunteer, makeId } from "../src/models.js";
import { checkEligibility, rankForVolunteer } from "../src/ranking.js";
import { acceptRequest, cancelAcceptance, completeRequest, reportNoShow } from "../src/lifecycle.js";
import { reputation } from "../src/reputation.js";
import { expandSlots, SLOTS } from "../src/availability.js";
import { scopeCheck } from "../src/parse.js";
import { circleMetrics, impactSentence } from "../src/metrics.js";
import { TASK_TYPES, MINOR_ALLOWED_SETTINGS } from "../src/tasks.js";
import { distanceMiles, toNeighborhoodLevel } from "../src/geo.js";
import { US_STATES } from "../src/states.js";

const MAX_OPEN_REQUESTS = 5;
const MAX_DAYS_AHEAD = 30;
const MAX_CIRCLES_CREATED = 3;
const MAX_PENDING_JOINS = 5;
const APPEAL_WINDOW_DAYS = 14;
const MAX_APPEAL_IMAGES = 3;
const MAX_IMAGE_BYTES = 700 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const fail = (message, status) => {
  throw new ApiError(message, status);
};

const text = (value, max, field) => {
  const s = String(value ?? "").trim();
  if (s.length > max) fail(`${field} is too long (max ${max} characters)`);
  return s;
};

const firstName = (name) => name.split(" ")[0];

/** Accepts {lat, lng}; stores it rounded so no exact home is ever saved. */
function cleanLocation(loc) {
  if (loc == null) return null;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng);
  if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) fail("That location doesn't look right");
  return toNeighborhoodLevel({ lat, lng });
}

// Invite keys: short, easy to read aloud, no look-alike characters (0/O, 1/I).
const KEY_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newInviteKey(db) {
  for (;;) {
    const bytes = crypto.randomBytes(6);
    const raw = [...bytes].map((b) => KEY_CHARS[b % KEY_CHARS.length]).join("");
    const key = `${raw.slice(0, 3)}-${raw.slice(3)}`;
    if (!db.circles.some((c) => c.inviteKey === key)) return key;
  }
}
const normalizeKey = (k) => String(k ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

// ---------- lookups ----------

export function personByToken(db, token) {
  return token ? db.people.find((p) => p.token === token) ?? null : null;
}

const personById = (db, id) => db.people.find((p) => p.id === id);
const circleById = (db, id) => db.circles.find((c) => c.id === id);
const membership = (db, personId, circleId) =>
  db.memberships.find((m) => m.personId === personId && m.circleId === circleId);

const activeMemberships = (db, person) =>
  db.memberships.filter((m) => m.personId === person.id && m.status === "active");
const activeCircleIds = (db, person) => activeMemberships(db, person).map((m) => m.circleId);

function requireMember(db, person, circleId) {
  const m = membership(db, person.id, circleId);
  if (!m || m.status !== "active") fail("You're not a member of that neighborhood", 403);
  return m;
}

function requireOrganizer(db, person, circleId) {
  const m = requireMember(db, person, circleId);
  if (m.role !== "organizer") fail("Only this neighborhood's organizers can do that", 403);
  return m;
}

function requestInMyCircles(db, me, id) {
  const r = db.requests.find((x) => x.id === id);
  if (!r || !activeCircleIds(db, me).includes(r.circleId)) fail("Request not found", 404);
  return r;
}


// ---------- stored JSON ⇄ engine objects ----------

function toVolunteer(db, person, now) {
  if (!person.location) fail("Set your location in Me before volunteering");
  return createVolunteer({
    id: person.id,
    name: person.name,
    circleIds: activeCircleIds(db, person),
    location: person.location,
    isMinor: person.isMinor,
    guardianContact: person.guardianContact,
    skills: person.skills,
    availability: expandSlots(person.slots, now),
    maxDistanceMiles: person.maxDistanceMiles,
    history: person.history.map((e) => ({ ...e, at: new Date(e.at) })),
  });
}

const dateOrNull = (v) => (v ? new Date(v) : null);

function hydrate(r) {
  return {
    ...r,
    window: { start: new Date(r.window.start), end: new Date(r.window.end) },
    createdAt: new Date(r.createdAt),
    acceptedAt: dateOrNull(r.acceptedAt),
    firstAcceptedAt: dateOrNull(r.firstAcceptedAt),
  };
}

function store(db, request) {
  const plain = JSON.parse(JSON.stringify(request));
  const i = db.requests.findIndex((r) => r.id === plain.id);
  if (i === -1) db.requests.push(plain);
  else db.requests[i] = plain;
}

/** Append to the organizer activity log. Never holds private details or phone numbers. */
function log(db, { circleId, requestId = null, type, actorId = null, subjectId = null, at, detail = {} }) {
  db.activity.push({ id: makeId("ev"), circleId, requestId, type, actorId, subjectId, at: new Date(at).toISOString(), detail });
}

function saveHistory(person, volunteer) {
  person.history = JSON.parse(JSON.stringify(volunteer.history));
}

function repOf(person, now) {
  const rep = reputation(person.history.map((e) => ({ ...e, at: new Date(e.at) })), now);
  return { ...rep, score: Math.round(rep.score) };
}

// ---------- what each viewer may see ----------
// The board never shows private details, full names, or locations — only
// a distance. Exact details go only to the one volunteer who accepted.

function publicView(db, r) {
  const requester = personById(db, r.requesterId);
  const circle = circleById(db, r.circleId);
  return {
    id: r.id,
    circleId: r.circleId,
    circleName: circle?.name ?? "",
    taskType: r.taskType,
    taskLabel: TASK_TYPES[r.taskType].label,
    setting: TASK_TYPES[r.taskType].setting,
    description: r.description,
    window: r.window,
    housebound: r.housebound,
    status: r.status,
    createdAt: r.createdAt,
    requesterName: requester ? firstName(requester.name) : "Neighbor",
    onBehalfOf: r.onBehalfOf || "",
  };
}

/** Shown to a requester about the volunteer who accepted their request. */
function volunteerSummary(db, id, now) {
  const v = personById(db, id);
  if (!v) return null;
  return {
    id: v.id,
    name: firstName(v.name),
    isMinor: v.isMinor,
    phone: v.phone || "",
    // When a minor helps, the adult they're helping can reach their parent too.
    guardianContact: v.isMinor ? v.guardianContact : null,
    reputation: repOf(v, now),
  };
}

const PHONE = /^[0-9+()\-.\s]{7,25}$/;
function phoneField(value, field) {
  const s = text(value, 25, field);
  if (s && !PHONE.test(s)) fail(`${field} should be a phone number`);
  return s;
}

// ---------- account ----------

export function signup(db, body, now) {
  const name = text(body.name, 40, "Name");
  if (!name) fail("Please enter your name");
  const isMinor = Boolean(body.isMinor);
  const guardianName = isMinor ? text(body.guardianName, 60, "Parent/guardian name") : "";
  const guardianPhone = isMinor ? phoneField(body.guardianPhone, "Parent/guardian phone") : "";
  if (isMinor && (!guardianName || !guardianPhone)) {
    fail("Members under 18 need a parent or guardian's name and phone number");
  }

  const person = {
    id: makeId("p"),
    token: crypto.randomBytes(24).toString("hex"),
    name,
    isMinor,
    guardianName: guardianName || null,
    guardianPhone: guardianPhone || null,
    // One readable line for everywhere the app shows it (organizers, requesters).
    guardianContact: isMinor ? `${guardianName}: ${guardianPhone}` : null,
    location: cleanLocation(body.location),
    volunteering: false,
    skills: [],
    slots: [],
    maxDistanceMiles: 2,
    history: [],
    joinedAt: now.toISOString(),
  };
  db.people.push(person);
  return { token: person.token };
}

export function me(db, person, { demo }, now) {
  const { token, ...rest } = person;
  const circles = db.memberships
    .filter((m) => m.personId === person.id && (m.status === "active" || m.status === "pending"))
    .map((m) => {
      const c = circleById(db, m.circleId);
      const organizer = m.role === "organizer" && m.status === "active";
      const pending = organizer ? db.memberships.filter((x) => x.circleId === c.id && x.status === "pending").length : 0;
      const appeals = organizer ? db.appeals.filter((a) => a.circleId === c.id && a.status === "pending").length : 0;
      // Things other people did since this organizer last opened the feed.
      const newActivity = organizer
        ? db.activity.filter((e) => e.circleId === c.id && e.actorId !== person.id
            && (!m.lastSeenActivityAt || new Date(e.at) > new Date(m.lastSeenActivityAt))).length
        : 0;
      return { id: c.id, name: c.name, city: c.city, state: c.state, visibility: c.visibility, role: m.role, status: m.status, pending, appeals, newActivity };
    });
  return { person: rest, reputation: repOf(person, now), circles, demo };
}

export function updateProfile(db, person, body) {
  const skills = Array.isArray(body.skills) ? body.skills : person.skills;
  for (const s of skills) {
    if (!TASK_TYPES[s]) fail(`Unknown skill: ${s}`);
    if (person.isMinor && !MINOR_ALLOWED_SETTINGS.has(TASK_TYPES[s].setting)) {
      fail(`Under-18 members can't sign up for ${TASK_TYPES[s].label.toLowerCase()}`);
    }
  }
  const slots = Array.isArray(body.slots) ? body.slots : person.slots;
  for (const s of slots) if (!SLOTS[s]) fail(`Unknown availability: ${s}`);
  const miles = Number(body.maxDistanceMiles ?? person.maxDistanceMiles);
  if (!(miles >= 0.5 && miles <= 10)) fail("Travel distance must be between 0.5 and 10 miles");

  let location = person.location;
  if (body.location !== undefined) location = cleanLocation(body.location);
  if (body.locationFromCircle) location = { ...circleById(db, requireMember(db, person, body.locationFromCircle).circleId).center };

  const volunteering = body.volunteering ?? person.volunteering;
  if (volunteering && !location) fail("Set your location so we can show requests near you");
  const phone = body.phone !== undefined ? phoneField(body.phone, "Phone") : person.phone ?? "";

  Object.assign(person, { volunteering, skills, slots, maxDistanceMiles: miles, location, phone });
  return { ok: true };
}

// ---------- neighborhoods ----------

export function createCircle(db, person, body, now) {
  const name = text(body.name, 60, "Neighborhood name");
  const city = text(body.city, 40, "City");
  const state = String(body.state ?? "").toUpperCase();
  if (!name) fail("Give your neighborhood a name");
  if (!city) fail("Which city is it in?");
  if (!US_STATES[state]) fail("Pick a state");
  if (!["private", "listed"].includes(body.visibility)) fail("Choose private or listed");
  const center = cleanLocation(body.location) ?? person.location;
  if (!center) fail("Use your location so neighbors can find this neighborhood by distance");

  const created = db.circles.filter((c) => c.createdBy === person.id).length;
  if (created >= MAX_CIRCLES_CREATED) fail(`You can create up to ${MAX_CIRCLES_CREATED} neighborhoods`);
  const dupe = db.circles.find(
    (c) => c.name.toLowerCase() === name.toLowerCase() && c.city.toLowerCase() === city.toLowerCase() && c.state === state
  );
  if (dupe) fail(`There's already a "${name}" in ${city}, ${state}. Try searching for it, or pick a different name.`);

  const circle = {
    id: makeId("c"),
    name,
    city,
    state,
    description: text(body.description, 200, "Description"),
    visibility: body.visibility,
    center,
    inviteKey: newInviteKey(db),
    createdBy: person.id,
    createdAt: now.toISOString(),
  };
  db.circles.push(circle);
  db.memberships.push({ personId: person.id, circleId: circle.id, role: "organizer", status: "active", joinedAt: now.toISOString() });
  if (!person.location) person.location = center;
  return { id: circle.id, inviteKey: circle.inviteKey };
}

/** Listed neighborhoods only. Private ones never appear in search. */
export function searchCircles(db, person, query) {
  const q = String(query.get("q") ?? "").trim().toLowerCase();
  const state = String(query.get("state") ?? "").toUpperCase();
  const within = Number(query.get("within")) || null;
  const from = person.location;

  return db.circles
    .filter((c) => c.visibility === "listed")
    .filter((c) => !state || c.state === state)
    .filter((c) => !q || `${c.name} ${c.city} ${c.state} ${US_STATES[c.state]}`.toLowerCase().includes(q))
    .map((c) => {
      const miles = from ? distanceMiles(from, c.center) : null;
      const mine = membership(db, person.id, c.id);
      return {
        id: c.id,
        name: c.name,
        city: c.city,
        state: c.state,
        description: c.description,
        members: db.memberships.filter((m) => m.circleId === c.id && m.status === "active").length,
        miles: miles === null ? null : Math.round(miles * 10) / 10,
        myStatus: mine?.status ?? null,
      };
    })
    .filter((c) => !within || (c.miles !== null && c.miles <= within))
    .sort((a, b) => (a.miles ?? Infinity) - (b.miles ?? Infinity) || a.name.localeCompare(b.name))
    .slice(0, 50);
}

/** Before signing up from an invite link: which neighborhood is this key for? */
export function previewKey(db, rawKey) {
  const key = normalizeKey(rawKey);
  const circle = key && db.circles.find((c) => normalizeKey(c.inviteKey) === key);
  if (!circle) fail("That invite link has expired or is wrong. Ask for a new one.", 404);
  return { name: circle.name, city: circle.city, state: circle.state };
}

/** An invite key works for private and listed neighborhoods, and skips approval. */
export function joinWithKey(db, person, body, now) {
  const key = normalizeKey(body.key);
  const circle = db.circles.find((c) => normalizeKey(c.inviteKey) === key);
  if (!key || !circle) fail("That key doesn't match any neighborhood. Check it with whoever gave it to you.");
  const existing = membership(db, person.id, circle.id);
  if (existing?.status === "active") fail(`You're already in ${circle.name}`);
  if (existing?.status === "removed") fail(`An organizer removed you from ${circle.name}`);
  if (existing) Object.assign(existing, { status: "active", joinedAt: now.toISOString() });
  else db.memberships.push({ personId: person.id, circleId: circle.id, role: "member", status: "active", joinedAt: now.toISOString() });
  if (!person.location) person.location = { ...circle.center };
  return { id: circle.id, name: circle.name };
}

/** Ask to join a listed neighborhood; an organizer has to approve. */
export function requestToJoin(db, person, circleId, body, now) {
  const circle = circleById(db, circleId);
  if (!circle || circle.visibility !== "listed") fail("Neighborhood not found", 404);
  const existing = membership(db, person.id, circle.id);
  if (existing?.status === "active") fail(`You're already in ${circle.name}`);
  if (existing?.status === "pending") fail("Your request is already waiting for an organizer");
  if (existing?.status === "removed" || existing?.status === "denied") {
    fail(`You can't request to join ${circle.name} again. Ask an organizer for an invite key.`);
  }
  const pending = db.memberships.filter((m) => m.personId === person.id && m.status === "pending").length;
  if (pending >= MAX_PENDING_JOINS) fail(`You can have up to ${MAX_PENDING_JOINS} requests waiting at once`);

  const note = text(body.note, 200, "Note");
  const fields = { status: "pending", note, requestedAt: now.toISOString() };
  if (existing) Object.assign(existing, fields);
  else db.memberships.push({ personId: person.id, circleId: circle.id, role: "member", ...fields });
  return { status: "pending" };
}

export function circleDetail(db, person, circleId, now) {
  const circle = circleById(db, circleId);
  if (!circle) fail("Neighborhood not found", 404);
  const mine = requireMember(db, person, circleId);
  const memberships = db.memberships.filter((m) => m.circleId === circleId);
  const active = memberships.filter((m) => m.status === "active");

  const detail = {
    id: circle.id,
    name: circle.name,
    city: circle.city,
    state: circle.state,
    description: circle.description,
    visibility: circle.visibility,
    role: mine.role,
    members: active.length,
    volunteers: active.filter((m) => personById(db, m.personId)?.volunteering).length,
  };
  if (mine.role !== "organizer") return detail;

  const describe = (m) => {
    const p = personById(db, m.personId);
    return {
      id: p.id, name: p.name, isMinor: p.isMinor, guardianContact: p.guardianContact,
      role: m.role, volunteering: p.volunteering, reputation: repOf(p, now),
      joinedAt: m.joinedAt, note: m.note, requestedAt: m.requestedAt,
    };
  };
  return {
    ...detail,
    inviteKey: circle.inviteKey,
    people: active.map(describe),
    pendingPeople: memberships.filter((m) => m.status === "pending").map(describe),
    reports: db.reports
      .filter((r) => r.circleId === circleId)
      .map((r) => ({ ...r, fromName: personById(db, r.from)?.name ?? "Unknown" }))
      .reverse(),
    // Pending first, then newest.
    appeals: db.appeals
      .filter((a) => a.circleId === circleId)
      .map((a) => ({ ...appealForOrganizer(db, a, now), conflict: a.volunteerId === person.id || a.requesterId === person.id }))
      .sort((x, y) => (x.status === "pending") - (y.status === "pending") || new Date(x.createdAt) - new Date(y.createdAt))
      .reverse(),
  };
}

export function decideMember(db, person, circleId, targetId, decision, now) {
  requireOrganizer(db, person, circleId);
  const m = membership(db, targetId, circleId);
  if (!m) fail("Member not found", 404);

  if (decision === "approve" || decision === "deny") {
    if (m.status !== "pending") fail("That request was already handled");
    if (decision === "approve") Object.assign(m, { status: "active", joinedAt: now.toISOString() });
    else m.status = "denied";
    const p = personById(db, targetId);
    if (decision === "approve" && !p.location) p.location = { ...circleById(db, circleId).center };
    return { status: m.status };
  }

  if (decision === "remove") {
    if (targetId === person.id) fail("You can't remove yourself. Use Leave instead.");
    if (m.status !== "active") fail("They aren't an active member");
    m.status = "removed";
    releaseWork(db, targetId, circleId, now, "removed");
    return { status: "removed" };
  }
  fail("Unknown action", 404);
}

/** Someone left or was removed: withdraw their requests, free their tasks — in that circle only. */
function releaseWork(db, personId, circleId, now, reason) {
  for (const r of db.requests) {
    if (r.circleId !== circleId) continue;
    const event = { circleId, requestId: r.id, actorId: personId, at: now, detail: { reason } };
    if (r.requesterId === personId && (r.status === "open" || r.status === "accepted")) {
      r.status = "cancelled";
      log(db, { ...event, type: "withdrawn" });
    }
    if (r.acceptedBy === personId && r.status === "accepted") {
      Object.assign(r, { status: "open", acceptedBy: null, acceptedAt: null });
      log(db, { ...event, type: "released" });
    }
  }
}

export function leaveCircle(db, person, circleId, now = new Date()) {
  const m = requireMember(db, person, circleId);
  if (m.role === "organizer") {
    const others = db.memberships.filter((x) => x.circleId === circleId && x.status === "active" && x.personId !== person.id);
    const otherOrganizers = others.filter((x) => x.role === "organizer");
    if (others.length && !otherOrganizers.length) fail("You're the only organizer. Make someone else an organizer before leaving.");
  }
  m.status = "left";
  releaseWork(db, person.id, circleId, now, "left");
  return { ok: true };
}

export function makeOrganizer(db, person, circleId, targetId) {
  requireOrganizer(db, person, circleId);
  const m = membership(db, targetId, circleId);
  if (!m || m.status !== "active") fail("Member not found", 404);
  if (personById(db, targetId).isMinor) fail("Organizers need to be adults");
  m.role = "organizer";
  return { ok: true };
}

/** If a key leaks, the organizer makes a new one; the old one stops working. */
export function rotateKey(db, person, circleId) {
  requireOrganizer(db, person, circleId);
  const circle = circleById(db, circleId);
  circle.inviteKey = newInviteKey(db);
  return { inviteKey: circle.inviteKey };
}

// ---------- the volunteer board ----------

const QUIET_REASONS = new Set(["not open", "own request", "expired", "different trust circle"]);

export function board(db, person, now) {
  if (!person.volunteering) return { volunteering: false, items: [], hidden: {} };
  const volunteer = toVolunteer(db, person, now);
  const circleIds = new Set(volunteer.circleIds);
  const requests = db.requests.filter((r) => circleIds.has(r.circleId)).map(hydrate);

  const ranked = rankForVolunteer(volunteer, requests, now);

  // Transparency: tell the volunteer what they're NOT seeing, and why.
  const hidden = {};
  for (const r of requests) {
    const check = checkEligibility(volunteer, r, now);
    if (!check.ok && !QUIET_REASONS.has(check.reason)) {
      hidden[check.reason] = (hidden[check.reason] ?? 0) + 1;
    }
  }

  return {
    volunteering: true,
    circles: circleIds.size,
    items: ranked.map((item) => ({
      request: publicView(db, item.request),
      total: item.total,
      parts: item.parts,
      miles: item.miles,
      why: item.why,
    })),
    hidden,
  };
}

// ---------- requests ----------

export function postRequest(db, person, body, now) {
  requireMember(db, person, body.circleId);
  const circle = circleById(db, body.circleId);
  if (!TASK_TYPES[body.taskType]) fail("Pick what kind of help you need");
  const description = text(body.description, 280, "Description");
  if (!description) fail("Add a short description");
  const privateDetails = text(body.privateDetails, 200, "Private details");
  const contactPhone = phoneField(body.contactPhone, "Contact phone");
  const onBehalfOf = text(body.onBehalfOf, 40, "Name of the person you're asking for");
  const scope = scopeCheck(`${description} ${privateDetails}`);
  if (!scope.ok) fail(scope.reason);

  const open = db.requests.filter(
    (r) => r.requesterId === person.id && (r.status === "open" || r.status === "accepted")
  );
  if (open.length >= MAX_OPEN_REQUESTS) fail(`You can have up to ${MAX_OPEN_REQUESTS} active requests at once`);

  const start = new Date(Math.max(new Date(body.start).getTime(), now.getTime()));
  const end = new Date(body.end);
  if (isNaN(start) || isNaN(end)) fail("Pick when you need help");
  if (end - now > MAX_DAYS_AHEAD * DAY_MS) fail(`Requests can be up to ${MAX_DAYS_AHEAD} days ahead`);

  const request = createRequest({
    requesterId: person.id,
    circleId: circle.id,
    taskType: body.taskType,
    description,
    // Posting for someone else from their place? The app can use the poster's current spot.
    location: cleanLocation(body.location) ?? person.location ?? circle.center,
    window: { start, end },
    housebound: Boolean(body.housebound),
    privateDetails,
    contactPhone,
    onBehalfOf,
    createdAt: now,
  });
  store(db, request);
  log(db, { circleId: circle.id, requestId: request.id, type: "posted", actorId: person.id, at: now });
  return { id: request.id };
}

export function mine(db, person, now) {
  const posted = db.requests
    .filter((r) => r.requesterId === person.id)
    .map((r) => ({
      ...publicView(db, r),
      privateDetails: r.privateDetails,
      contactPhone: r.contactPhone ?? "",
      volunteer: r.acceptedBy ? volunteerSummary(db, r.acceptedBy, now) : null,
    }));
  // Everything you've helped with or committed to, including tasks where you
  // were reported as a no-show (the request itself reopened for others, so
  // your own history is what remembers it).
  const myEvents = new Map();
  for (const e of person.history) {
    if (e.requestId && (!myEvents.has(e.requestId) || new Date(e.at) > new Date(myEvents.get(e.requestId).at))) {
      myEvents.set(e.requestId, e);
    }
  }
  const accepted = [];
  for (const r of db.requests) {
    const event = myEvents.get(r.id);
    const mineNow = r.acceptedBy === person.id;
    let myStatus = null;
    if (mineNow && r.status === "accepted") myStatus = "active";
    else if (event?.outcome === "no_show") myStatus = event.overturned ? "no_show_overturned" : "no_show";
    else if (event?.outcome === "cancelled_late") myStatus = "cancelled_late";
    else if (event?.outcome === "completed" || (mineNow && r.status === "completed")) myStatus = "completed";
    if (!myStatus) continue;

    const appeal = db.appeals.find((a) => a.requestId === r.id && a.volunteerId === person.id);
    const eventAt = event?.at ?? r.completedAt ?? r.acceptedAt;
    accepted.push({
      ...publicView(db, r),
      myStatus,
      eventAt,
      // Private details only while the task is yours and still active.
      ...(myStatus === "active" ? { privateDetails: r.privateDetails, contactPhone: r.contactPhone ?? "" } : {}),
      appeal: appeal ? appealSummary(appeal) : null,
      canAppeal: myStatus === "no_show" && !appeal && now - new Date(event.at) < APPEAL_WINDOW_DAYS * DAY_MS,
    });
  }
  const newestFirst = (a, b) => new Date(b.eventAt ?? b.createdAt) - new Date(a.eventAt ?? a.createdAt);
  return { posted: posted.sort(newestFirst), accepted: accepted.sort(newestFirst) };
}

export function act(db, person, id, action, now) {
  const stored = action === "complete" || action === "noshow" || action === "withdraw"
    ? db.requests.find((r) => r.id === id && r.requesterId === person.id) // requester may have left the circle
    : requestInMyCircles(db, person, id);
  if (!stored) fail("Request not found", 404);
  const request = hydrate(stored);

  const event = { circleId: request.circleId, requestId: request.id, actorId: person.id, at: now };
  if (action === "accept") {
    if (!person.volunteering) fail("Turn on volunteering in your profile first");
    acceptRequest(toVolunteer(db, person, now), request, now);
    log(db, { ...event, type: "accepted" });
  } else if (action === "cancel") {
    const volunteer = toVolunteer(db, person, now);
    const before = volunteer.history.length;
    cancelAcceptance(request, volunteer, now);
    saveHistory(person, volunteer);
    log(db, { ...event, type: "released", detail: { late: volunteer.history.length > before } });
  } else if (action === "complete" || action === "noshow") {
    if (!request.acceptedBy) fail("Nobody has accepted this request yet");
    const helperPerson = personById(db, request.acceptedBy);
    const helper = { id: helperPerson.id, history: helperPerson.history.map((e) => ({ ...e, at: new Date(e.at) })) };
    if (action === "complete") completeRequest(request, helper, { confirmedBy: person.id }, now);
    else reportNoShow(request, helper, { reportedBy: person.id }, now);
    saveHistory(helperPerson, helper);
    log(db, { ...event, type: action === "complete" ? "completed" : "no_show", subjectId: helperPerson.id });
  } else if (action === "withdraw") {
    if (request.status === "completed") fail("This request is already done");
    request.status = "cancelled";
    log(db, { ...event, type: "withdrawn" });
  } else {
    fail("Unknown action", 404);
  }

  store(db, request);
  return { status: request.status };
}

// ---------- safety reports ----------

export function report(db, person, body, now) {
  const note = text(body.note, 500, "Note");
  if (!note) fail("Tell the organizer what happened");
  const r = db.requests.find((x) => x.id === body.requestId);
  if (!r || (r.requesterId !== person.id && r.acceptedBy !== person.id && !activeCircleIds(db, person).includes(r.circleId))) {
    fail("Request not found", 404);
  }
  db.reports.push({
    id: makeId("rep"),
    circleId: r.circleId,
    from: person.id,
    requestId: r.id,
    note,
    at: now.toISOString(),
    resolved: false,
  });
  return { ok: true };
}

export function resolveReport(db, person, circleId, id) {
  requireOrganizer(db, person, circleId);
  const r = db.reports.find((x) => x.id === id && x.circleId === circleId);
  if (!r) fail("Report not found", 404);
  r.resolved = true;
  return { ok: true };
}

// ---------- appeals ----------
// A volunteer reported as a no-show can appeal with a statement and up to 3
// photos. Organizers of that neighborhood decide; nobody decides their own case.
// The penalty stays while the appeal is pending, so appealing everything
// doesn't dodge penalties. If an organizer removes the no-show, the event is
// marked `overturned` and reputation.js ignores it.

const appealSummary = (a) => ({
  id: a.id, status: a.status, createdAt: a.createdAt,
  decidedAt: a.decidedAt ?? null, decisionNote: a.decisionNote ?? "",
});

/** Images arrive as JPEG data URLs, already re-encoded on the phone (which strips GPS/EXIF). */
function decodeImage(dataUrl, n) {
  const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl ?? ""));
  if (!match) fail(`Photo ${n} isn't a JPEG image`);
  const bytes = Buffer.from(match[1], "base64");
  if (bytes.length > MAX_IMAGE_BYTES) fail(`Photo ${n} is too large`);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail(`Photo ${n} isn't a JPEG image`);
  return bytes;
}

export async function fileAppeal(db, blobs, person, body, now) {
  const r = db.requests.find((x) => x.id === body.requestId);
  if (!r) fail("Request not found", 404);
  const event = person.history.find((e) => e.requestId === r.id && e.outcome === "no_show" && !e.overturned);
  if (!event) fail("There's no no-show on your record for this request");
  if (db.appeals.some((a) => a.requestId === r.id && a.volunteerId === person.id)) fail("You've already appealed this one");
  if (now - new Date(event.at) > APPEAL_WINDOW_DAYS * DAY_MS) fail(`Appeals have to be filed within ${APPEAL_WINDOW_DAYS} days`);

  const statement = text(body.statement, 1000, "Statement");
  if (statement.length < 20) fail("Tell the organizer what happened (at least a sentence or two)");
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > MAX_APPEAL_IMAGES) fail(`You can attach up to ${MAX_APPEAL_IMAGES} photos`);
  const decoded = images.map((img, i) => decodeImage(img, i + 1)); // validate all before storing any

  const id = makeId("ap");
  const imageIds = [];
  for (const [i, bytes] of decoded.entries()) {
    const imageId = `${id}_${i}`;
    await blobs.put(imageId, bytes);
    imageIds.push(imageId);
  }
  db.appeals.push({
    id,
    circleId: r.circleId,
    requestId: r.id,
    volunteerId: person.id,
    requesterId: r.requesterId,
    noShowAt: event.at,
    statement,
    imageIds,
    status: "pending",
    createdAt: now.toISOString(),
  });
  log(db, { circleId: r.circleId, requestId: r.id, type: "appeal_filed", actorId: person.id, at: now });
  return { id };
}

/** What organizers see, with context to judge fairly. */
function appealForOrganizer(db, a, now) {
  const r = db.requests.find((x) => x.id === a.requestId);
  const volunteer = personById(db, a.volunteerId);
  const requester = personById(db, a.requesterId);
  // How often has this requester reported no-shows? Someone who reports everyone stands out.
  const reportsByRequester = db.people.reduce(
    (n, p) => n + p.history.filter((e) => e.outcome === "no_show" && e.requesterId === a.requesterId).length, 0
  );
  const requestsByRequester = db.requests.filter((x) => x.requesterId === a.requesterId).length;
  const volunteerNoShows = volunteer.history.filter((e) => e.outcome === "no_show").length;
  return {
    ...appealSummary(a),
    statement: a.statement,
    imageCount: a.imageIds.length,
    noShowAt: a.noShowAt,
    request: r ? { description: r.description, taskLabel: TASK_TYPES[r.taskType].label, window: r.window } : null,
    volunteer: {
      id: volunteer.id, name: volunteer.name, isMinor: volunteer.isMinor,
      reputation: repOf(volunteer, now), noShows: volunteerNoShows,
      completed: volunteer.history.filter((e) => e.outcome === "completed").length,
    },
    requester: { id: requester?.id, name: requester?.name ?? "Unknown", noShowsReported: reportsByRequester, requests: requestsByRequester },
  };
}

export async function appealImage(db, blobs, person, appealId, n) {
  const a = db.appeals.find((x) => x.id === appealId);
  if (!a) fail("Appeal not found", 404);
  const isOrganizer = membership(db, person.id, a.circleId)?.role === "organizer"
    && membership(db, person.id, a.circleId)?.status === "active";
  if (a.volunteerId !== person.id && !isOrganizer) fail("Appeal not found", 404);
  const imageId = a.imageIds[Number(n)];
  if (!imageId) fail("Photo not found", 404);
  const bytes = await blobs.get(imageId);
  if (!bytes) fail("Photo not found", 404);
  return { dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}` };
}

export function decideAppeal(db, person, appealId, body, now) {
  const a = db.appeals.find((x) => x.id === appealId);
  if (!a) fail("Appeal not found", 404);
  requireOrganizer(db, person, a.circleId);
  if (person.id === a.volunteerId || person.id === a.requesterId) {
    fail("You're part of this case, so another organizer has to decide it");
  }
  if (a.status !== "pending") fail("This appeal was already decided");
  if (!["overturn", "uphold"].includes(body.decision)) fail("Choose a decision");

  a.status = body.decision === "overturn" ? "overturned" : "upheld";
  a.decisionNote = text(body.note, 300, "Note");
  a.decidedBy = person.id;
  a.decidedAt = now.toISOString();
  if (a.status === "overturned") {
    const volunteer = personById(db, a.volunteerId);
    const event = volunteer.history.find((e) => e.requestId === a.requestId && e.outcome === "no_show" && !e.overturned);
    if (event) event.overturned = true;
  }
  log(db, { circleId: a.circleId, requestId: a.requestId, type: "appeal_decided", actorId: person.id, subjectId: a.volunteerId, at: now, detail: { status: a.status } });
  return { status: a.status };
}

// ---------- organizer activity feed ----------
// One card per request with its timeline (posted → accepted → done, plus
// cancellations, no-shows and appeals). Organizers only; no private details
// or phone numbers. Opening the feed marks it as seen.

const personRef = (db, id) => {
  const p = id && personById(db, id);
  return p ? { name: p.name, isMinor: p.isMinor } : null;
};

export function activityFeed(db, person, circleId, now) {
  const m = requireOrganizer(db, person, circleId);
  const lastSeen = m.lastSeenActivityAt ?? null;

  const byRequest = new Map();
  for (const e of db.activity) {
    if (e.circleId !== circleId || !e.requestId) continue;
    if (!byRequest.has(e.requestId)) byRequest.set(e.requestId, []);
    byRequest.get(e.requestId).push(e);
  }

  const items = db.requests
    .filter((r) => r.circleId === circleId)
    .map((r) => {
      const events = [...(byRequest.get(r.id) ?? [])];
      // Requests from before the log existed: rebuild what the request itself remembers.
      const has = (type) => events.some((e) => e.type === type);
      if (!has("posted")) events.push({ type: "posted", actorId: r.requesterId, at: r.createdAt });
      if (r.firstAcceptedAt && !has("accepted")) events.push({ type: "accepted", actorId: r.acceptedBy, at: r.firstAcceptedAt });
      if (r.status === "completed" && !has("completed")) {
        events.push({ type: "completed", actorId: r.requesterId, subjectId: r.acceptedBy, at: r.completedAt ?? r.acceptedAt ?? r.createdAt });
      }
      events.sort((a, b) => new Date(a.at) - new Date(b.at));

      return {
        id: r.id,
        taskLabel: TASK_TYPES[r.taskType].label,
        setting: TASK_TYPES[r.taskType].setting,
        description: r.description,
        onBehalfOf: r.onBehalfOf || "",
        status: r.status,
        active: r.status === "open" || r.status === "accepted",
        createdAt: r.createdAt,
        window: r.window,
        housebound: r.housebound,
        requester: personRef(db, r.requesterId),
        helper: personRef(db, r.acceptedBy),
        isNew: events.some((e) => e.actorId !== person.id && (!lastSeen || new Date(e.at) > new Date(lastSeen))),
        events: events.map((e) => ({
          type: e.type, at: e.at, detail: e.detail ?? {},
          actor: personRef(db, e.actorId), subject: personRef(db, e.subjectId),
        })),
      };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  m.lastSeenActivityAt = now.toISOString();
  return { items, lastSeen };
}

// ---------- impact ----------

export function metrics(db, person, circleId) {
  requireMember(db, person, circleId);
  const m = circleMetrics(db.requests.filter((r) => r.circleId === circleId));
  return { ...m, sentence: impactSentence(m) };
}

/** Anonymized export for the submission write-up: no names, no locations. */
export function metricsCsv(db, person, circleId) {
  requireOrganizer(db, person, circleId);
  const rows = [["request", "task_type", "posted_at", "first_matched_at", "hours_to_match", "status"]];
  db.requests
    .filter((r) => r.circleId === circleId)
    .forEach((r, i) => {
      const hours = r.firstAcceptedAt
        ? ((new Date(r.firstAcceptedAt) - new Date(r.createdAt)) / 36e5).toFixed(1)
        : "";
      rows.push([i + 1, r.taskType, r.createdAt, r.firstAcceptedAt ?? "", hours, r.status]);
    });
  return rows.map((row) => row.join(",")).join("\n");
}

