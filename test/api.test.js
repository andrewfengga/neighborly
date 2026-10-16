// Run with: npm test
// Server rules, end to end over the sample data: privacy, permissions,
// neighborhoods, and the full ask → accept → complete → reputation loop.

import { test } from "node:test";
import assert from "node:assert/strict";
import { seedDemo } from "../server/seed.js";
import * as api from "../server/api.js";

const now = new Date();
const fresh = () => {
  const db = seedDemo(now);
  const who = (id) => db.people.find((p) => p.id === id);
  return {
    db, maya: who("p_maya"), tom: who("p_tom"), rosa: who("p_alvarez"),
    priya: who("p_priya"), dev: who("p_dev"),
  };
};
const query = (params) => new URLSearchParams(params);
const newPerson = (db, extra = {}) => {
  const { token } = api.signup(db, { name: "Sam Lee", location: { lat: 34.08, lng: -84.29 }, ...extra }, now);
  return api.personByToken(db, token);
};

// ---------- privacy & safety ----------

test("the board never leaks private details, full names, or locations", () => {
  const { db, tom } = fresh();
  const json = JSON.stringify(api.board(db, tom, now));
  assert.ok(!json.includes("412 Mill Creek Ln"));
  assert.ok(!json.includes("Alvarez"));
  assert.ok(!json.includes("lat"));
});

test("a minor's board hides in-home and car tasks, and says so", () => {
  const { db, maya } = fresh();
  const b = api.board(db, maya, now);
  assert.ok(b.items.every((i) => i.request.setting === "doorstep" || i.request.setting === "outdoor"));
  assert.ok(Object.keys(b.hidden).some((r) => r.startsWith("under-18")));
});

test("a minor can't accept an in-home task even by calling the API directly", () => {
  const { db, maya } = fresh();
  assert.throws(() => api.act(db, maya, "r_phone", "accept", now), /under-18/);
});

test("a minor can't add in-home skills to their profile", () => {
  const { db, maya } = fresh();
  assert.throws(() => api.updateProfile(db, maya, { skills: ["tech_help"] }), /Under-18/);
});

test("medical requests are refused by the server, not just the form", () => {
  const { db, rosa } = fresh();
  assert.throws(() => api.postRequest(db, rosa, {
    circleId: "c_maple", taskType: "groceries", description: "pick up and give me my insulin injection",
    start: now.toISOString(), end: new Date(now.getTime() + 3600e3 * 5).toISOString(),
  }, now), /professional/);
});

test("locations are rounded before they're stored", () => {
  const { db } = fresh();
  const sam = newPerson(db, { location: { lat: 34.07531, lng: -84.29412 } });
  assert.deepEqual(sam.location, { lat: 34.08, lng: -84.29 });
});

// ---------- the main loop ----------

test("full loop: rank, accept, see private details, confirm, reputation rises", () => {
  const { db, maya, rosa } = fresh();
  const before = api.me(db, maya, {}, now).reputation.score;

  const top = api.board(db, maya, now).items[0].request;
  assert.equal(top.id, "r_groc"); // housebound, same-day grocery run ranks first

  api.act(db, maya, top.id, "accept", now);
  assert.match(api.mine(db, maya, now).accepted[0].privateDetails, /412 Mill Creek/);

  assert.throws(() => api.act(db, maya, top.id, "complete", now), /not found/i);
  api.act(db, rosa, top.id, "complete", now);
  assert.ok(api.me(db, maya, {}, now).reputation.score > before);
});

test("the board combines every neighborhood you're in", () => {
  const { db, maya } = fresh();
  const circles = new Set(api.board(db, maya, now).items.map((i) => i.request.circleName));
  assert.ok(circles.has("Maple Street Neighbors"));
  assert.ok(circles.has("Riverbend Youth Volunteers"));
});

test("you can't see or post requests in a neighborhood you're not in", () => {
  const { db, rosa } = fresh();
  assert.ok(!api.board(db, { ...rosa, volunteering: true }, now).items.some((i) => i.request.circleId === "c_youth"));
  assert.throws(() => api.postRequest(db, rosa, { circleId: "c_youth" }, now), /not a member/);
});

// ---------- neighborhoods ----------

test("create a neighborhood: you're its organizer and get an invite key", () => {
  const { db } = fresh();
  const sam = newPerson(db);
  const { id, inviteKey } = api.createCircle(db, sam, {
    name: "Birch Court Crew", city: "Alpharetta", state: "GA", visibility: "private",
  }, now);
  assert.match(inviteKey, /^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
  assert.equal(api.circleDetail(db, sam, id, now).role, "organizer");
});

test("duplicate names in the same city are refused", () => {
  const { db } = fresh();
  const sam = newPerson(db);
  assert.throws(() => api.createCircle(db, sam, {
    name: "maple street neighbors", city: "Alpharetta", state: "GA", visibility: "listed",
  }, now), /already/);
});

test("private neighborhoods never appear in search; listed ones are sorted by distance", () => {
  const { db } = fresh();
  const sam = newPerson(db);
  const results = api.searchCircles(db, sam, query({}));
  assert.ok(!results.some((c) => c.id === "c_youth"));
  assert.equal(results[0].id, "c_maple");
  assert.equal(results.at(-1).state, "NC"); // Raleigh is farthest
});

test("search filters by text, state, and distance", () => {
  const { db } = fresh();
  const sam = newPerson(db);
  assert.deepEqual(api.searchCircles(db, sam, query({ q: "roswell" })).map((c) => c.id), ["c_lake"]);
  assert.deepEqual(api.searchCircles(db, sam, query({ state: "NC" })).map((c) => c.id), ["c_elm"]);
  assert.ok(api.searchCircles(db, sam, query({ within: "10" })).every((c) => c.miles <= 10));
});

test("an invite key joins instantly, and keys ignore case and dashes", () => {
  const { db } = fresh();
  const sam = newPerson(db);
  api.joinWithKey(db, sam, { key: "rvrb3n" }, now);
  assert.ok(api.me(db, sam, {}, now).circles.some((c) => c.id === "c_youth" && c.status === "active"));
});

test("asking to join a listed neighborhood waits for an organizer", () => {
  const { db, priya } = fresh();
  const sam = newPerson(db);
  api.requestToJoin(db, sam, "c_maple", { note: "I live nearby" }, now);
  assert.throws(() => api.circleDetail(db, sam, "c_maple", now), /not a member/);

  const pending = api.circleDetail(db, priya, "c_maple", now).pendingPeople;
  assert.ok(pending.some((p) => p.id === sam.id && p.note === "I live nearby"));
  api.decideMember(db, priya, "c_maple", sam.id, "approve", now);
  assert.equal(api.circleDetail(db, sam, "c_maple", now).role, "member");
});

test("you can't ask to join a private neighborhood without its key", () => {
  const { db } = fresh();
  assert.throws(() => api.requestToJoin(db, newPerson(db), "c_youth", {}, now), /not found/);
});

test("only organizers can approve, and a denied request can't be repeated", () => {
  const { db, tom, priya, dev } = fresh();
  assert.throws(() => api.decideMember(db, tom, "c_maple", dev.id, "approve", now), /organizers/);
  api.decideMember(db, priya, "c_maple", dev.id, "deny", now);
  assert.throws(() => api.requestToJoin(db, dev, "c_maple", {}, now), /can't request/);
});

test("only organizers see members and guardian contacts", () => {
  const { db, tom, priya } = fresh();
  assert.equal(api.circleDetail(db, tom, "c_maple", now).people, undefined);
  const { people } = api.circleDetail(db, priya, "c_maple", now);
  assert.ok(people.some((p) => p.guardianContact?.includes("555")));
});

test("removing someone frees their tasks there, but they keep their other neighborhoods", () => {
  const { db, tom, priya } = fresh();
  api.act(db, tom, "r_phone", "accept", now);
  api.decideMember(db, priya, "c_maple", tom.id, "remove", now);
  assert.equal(db.requests.find((r) => r.id === "r_phone").status, "open");
  assert.ok(api.me(db, tom, {}, now).circles.some((c) => c.id === "c_youth"));
  assert.throws(() => api.joinWithKey(db, tom, { key: "MAP-LE2" }, now), /removed/);
});

test("rotating the key stops the old one from working", () => {
  const { db, priya } = fresh();
  api.rotateKey(db, priya, "c_maple");
  assert.throws(() => api.joinWithKey(db, newPerson(db), { key: "MAP-LE2" }, now), /doesn't match/);
});

test("the only organizer can't leave a neighborhood that still has members", () => {
  const { db, priya } = fresh();
  assert.throws(() => api.leaveCircle(db, priya, "c_maple"), /only organizer/);
});

test("signing up as a minor needs a guardian", () => {
  const { db } = fresh();
  assert.throws(() => api.signup(db, { name: "A", isMinor: true }, now), /guardian/);
});

test("an invite link previews the neighborhood name before sign-up, and bad keys are refused", () => {
  const { db } = fresh();
  assert.deepEqual(api.previewKey(db, "map-le2"), { name: "Maple Street Neighbors", city: "Alpharetta", state: "GA" });
  assert.throws(() => api.previewKey(db, "ZZZ-999"), /expired or is wrong/);
});

test("posting for someone else shows their name; phone stays private until accepted", () => {
  const { db, rosa, tom } = fresh();
  const { id } = api.postRequest(db, rosa, {
    circleId: "c_maple", taskType: "tech_help", description: "Fix the TV remote",
    onBehalfOf: "Mrs. Lee", contactPhone: "(555) 222-3333",
    start: now.toISOString(), end: new Date(now.getTime() + 864e5).toISOString(),
  }, now);
  const card = api.board(db, tom, now).items.find((i) => i.request.id === id);
  assert.equal(card.request.onBehalfOf, "Mrs. Lee");
  assert.ok(!JSON.stringify(card).includes("555"));

  api.act(db, tom, id, "accept", now);
  assert.equal(api.mine(db, tom, now).accepted.find((r) => r.id === id).contactPhone, "(555) 222-3333");
  api.act(db, rosa, id, "complete", now);
  assert.equal(api.mine(db, tom, now).accepted.find((r) => r.id === id).contactPhone, undefined); // gone once done
});

test("a requester sees a minor volunteer's guardian contact", () => {
  const { db, maya, rosa } = fresh();
  api.act(db, maya, "r_groc", "accept", now);
  const v = api.mine(db, rosa, now).posted.find((r) => r.id === "r_groc").volunteer;
  assert.match(v.guardianContact, /555/);
});

test("bad phone numbers are refused", () => {
  const { db, rosa } = fresh();
  assert.throws(() => api.updateProfile(db, rosa, { phone: "call me maybe" }), /phone number/);
});

// ---------- appeals ----------

const memoryBlobs = () => {
  const m = new Map();
  return { put: async (id, b) => void m.set(id, b), get: async (id) => m.get(id) ?? null, size: () => m.size };
};
// Smallest thing that looks like a JPEG to the server (starts with FF D8 FF).
const fakeJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64")}`;
const statement = "I was there at 10am, knocked twice and texted, waited 15 minutes.";

test("a reported no-show stays on the volunteer's Mine page, ready to appeal", () => {
  const { db, tom } = fresh();
  const item = api.mine(db, tom, now).accepted.find((r) => r.id === "r_curb");
  assert.equal(item.myStatus, "no_show");
  assert.equal(item.canAppeal, true);
});

test("appeal → organizer removes the no-show → penalty disappears", async () => {
  const { db, tom, priya } = fresh();
  const blobs = memoryBlobs();
  const before = api.me(db, tom, {}, now).reputation.score;

  const { id } = await api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement, images: [fakeJpeg] }, now);
  assert.equal(blobs.size(), 1);
  assert.equal(api.mine(db, tom, now).accepted.find((r) => r.id === "r_curb").appeal.status, "pending");
  assert.equal(api.me(db, tom, {}, now).reputation.score, before, "penalty stays while pending");

  const seen = api.circleDetail(db, priya, "c_maple", now).appeals[0];
  assert.equal(seen.requester.noShowsReported, 1);
  api.decideAppeal(db, priya, id, { decision: "overturn", note: "Thanks for the photo" }, now);

  assert.ok(api.me(db, tom, {}, now).reputation.score > before + 10);
  const after = api.mine(db, tom, now).accepted.find((r) => r.id === "r_curb");
  assert.equal(after.myStatus, "no_show_overturned");
  assert.equal(after.appeal.decisionNote, "Thanks for the photo");
});

test("appeal rules: one per no-show, real statement, JPEG photos only, max 3", async () => {
  const { db, tom } = fresh();
  const blobs = memoryBlobs();
  await assert.rejects(api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement: "I was there" }, now), /sentence/);
  await assert.rejects(api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement, images: ["data:image/png;base64,AAAA"] }, now), /JPEG/);
  await assert.rejects(api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement, images: [fakeJpeg, fakeJpeg, fakeJpeg, fakeJpeg] }, now), /up to 3/);
  assert.equal(blobs.size(), 0, "nothing stored when an appeal is refused");
  await api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement }, now);
  await assert.rejects(api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement }, now), /already/);
});

test("you can only appeal your own no-show, within 14 days", async () => {
  const { db, tom, maya } = fresh();
  await assert.rejects(api.fileAppeal(db, memoryBlobs(), maya, { requestId: "r_curb", statement }, now), /no no-show/);
  const later = new Date(now.getTime() + 15 * 864e5);
  await assert.rejects(api.fileAppeal(db, memoryBlobs(), tom, { requestId: "r_curb", statement }, later), /14 days/);
});

test("appeal photos: only the volunteer and that neighborhood's organizers can see them", async () => {
  const { db, tom, priya, maya } = fresh();
  const blobs = memoryBlobs();
  const { id } = await api.fileAppeal(db, blobs, tom, { requestId: "r_curb", statement, images: [fakeJpeg] }, now);
  assert.match((await api.appealImage(db, blobs, priya, id, 0)).dataUrl, /^data:image\/jpeg;base64,/);
  assert.ok(await api.appealImage(db, blobs, tom, id, 0));
  await assert.rejects(api.appealImage(db, blobs, maya, id, 0), /not found/);
});

test("organizers can't decide a case they're part of, and members can't decide at all", async () => {
  const { db, tom, priya } = fresh();
  const { id } = await api.fileAppeal(db, memoryBlobs(), tom, { requestId: "r_curb", statement }, now);
  assert.throws(() => api.decideAppeal(db, tom, id, { decision: "overturn" }, now), /organizers/);
  // Make the requester (Walter) an organizer: he still can't rule on his own report.
  const walter = db.people.find((p) => p.id === "p_chen");
  api.makeOrganizer(db, priya, "c_maple", walter.id);
  assert.throws(() => api.decideAppeal(db, walter, id, { decision: "uphold" }, now), /part of this case/);
});

test("sign-up for a minor needs a guardian name AND a real phone number", () => {
  const { db } = fresh();
  assert.throws(() => api.signup(db, { name: "A", isMinor: true, guardianName: "Mom" }, now), /guardian/);
  assert.throws(() => api.signup(db, { name: "A", isMinor: true, guardianName: "Mom", guardianPhone: "nope" }, now), /phone number/);
  const { token } = api.signup(db, { name: "A", isMinor: true, guardianName: "Dana Lee", guardianPhone: "(555) 444-1212" }, now);
  assert.equal(api.personByToken(db, token).guardianContact, "Dana Lee: (555) 444-1212");
});

// ---------- organizer activity feed ----------

test("activity feed: organizers only, and never shows private details or phones", () => {
  const { db, tom, priya } = fresh();
  assert.throws(() => api.activityFeed(db, tom, "c_maple", now), /organizers/);
  const json = JSON.stringify(api.activityFeed(db, priya, "c_maple", now));
  assert.ok(!json.includes("412 Mill Creek Ln"));
  assert.ok(!json.includes("010-2233"));
});

test("activity feed: every step of a request shows up in its timeline, with minors flagged", () => {
  const { db, maya, rosa, priya } = fresh();
  api.act(db, maya, "r_groc", "accept", now);
  api.act(db, rosa, "r_groc", "complete", now);
  const item = api.activityFeed(db, priya, "c_maple", now).items.find((i) => i.id === "r_groc");
  assert.deepEqual(item.events.map((e) => e.type), ["posted", "accepted", "completed"]);
  assert.equal(item.events[1].actor.isMinor, true);
  assert.equal(item.active, false);
});

test("activity feed: the no-show story, and the 'new' badge clears once seen", () => {
  const { db, priya } = fresh();
  const curb = api.activityFeed(db, priya, "c_maple", now).items.find((i) => i.id === "r_curb");
  assert.deepEqual(curb.events.map((e) => e.type), ["posted", "accepted", "no_show", "withdrawn"]);
  assert.equal(api.me(db, priya, {}, now).circles.find((c) => c.id === "c_maple").newActivity, 0, "opening the feed marks it seen");
});

test("activity feed: backing out and being removed are recorded", () => {
  const { db, tom, priya } = fresh();
  api.act(db, tom, "r_phone", "accept", now);
  api.decideMember(db, priya, "c_maple", tom.id, "remove", now);
  const phone = api.activityFeed(db, priya, "c_maple", now).items.find((i) => i.id === "r_phone");
  const released = phone.events.find((e) => e.type === "released");
  assert.equal(released.detail.reason, "removed");
});
