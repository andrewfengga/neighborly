// Volunteers pick simple weekly slots ("weekend mornings"); the ranking
// engine needs concrete { start, end } windows. This turns one into the other.
//
// Times are in the server's local time zone, which is fine for a pilot in
// one neighborhood.

export const SLOTS = {
  anytime: { label: "Pretty much anytime", days: [0, 1, 2, 3, 4, 5, 6], from: 7, to: 21 },
  weekday_afternoons: { label: "Weekday afternoons (3–7pm)", days: [1, 2, 3, 4, 5], from: 15, to: 19 },
  weekday_evenings: { label: "Weekday evenings (6–9pm)", days: [1, 2, 3, 4, 5], from: 18, to: 21 },
  weekend_mornings: { label: "Weekend mornings (8am–12pm)", days: [0, 6], from: 8, to: 12 },
  weekend_afternoons: { label: "Weekend afternoons (12–6pm)", days: [0, 6], from: 12, to: 18 },
};

/** Concrete windows for the next `daysAhead` days, starting today. */
export function expandSlots(slotKeys, now = new Date(), daysAhead = 21) {
  const windows = [];
  for (let d = 0; d < daysAhead; d++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + d);
    for (const key of slotKeys) {
      const slot = SLOTS[key];
      if (!slot) throw new Error(`Unknown availability slot: ${key}`);
      if (!slot.days.includes(day.getDay())) continue;
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.from);
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), slot.to);
      if (end > now) windows.push({ start, end });
    }
  }
  return windows;
}
