// Every kind of task the app supports, and WHERE it happens.
// The "setting" is what the safety rules check — not the task name.
//
//   doorstep – hand something off at the door (nobody goes inside)
//   outdoor  – work outside the home (yard, driveway)
//   in_home  – volunteer goes inside someone's home
//   vehicle  – volunteer drives the requester somewhere
//
// Medical and caregiving tasks are deliberately NOT listed: they need
// licensed care and are out of scope for this app.

export const TASK_TYPES = {
  groceries: { label: "Grocery pickup / carry-in", setting: "doorstep" },
  yard_work: { label: "Yard work", setting: "outdoor" },
  snow_leaves: { label: "Leaves, snow, or driveway", setting: "outdoor" },
  tech_help: { label: "Tech troubleshooting", setting: "in_home" },
  moving: { label: "Move or lift something", setting: "in_home" },
  ride: { label: "Ride to an appointment", setting: "vehicle" },
  // Anything else: the person asking says where it happens, so the safety rules still apply.
  other: { label: "Other", setting: null },
};

export const SETTINGS = {
  doorstep: "At the door",
  outdoor: "Outside",
  in_home: "Inside a home",
  vehicle: "In a car",
};

// Which settings a volunteer under 18 may accept on their own.
// In-home and vehicle tasks require an adult volunteer.
export const MINOR_ALLOWED_SETTINGS = new Set(["doorstep", "outdoor"]);

/** A task's setting; "other" tasks use the one the requester chose. */
export function settingOf(taskType, chosen = null) {
  const task = TASK_TYPES[taskType];
  if (!task) throw new Error(`Unknown task type: ${taskType}`);
  const setting = task.setting ?? chosen;
  if (!SETTINGS[setting]) throw new Error("Say where this will happen: at the door, outside, inside a home, or in a car");
  return setting;
}
