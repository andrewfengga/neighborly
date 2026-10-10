// Quick post: turn "need help carrying groceries in Saturday morning" into a
// structured request (task type, time window, housebound) so posting takes
// one sentence instead of a form. Plain keyword rules, so it runs offline in
// the browser and every guess can be shown and corrected before posting.
//
// It also runs the SCOPE CHECK: requests that sound like medical care or
// personal care are stopped here, because the app is for low-stakes help only.

const TASK_KEYWORDS = {
  groceries: ["grocery", "groceries", "shopping", "food", "pick up", "pickup", "errand", "store", "pharmacy"],
  yard_work: ["yard", "lawn", "mow", "weed", "garden", "hedge", "plant", "mulch"],
  snow_leaves: ["leaves", "rake", "raking", "snow", "shovel", "driveway"],
  tech_help: ["phone", "computer", "laptop", "wifi", "wi-fi", "printer", "email", "tablet", "ipad", "tv", "zoom", "password", "app"],
  moving: ["move", "moving", "lift", "furniture", "couch", "bookshelf", "boxes", "heavy", "assemble", "assembling", "carry in"],
  ride: ["ride", "drive me", "appointment", "doctor", "dentist", "airport", "church service", "lift to"],
};

// Out of scope: needs licensed or personal care. Matching any of these blocks posting.
const OUT_OF_SCOPE = [
  "medication", "medicine dose", "insulin", "injection", "bathe", "bathing", "shower me",
  "wound", "bandage", "nurse", "toilet", "dressing me", "babysit", "babysitting", "childcare", "pet sit",
];

const HOUSEBOUND = [
  "housebound", "homebound", "can't leave", "cannot leave", "can't drive", "cannot drive",
  "surgery", "crutches", "injured", "recovering", "wheelchair", "walker", "can't get out", "bedridden",
];

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const PART_OF_DAY = {
  morning: [8, 12],
  afternoon: [12, 17],
  evening: [17, 21],
  tonight: [17, 21],
};

const HOUR_MS = 60 * 60 * 1000;

function has(text, words) {
  // Whole words with simple endings: "plant" matches "plants", but "app" never matches "appointment".
  return words.filter((w) => new RegExp(`\\b${w}(s|es|ing|ed)?\\b`).test(text));
}

export function scopeCheck(text) {
  const hits = has(text.toLowerCase(), OUT_OF_SCOPE);
  return hits.length
    ? { ok: false, reason: `"${hits[0]}" sounds like care that needs a professional. Neighborly is for everyday practical help only.` }
    : { ok: true };
}

export function guessTaskType(text) {
  const lower = text.toLowerCase();
  let best = null;
  let bestHits = [];
  for (const [type, words] of Object.entries(TASK_KEYWORDS)) {
    const hits = has(lower, words);
    if (hits.length > bestHits.length) {
      best = type;
      bestHits = hits;
    }
  }
  return { taskType: best, matched: bestHits };
}

/** Returns { start, end, label } — when the help is needed. */
export function guessWindow(text, now = new Date()) {
  const lower = text.toLowerCase();
  const at = (dayOffset, hour) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour);

  if (/\b(asap|urgent|right now|right away)\b/.test(lower)) {
    return { start: now, end: new Date(now.getTime() + 4 * HOUR_MS), label: "as soon as possible" };
  }

  const part = Object.keys(PART_OF_DAY).find((p) => lower.includes(p));
  const [from, to] = part ? PART_OF_DAY[part] : [9, 18];

  let dayOffset = null;
  let dayLabel = "";
  if (/\b(today|tonight)\b/.test(lower)) [dayOffset, dayLabel] = [0, "today"];
  else if (/\btomorrow\b/.test(lower)) [dayOffset, dayLabel] = [1, "tomorrow"];
  else {
    const named = DAYS.findIndex((d) => lower.includes(d));
    if (named !== -1) {
      dayOffset = (named - now.getDay() + 7) % 7;
      if (dayOffset === 0 && at(0, to) <= now) dayOffset = 7; // "Saturday" said on a Saturday evening
      dayLabel = DAYS[named][0].toUpperCase() + DAYS[named].slice(1);
    }
  }

  if (dayOffset !== null) {
    const start = new Date(Math.max(at(dayOffset, from), now));
    return { start, end: at(dayOffset, to), label: `${dayLabel} ${part ?? ""}`.trim() };
  }

  if (/\bthis weekend\b/.test(lower)) {
    const toSat = (6 - now.getDay() + 7) % 7;
    return { start: new Date(Math.max(at(toSat, 8), now)), end: at(toSat + 1, 18), label: "this weekend" };
  }
  if (/\b(this month|no rush|whenever|sometime)\b/.test(lower)) {
    return { start: now, end: at(21, 18), label: "no rush (next 3 weeks)" };
  }
  if (/\bthis week\b/.test(lower)) {
    return { start: now, end: at(7, 18), label: "this week" };
  }
  return { start: now, end: at(3, 18), label: "next few days (default)" };
}

export function parseQuickPost(text, now = new Date()) {
  const { taskType, matched } = guessTaskType(text);
  const window = guessWindow(text, now);
  const housebound = has(text.toLowerCase(), HOUSEBOUND).length > 0;
  return { taskType, matched, window, housebound, scope: scopeCheck(text) };
}
