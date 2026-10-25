// Volunteers pick simple weekly slots ("weekend mornings"); the ranking
// engine needs concrete { start, end } windows. This turns one into the other.
//
// Times are in the server's local time zone, which is fine for a pilot in
// one neighborhood.

const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

// Shown grouped (Weekdays / Weekends), in this order.
export const SLOTS = {
  weekday_mornings: { group: "Weekdays", label: "Mornings (8am–12pm)", days: WEEKDAYS, from: 8, to: 12 },
  weekday_afternoons: { group: "Weekdays", label: "Afternoons (12–5pm)", days: WEEKDAYS, from: 12, to: 17 },
  weekday_evenings: { group: "Weekdays", label: "Evenings (5–9pm)", days: WEEKDAYS, from: 17, to: 21 },
  weekday_anytime: { group: "Weekdays", label: "Pretty much anytime", days: WEEKDAYS, from: 8, to: 21 },
  weekend_mornings: { group: "Weekends", label: "Mornings (8am–12pm)", days: WEEKEND, from: 8, to: 12 },
  weekend_afternoons: { group: "Weekends", label: "Afternoons (12–5pm)", days: WEEKEND, from: 12, to: 17 },
  weekend_evenings: { group: "Weekends", label: "Evenings (5–9pm)", days: WEEKEND, from: 17, to: 21 },
  weekend_anytime: { group: "Weekends", label: "Pretty much anytime", days: WEEKEND, from: 8, to: 21 },
  // Older accounts saved this before the split; still understood, not shown.
  anytime: { hidden: true, label: "Pretty much anytime", days: [...WEEKEND, ...WEEKDAYS], from: 7, to: 21 },
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
