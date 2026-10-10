// Pilot impact numbers: "Across N requests over M weeks, X% were matched
// with a volunteer within Y hours." Computed from real request records only.
//
// A request counts as MATCHED once someone first accepted it (firstAcceptedAt),
// even if that volunteer later cancelled and someone else took it.

import { TASK_TYPES } from "./tasks.js";

const HOUR_MS = 60 * 60 * 1000;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function circleMetrics(requests, { withinHours = 24 } = {}) {
  const posted = requests.length;
  const hoursToMatch = requests
    .filter((r) => r.firstAcceptedAt)
    .map((r) => (new Date(r.firstAcceptedAt) - new Date(r.createdAt)) / HOUR_MS);
  const matched = hoursToMatch.length;
  const matchedWithin = hoursToMatch.filter((h) => h <= withinHours).length;
  const completed = requests.filter((r) => r.status === "completed").length;

  const byTask = Object.keys(TASK_TYPES).map((type) => {
    const ofType = requests.filter((r) => r.taskType === type);
    return {
      type,
      label: TASK_TYPES[type].label,
      posted: ofType.length,
      matched: ofType.filter((r) => r.firstAcceptedAt).length,
    };
  });

  const dates = requests.map((r) => new Date(r.createdAt).getTime());
  const weeks = posted ? Math.max(1, Math.ceil((Math.max(...dates) - Math.min(...dates)) / (7 * 24 * HOUR_MS))) : 0;

  const pct = (n) => (posted ? n / posted : 0);
  return {
    posted,
    weeks,
    matched,
    matchedPct: pct(matched),
    withinHours,
    matchedWithin,
    matchedWithinPct: pct(matchedWithin),
    medianHoursToMatch: median(hoursToMatch),
    completed,
    completedPct: pct(completed),
    byTask,
  };
}

/** The one-line claim for the submission, built only from measured numbers. */
export function impactSentence(m) {
  if (m.posted === 0) return "No requests yet. Pilot numbers appear here as they come in.";
  const pct = Math.round(m.matchedWithinPct * 100);
  return `Across ${m.posted} real requests over ${m.weeks} week${m.weeks === 1 ? "" : "s"}, ` +
    `${pct}% were matched with a volunteer within ${m.withinHours} hours.`;
}
