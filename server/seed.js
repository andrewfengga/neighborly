// Sample data for demo mode (npm run demo:web). Everything here is made up
// and the app labels it "sample data" on every screen, so these numbers are
// never confused with real pilot results.

import { emptyDb } from "./store.js";

// Rough, rounded spots (never real homes) around the sample neighborhoods.
const SPOT = {
  north: { lat: 34.08, lng: -84.29 },
  mill: { lat: 34.08, lng: -84.3 },
  center: { lat: 34.07, lng: -84.28 },
  hill: { lat: 34.11, lng: -84.25 },
};

export function seedDemo(now = new Date()) {
  const db = emptyDb();
  const h = (hours) => new Date(now.getTime() + hours * 3600e3).toISOString();
  const d = (days) => h(days * 24);

  // Open requests are anchored to daytime so the demo works whenever it's
  // recorded: now if it's 8am–4pm, otherwise 9am the next morning.
  const daytime = now.getHours() >= 8 && now.getHours() < 16
    ? now
    : new Date(now.getFullYear(), now.getMonth(), now.getDate() + (now.getHours() >= 16 ? 1 : 0), 9);
  const t = (hours) => new Date(Math.max(now.getTime(), daytime.getTime() + hours * 3600e3)).toISOString();

  // ---------- neighborhoods ----------
  const circle = (id, name, city, state, visibility, center, inviteKey, description) => ({
    id, name, city, state, visibility, center, inviteKey, description, createdBy: null, createdAt: d(-40),
  });
  db.circles.push(
    circle("c_maple", "Maple Street Neighbors", "Alpharetta", "GA", "listed", SPOT.north, "MAP-LE2",
      "Neighbors around Maple St and Mill Creek helping each other with everyday stuff."),
    circle("c_youth", "Riverbend Youth Volunteers", "Alpharetta", "GA", "private", SPOT.center, "RVR-B3N",
      "High school volunteer club. Members only."),
    circle("c_lake", "Lakeside Helpers", "Roswell", "GA", "listed", { lat: 34.02, lng: -84.36 }, "LAK-3SD",
      "Lakeside subdivision mutual aid."),
    circle("c_cedar", "Cedar Hills Community", "Cumming", "GA", "listed", { lat: 34.21, lng: -84.14 }, "CDR-H7L",
      "Open to anyone in Cedar Hills."),
    circle("c_elm", "Elm Park Neighbors", "Raleigh", "NC", "listed", { lat: 35.78, lng: -78.64 }, "ELM-P4K",
      "Elm Park neighborhood association volunteers.")
  );

  // ---------- people ----------
  const person = (id, name, location, extra) => ({
    id, token: `demo-${id}`, name, isMinor: false, guardianContact: null, location,
    volunteering: false, skills: [], slots: [], maxDistanceMiles: 2, history: [], joinedAt: d(-30), ...extra,
  });
  const done = (daysAgo) => ({ outcome: "completed", at: d(-daysAgo) });

  db.people.push(
    person("p_maya", "Maya Patel", SPOT.north, {
      isMinor: true, guardianContact: "Mom: (555) 010-2233",
      volunteering: true, skills: ["groceries", "yard_work", "snow_leaves"], slots: ["anytime"],
      history: [done(4), done(11), done(25)],
    }),
    person("p_tom", "Tom Reyes", SPOT.mill, {
      volunteering: true, skills: ["tech_help", "ride", "moving"], slots: ["anytime"], maxDistanceMiles: 5,
      history: [done(2), done(9), { outcome: "cancelled_late", at: d(-40) }, done(60), done(95)],
    }),
    person("p_priya", "Priya Shah", SPOT.center, {
      volunteering: true, skills: ["groceries", "ride"], slots: ["weekday_evenings", "weekend_afternoons"],
      history: [done(6), done(20)],
    }),
    person("p_alvarez", "Rosa Alvarez", SPOT.mill),
    person("p_chen", "Walter Chen", SPOT.north),
    person("p_okafor", "Grace Okafor", SPOT.hill),
    person("p_dev", "Dev Kapoor", SPOT.center)
  );

  const member = (personId, circleId, role = "member", extra = {}) =>
    db.memberships.push({ personId, circleId, role, status: "active", joinedAt: d(-30), ...extra });
  member("p_priya", "c_maple", "organizer");
  ["p_maya", "p_tom", "p_alvarez", "p_chen", "p_okafor"].forEach((p) => member(p, "c_maple"));
  member("p_tom", "c_youth", "organizer");
  member("p_maya", "c_youth");
  member("p_dev", "c_maple", "member", {
    status: "pending", joinedAt: undefined, requestedAt: h(-3),
    note: "I live on Birch Ct and saw the flyer at the library. Happy to help with tech stuff!",
  });

  // Background members so other neighborhoods don't look empty in search.
  // Not shown in the demo's user switcher.
  [["c_lake", 9], ["c_cedar", 14], ["c_elm", 22]].forEach(([circleId, count]) => {
    const { center } = db.circles.find((c) => c.id === circleId);
    for (let i = 0; i < count; i++) {
      const id = `p_${circleId}_${i}`;
      db.people.push(person(id, `Neighbor ${i + 1}`, center, { background: true }));
      member(id, circleId, i === 0 ? "organizer" : "member");
    }
  });

  // ---------- requests ----------
  const req = (id, circleId, requesterId, taskType, description, start, end, extra = {}) => ({
    id, requesterId, circleId, taskType, description,
    location: db.people.find((p) => p.id === requesterId).location,
    window: { start, end }, housebound: false, privateDetails: "", status: "open",
    acceptedBy: null, acceptedAt: null, firstAcceptedAt: null, createdAt: h(-1), ...extra,
  });

  // Open requests — what the boards show.
  db.requests.push(
    req("r_groc", "c_maple", "p_alvarez", "groceries", "Carry groceries in from the car — knee surgery last week", t(0), t(5), {
      housebound: true, privateDetails: "412 Mill Creek Ln, side door. Text when you're close.",
    }),
    req("r_leaves", "c_maple", "p_chen", "snow_leaves", "Rake the front yard leaves sometime this week", t(0), t(6 * 24)),
    req("r_phone", "c_maple", "p_okafor", "tech_help", "Set up my new phone and move my photos over", t(1), t(2 * 24)),
    req("r_ride", "c_maple", "p_chen", "ride", "Ride to my dentist appointment", t(3 * 24), t(3 * 24 + 4)),
    req("r_shelf", "c_maple", "p_alvarez", "moving", "Help moving a bookshelf to the garage, no rush", t(0), t(14 * 24)),
    req("r_club", "c_youth", "p_tom", "yard_work", "Weed the garden beds at the community center", t(0), t(4 * 24))
  );

  // Past requests — so the impact screen has something to show in the demo.
  const past = [
    ["groceries", -20, 1.5, "p_maya"], ["tech_help", -18, 5, "p_tom"], ["yard_work", -16, 20, "p_maya"],
    ["ride", -14, 3, "p_tom"], ["groceries", -11, 0.8, "p_priya"], ["moving", -9, 30, "p_tom"],
    ["snow_leaves", -7, 9, "p_maya"], ["groceries", -5, 2, "p_priya"], ["tech_help", -3, null, null],
  ];
  past.forEach(([type, daysAgo, hoursToMatch, by], i) => {
    const created = d(daysAgo);
    const matched = hoursToMatch === null ? null : new Date(new Date(created).getTime() + hoursToMatch * 3600e3).toISOString();
    db.requests.push(
      req(`r_past${i}`, "c_maple", "p_alvarez", type, "Earlier request", created, d(daysAgo + 2), {
        createdAt: created,
        status: matched ? "completed" : "cancelled",
        acceptedBy: by,
        acceptedAt: matched,
        firstAcceptedAt: matched,
      })
    );
  });

  return db;
}
