// Run with: npm run demo
// Builds a tiny fake neighborhood and prints each volunteer's ranked board.

import { createRequest, createVolunteer } from "./models.js";
import { rankForVolunteer } from "./ranking.js";
import { acceptRequest, completeRequest } from "./lifecycle.js";
import { reputation } from "./reputation.js";

const now = new Date("2026-10-10T09:00:00");
const hours = (h) => new Date(now.getTime() + h * 3600 * 1000);

// Rough spots around a neighborhood (made up, neighborhood-level).
const HOME = { lat: 34.075, lng: -84.294 };
const NEAR = { lat: 34.08, lng: -84.3 };
const FAR = { lat: 34.11, lng: -84.25 };

const CHURCH = "circle_church";

const maya = createVolunteer({
  name: "Maya (16)",
  circleIds: [CHURCH],
  location: HOME,
  isMinor: true,
  guardianContact: "parent on file",
  skills: ["groceries", "yard_work"],
  availability: [{ start: hours(0), end: hours(48) }],
  history: [
    { outcome: "completed", at: hours(-24 * 5) },
    { outcome: "completed", at: hours(-24 * 20) },
  ],
});

const tom = createVolunteer({
  name: "Tom (adult)",
  circleIds: [CHURCH],
  location: NEAR,
  skills: ["tech_help", "ride"],
  availability: [{ start: hours(0), end: hours(24 * 7) }],
  maxDistanceMiles: 5,
});

const requests = [
  createRequest({
    requesterId: "res_1", circleId: CHURCH, taskType: "groceries",
    description: "Carry groceries in Saturday morning",
    location: NEAR, window: { start: hours(1), end: hours(4) }, housebound: true,
  }),
  createRequest({
    requesterId: "res_2", circleId: CHURCH, taskType: "yard_work",
    description: "Rake leaves sometime this week",
    location: HOME, window: { start: hours(0), end: hours(24 * 6) },
  }),
  createRequest({
    requesterId: "res_3", circleId: CHURCH, taskType: "tech_help",
    description: "Set up new phone",
    location: NEAR, window: { start: hours(2), end: hours(30) },
  }),
  createRequest({
    requesterId: "res_4", circleId: CHURCH, taskType: "ride",
    description: "Ride to dentist Tuesday",
    location: FAR, window: { start: hours(72), end: hours(76) },
  }),
];

for (const volunteer of [maya, tom]) {
  console.log(`\n=== ${volunteer.name}'s board ===`);
  const board = rankForVolunteer(volunteer, requests, now);
  if (board.length === 0) console.log("  (nothing right now)");
  board.forEach((item, i) => {
    const p = item.parts;
    console.log(`${i + 1}. [${item.total.toFixed(2)}] ${item.request.description}`);
    console.log(`     why: ${item.why}`);
    console.log(
      `     urgency ${p.urgency.toFixed(2)} · distance ${p.distance.toFixed(2)} · skill ${p.skill.toFixed(2)}`
    );
  });
}

// The demo's last beat: Maya takes the top request, the requester confirms,
// and her reputation updates.
const showRep = (label) => {
  const rep = reputation(maya.history, now);
  console.log(`  ${label}: ${rep.label} — score ${Math.round(rep.score)}/100, ${rep.completed} tasks completed`);
};

console.log("\n=== Maya accepts the grocery run ===");
const top = rankForVolunteer(maya, requests, now)[0].request;
showRep("before");
acceptRequest(maya, top, now);
completeRequest(top, maya, { confirmedBy: top.requesterId }, hours(3));
showRep("after ");
