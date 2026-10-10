// Reputation: how reliable has this volunteer been, lately? A 0–100 score.
//
//   score = 60                                  everyone starts here
//         + up to 20  "getting started"         fills fast: ~4 tasks gets most of it
//         + up to 20  "consistency"             fills slowly: ~20 tasks, and only
//                                               at your follow-through rate
//         − penalties                           no-show −15, late cancel −6
//
// So 60 → 80 takes about 3–4 good tasks, but 80 → 95 takes ~15 more with no
// slip-ups. Each extra point costs more than the last (exponential approach).
//
// Everything decays: a task's weight halves every 90 days, so what you did
// last week counts more than last year. Penalties fade twice as slowly
// (180 days), so one bad day stays on the record for a while.

export const START = 60;
const QUICK = { points: 20, tasks: 2 }; // 1 − e^(−n/2): ~86% filled by 4 tasks
const STEADY = { points: 20, tasks: 15 }; // 1 − e^(−n/15): ~74% filled by 20 tasks
export const PENALTY = { no_show: 15, cancelled_late: 6 };
export const OUTCOMES = ["completed", "cancelled_late", "no_show"];

const HALF_LIFE_DAYS = 90;
const PENALTY_HALF_LIFE_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;

/** How much an event from `at` still counts today (1.0 = today, 0.5 = one half-life ago). */
export function decayWeight(at, now = new Date(), halfLifeDays = HALF_LIFE_DAYS) {
  const ageDays = Math.max(0, (now - at) / DAY_MS);
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export const penaltyWeight = (at, now) => decayWeight(at, now, PENALTY_HALF_LIFE_DAYS);

// Anti-collusion: two friends could post fake requests and confirm each other
// to farm points. Only the first SAME_NEIGHBOR.max tasks for the same requester
// in any SAME_NEIGHBOR.days window count. Real helpers spread out naturally.
export const SAME_NEIGHBOR = { max: 2, days: 30 };

/** One boolean per history event: does it count toward the score? */
export function countedFlags(history) {
  const counted = history.map(() => true);
  const recentByRequester = new Map();
  const order = history.map((_, i) => i).sort((a, b) => history[a].at - history[b].at);
  for (const i of order) {
    const e = history[i];
    if (e.outcome !== "completed" || !e.requesterId) continue;
    const recent = (recentByRequester.get(e.requesterId) ?? []).filter((t) => e.at - t < SAME_NEIGHBOR.days * DAY_MS);
    if (recent.length >= SAME_NEIGHBOR.max) counted[i] = false;
    else recent.push(e.at);
    recentByRequester.set(e.requesterId, recent);
  }
  return counted;
}

/**
 * history: [{ outcome, at: Date, requesterId? }]
 * Returns { score 0–100, confidence, completed, uncounted, label, parts } where
 * parts is the breakdown the app shows, and confidence is the decayed number of events.
 */
export function reputation(history, now = new Date()) {
  let done = 0; // decayed count of completed tasks
  let missed = 0; // decayed count of no-shows and late cancels
  let penalty = 0;
  let completed = 0;
  let uncounted = 0;
  const counted = countedFlags(history);

  for (const [i, event] of history.entries()) {
    if (!OUTCOMES.includes(event.outcome)) throw new Error(`Unknown outcome: ${event.outcome}`);
    const w = decayWeight(event.at, now);
    if (event.outcome === "completed" && !counted[i]) {
      uncounted++;
    } else if (event.outcome === "completed") {
      done += w;
      completed++;
    } else {
      missed += w;
      penalty += PENALTY[event.outcome] * penaltyWeight(event.at, now);
    }
  }

  const followThrough = done + missed > 0 ? done / (done + missed) : 1;
  const quick = QUICK.points * (1 - Math.exp(-done / QUICK.tasks));
  const steady = STEADY.points * (1 - Math.exp(-done / STEADY.tasks)) * followThrough;
  const score = Math.min(100, Math.max(0, START + quick + steady - penalty));
  const confidence = done + missed;

  return {
    score,
    confidence,
    completed,
    uncounted,
    label: labelFor(score, confidence),
    parts: { start: START, quick, steady, penalty, followThrough },
  };
}

// What a requester sees next to a volunteer's name.
function labelFor(score, confidence) {
  if (confidence < 1) return "New volunteer";
  if (score >= 90) return "Very reliable";
  if (score >= 75) return "Reliable";
  if (score >= 60) return "Building trust";
  return "Mixed history";
}
