// Neighborly front end. Plain ES modules, no build step.
// It imports the same engine files the server uses (src/), so the quick-post
// parser and reputation math the user sees are exactly what the server runs.

import { TASK_TYPES, MINOR_ALLOWED_SETTINGS } from "/src/tasks.js";
import { SLOTS } from "/src/availability.js";
import { parseQuickPost } from "/src/parse.js";
import { reputation, countedFlags, decayWeight, penaltyWeight, PENALTY, SAME_NEIGHBOR } from "/src/reputation.js";
import { WEIGHTS } from "/src/ranking.js";
import { US_STATES } from "/src/states.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

// ---------- small utilities ----------

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, value); } catch { /* private mode */ }
  },
};

let token = storage.get("neighborly.token");
let me = null; // the /api/me payload
let pollTimer = null;
let pendingInviteKey = null; // from an invite link, used right after sign-up

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) signOut();
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast${isError ? " error" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 3200);
}

function openDialog(html, onSubmit) {
  const dialog = $("#dialog");
  dialog.innerHTML = html;
  dialog.showModal();
  $("[data-close]", dialog)?.addEventListener("click", () => dialog.close());
  $("form", dialog)?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await onSubmit(new FormData(e.target));
      dialog.close();
    } catch (err) {
      toast(err.message, true);
    }
  });
}

function confirmDialog(title, body, okLabel = "Yes", danger = false) {
  return new Promise((resolve) => {
    const dialog = $("#dialog");
    dialog.innerHTML = `
      <h3>${esc(title)}</h3><p class="small">${body}</p>
      <div class="actions"><button class="btn ${danger ? "danger" : "primary"}" data-ok>${esc(okLabel)}</button>
      <button class="btn" data-close>Never mind</button></div>`;
    dialog.showModal();
    const done = (v) => { dialog.close(); resolve(v); };
    $("[data-ok]", dialog).onclick = () => done(true);
    $("[data-close]", dialog).onclick = () => done(false);
    dialog.oncancel = () => resolve(false);
  });
}

/** Asks the browser for a location and rounds it ON THE DEVICE before it's ever sent. */
function getRoundedLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("This browser can't share a location"));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: Math.round(p.coords.latitude * 100) / 100,
        lng: Math.round(p.coords.longitude * 100) / 100,
      }),
      () => reject(new Error("Location is blocked. Allow it in your browser's site settings, then try again.")),
      { timeout: 10000, maximumAge: 600000 }
    );
  });
}

/** Wires up a "Use my location" button that stores the result in a hidden input. */
function locationButton(buttonSel, inputSel, statusSel) {
  $(buttonSel).onclick = async () => {
    $(statusSel).textContent = "Finding you…";
    try {
      const loc = await getRoundedLocation();
      $(inputSel).value = JSON.stringify(loc);
      $(statusSel).innerHTML = `📍 Got it, rounded to about half a mile. Your exact address is never stored.`;
    } catch (err) {
      $(statusSel).textContent = err.message;
    }
  };
}

/**
 * Re-draws a photo onto a canvas and saves it as a JPEG. That strips EXIF data
 * (including GPS location, which could reveal where someone lives) and shrinks
 * it to at most 1600px and about 600 KB, before it ever leaves the phone.
 */
async function compressPhoto(file) {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} isn't a photo`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error(`Couldn't open ${file.name}. Try a screenshot or a JPEG.`);
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (const quality of [0.82, 0.7, 0.6, 0.5, 0.4]) {
    const dataUrl = canvas.toDataURL("image/jpeg", quality);
    if (dataUrl.length * 0.75 < 600 * 1024) return dataUrl;
  }
  throw new Error(`${file.name} is too large even after shrinking`);
}

const inviteLink = (key) => `${location.origin}/#/join/${encodeURIComponent(key)}`;

async function shareInvite(circle) {
  const link = inviteLink(circle.inviteKey);
  const text = `Join ${circle.name} on Neighborly so we can help each other out. Open ${link} or enter key ${circle.inviteKey}.`;
  if (navigator.share) {
    try {
      await navigator.share({ title: `Join ${circle.name}`, text });
      return;
    } catch { /* cancelled; fall through to copy */ }
  }
  await navigator.clipboard.writeText(text);
  toast("Invite copied. Paste it in a text or group chat.");
}

// ---------- formatting ----------

const SETTING_LABEL = { doorstep: "At the door", outdoor: "Outside", in_home: "Inside a home", vehicle: "In a car" };
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function dayLabel(d) {
  const today = new Date();
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return dayFmt.format(d);
}
const fmtTime = (d) => timeFmt.format(d).replace(":00", "");

function fmtWindow(w) {
  const s = new Date(w.start);
  const e = new Date(w.end);
  if (s.toDateString() === e.toDateString()) return `${dayLabel(s)}, ${fmtTime(s)}–${fmtTime(e)}`;
  return `${dayLabel(s)} ${fmtTime(s)} → ${dayLabel(e)} ${fmtTime(e)}`;
}

function ago(iso) {
  const days = (Date.now() - new Date(iso)) / 864e5;
  if (days < 1 / 24) return "just now";
  if (days < 1) return `${Math.round(days * 24)}h ago`;
  if (days < 14) return `${Math.round(days)} day${Math.round(days) === 1 ? "" : "s"} ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

const toLocalInput = (d) => {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const repLine = (rep) => `${esc(rep.label)} · ${Math.round(rep.score)}/100 · ${rep.completed} done`;
const activeCircles = () => me.circles.filter((c) => c.status === "active");
const stateOptions = (selected = "") =>
  Object.entries(US_STATES).map(([code, name]) => `<option value="${code}" ${code === selected ? "selected" : ""}>${esc(name)}</option>`).join("");
const visibilityPill = (v) => v === "listed"
  ? `<span class="pill">🔎 Listed</span>`
  : `<span class="pill">🔒 Private</span>`;

// ---------- chrome & routing ----------
// Routes look like #/board, #/hoods/find, #/hoods/c_abc123, #/join/ABC-123.

const views = { board, ask, mine, hoods, me: profile, join: joinFromLink };

async function route() {
  clearInterval(pollTimer);
  const [name = "board", ...args] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);

  // #/signin/TOKEN: a private sign-in link. Take the token, then scrub it from the address bar.
  if (name === "signin" && args[0]) {
    token = args[0];
    storage.set("neighborly.token", token);
    me = null;
    history.replaceState(null, "", "/#/board");
    return route();
  }
  if (!token) {
    if (name === "join" && args[0]) pendingInviteKey = args[0];
    return renderWelcome();
  }
  if (!me) {
    try {
      me = await api("/api/me");
    } catch (err) {
      if (!token) return renderWelcome();
      app.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      return;
    }
    await renderChrome();
  }

  // First stop for anyone not in a neighborhood yet.
  const view = views[name] ? name : "board";
  const needsCircle = ["board", "ask"].includes(view) && me.circles.length === 0;
  const tab = needsCircle ? "hoods" : view === "join" ? "hoods" : view;
  document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  try {
    await (needsCircle ? hoods() : views[view](...args));
  } catch (err) {
    app.innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
  window.scrollTo(0, 0);
}

const refreshMe = async () => {
  me = await api("/api/me");
};

async function renderChrome() {
  $("#tabs").hidden = !me;
  $("#demo-banner").hidden = !me?.demo;
  $("#circle-name").textContent = me
    ? me.circles.filter((c) => c.status === "active").map((c) => c.name).join(" · ") || "No neighborhood yet"
    : "";
  const right = $("#topbar-right");
  if (!me) return (right.innerHTML = "");
  if (me.demo) {
    const people = await api("/api/demo/people");
    right.innerHTML = `
      <select id="switch-user" class="switcher" aria-label="Viewing as">
        ${people.map((p) => `<option value="${esc(p.token)}" ${p.token === token ? "selected" : ""}>
          ${esc(p.name.split(" ")[0])}: ${p.isOrganizer ? "organizer" : p.volunteering ? (p.isMinor ? "volunteer, 16" : "volunteer") : p.circles ? "asking" : "new"}
        </option>`).join("")}
      </select>`;
    $("#switch-user").onchange = (e) => {
      token = e.target.value;
      storage.set("neighborly.token", token);
      me = null;
      route();
    };
  } else {
    right.innerHTML = `<span class="pill">${esc(me.person.name.split(" ")[0])}</span>`;
  }
}

function signOut() {
  token = null;
  me = null;
  storage.set("neighborly.token", null);
  renderChrome();
  location.hash = "";
  renderWelcome();
}

// ---------- welcome & sign-up ----------

async function renderWelcome() {
  $("#tabs").hidden = true;
  $("#circle-name").textContent = "";
  let demoPeople = [];
  try {
    demoPeople = await api("/api/demo/people");
  } catch { /* not in demo mode */ }
  let invitedTo = null;
  if (pendingInviteKey) {
    try {
      invitedTo = await api(`/api/circles/preview?key=${encodeURIComponent(pendingInviteKey)}`);
    } catch (err) {
      pendingInviteKey = null;
      toast(err.message, true);
    }
  }

  app.innerHTML = `
    <div class="welcome fadein">
      <img src="/icon.svg" alt="">
      <h1>Small help, from neighbors you trust</h1>
      <p class="lede">Groceries, yard work, a ride, a tech fix. Neighborly matches each request with the neighbor best placed to help right now.</p>
    </div>
    ${invitedTo ? `<div class="notice good">You've been invited to <b>${esc(invitedTo.name)}</b> in ${esc(invitedTo.city)}, ${esc(invitedTo.state)}. Create your account and you'll join right away.</div>` : `
    <div class="how">
      <div><span class="n">1</span><span><b>Start or join a neighborhood.</b> Your street, church, school club, or troop. Nobody gets in without the group's say-so.</span></div>
      <div><span class="n">2</span><span><b>Ask in one sentence.</b> "Need help carrying groceries in Saturday morning."</span></div>
      <div><span class="n">3</span><span><b>The right helper sees it first.</b> Ranked by urgency, distance, and skills, with the reason shown.</span></div>
    </div>`}
    <form class="card" id="signup-form">
      <h3>Create your account</h3>
      <label class="field"><span>Your name</span><input type="text" name="name" maxlength="40" required autocomplete="name"></label>
      <div class="field"><span class="label">Where you are</span>
        <button type="button" class="btn block" id="loc-btn">📍 Use my location</button>
        <input type="hidden" name="location" id="loc-val">
        <p class="muted" id="loc-status" style="margin:6px 0 16px">Used only to show how far requests are. It's rounded to about half a mile on your phone before it's sent.</p>
      </div>
      <label class="check"><input type="checkbox" name="isMinor" id="minor"><span>I'm under 18</span></label>
      <div id="guardian" class="guardian-box" hidden>
        <p class="small" style="margin:0 0 10px">Under 18? We need a parent or guardian. Organizers can see this, and so can neighbors you help.</p>
        <label class="field"><span>Parent/guardian name</span>
          <input type="text" name="guardianName" maxlength="60" autocomplete="off" placeholder="e.g. Anita Patel"></label>
        <label class="field" style="margin-bottom:0"><span>Parent/guardian phone</span>
          <input type="tel" name="guardianPhone" maxlength="25" autocomplete="off" placeholder="(555) 123-4567"></label>
      </div>
      <label class="check"><input type="checkbox" required><span class="small">I understand Neighborly is for everyday practical help, not medical or personal care, and I'll use good judgment when meeting people.</span></label>
      <button class="btn primary block">Get started</button>
    </form>
    ${demoPeople.length ? `
      <h2>Or try the demo as…</h2>
      <div class="stack">${demoPeople.map((p) => `
        <button class="btn block" data-action="demo-login" data-token="${esc(p.token)}" style="justify-content:space-between">
          <span>${esc(p.name)}</span>
          <span class="muted">${p.isOrganizer ? "organizer" : p.volunteering ? (p.isMinor ? "volunteer, under 18" : "volunteer") : p.circles ? "asking for help" : "waiting to join"}</span>
        </button>`).join("")}</div>` : ""}`;

  locationButton("#loc-btn", "#loc-val", "#loc-status");
  $("#minor").onchange = (e) => {
    $("#guardian").hidden = !e.target.checked;
    document.querySelectorAll("#guardian input").forEach((i) => (i.required = e.target.checked));
  };
  $("#signup-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const res = await api("/api/signup", {
        method: "POST",
        body: {
          name: f.get("name"),
          location: f.get("location") ? JSON.parse(f.get("location")) : null,
          isMinor: f.get("isMinor") === "on",
          guardianName: f.get("guardianName"),
          guardianPhone: f.get("guardianPhone"),
        },
      });
      token = res.token;
      storage.set("neighborly.token", token);
      if (pendingInviteKey) {
        const joined = await api("/api/circles/join", { method: "POST", body: { key: pendingInviteKey } }).catch((err) => {
          toast(err.message, true);
          return null;
        });
        pendingInviteKey = null;
        if (joined) {
          toast(`Welcome to ${joined.name}!`);
          location.hash = `#/hoods/${joined.id}`;
          return route();
        }
      }
      location.hash = "#/hoods";
      route();
    } catch (err) {
      toast(err.message, true);
    }
  };
}

/** #/join/KEY while signed in: confirm, then join. */
async function joinFromLink(key = "") {
  return hoodJoin(key);
}

// ---------- neighborhoods ----------

function hoods(sub, ...rest) {
  if (sub === "new") return hoodCreate();
  if (sub === "join") return hoodJoin(rest[0] ?? "");
  if (sub === "find") return hoodFind();
  if (sub) return hoodDetail(sub);
  return hoodList();
}

async function hoodList() {
  await refreshMe();
  const mineList = me.circles;
  app.innerHTML = `
    <h1>Neighborhoods</h1>
    <p class="lede">${mineList.length ? "Requests from every neighborhood you're in show up on your board." : "Start one for your street or group, or join one you've been invited to."}</p>
    <div class="choice-grid">
      <a class="choice" href="#/hoods/new"><span class="ico">＋</span><b>Create</b><span>Start one and invite people</span></a>
      <a class="choice" href="#/hoods/join"><span class="ico">🔑</span><b>Join with key</b><span>Someone gave you a key</span></a>
      <a class="choice" href="#/hoods/find"><span class="ico">🔎</span><b>Find nearby</b><span>Search and ask to join</span></a>
    </div>
    ${mineList.length ? `<h2>Yours</h2>${mineList.map((c) => `
      <a class="card hood-card fadein" href="${c.status === "active" ? `#/hoods/${esc(c.id)}` : "#/hoods"}">
        <div class="row spread">
          <div><div class="req-title" style="margin:0">${esc(c.name)}</div>
            <div class="muted">${esc(c.city)}, ${esc(c.state)}</div></div>
          <span class="chev" aria-hidden="true">›</span>
        </div>
        <div class="row" style="margin-top:10px">
          ${visibilityPill(c.visibility)}
          ${c.status === "pending" ? `<span class="pill warn">Waiting for an organizer to approve you</span>` : ""}
          ${c.role === "organizer" ? `<span class="pill brand">Organizer</span>` : ""}
          ${c.pending ? `<span class="pill bad">${c.pending} asking to join</span>` : ""}
          ${c.appeals ? `<span class="pill bad">${c.appeals} appeal${c.appeals === 1 ? "" : "s"} to review</span>` : ""}
        </div>
      </a>`).join("")}` : ""}`;
}

async function hoodCreate() {
  await refreshMe();
  app.innerHTML = `
    <a class="back" href="#/hoods">‹ Neighborhoods</a>
    <h1>Create a neighborhood</h1>
    <p class="lede">You'll be its organizer: you invite people, approve anyone who asks to join, and handle safety reports.</p>
    <form class="card" id="create-form">
      <label class="field"><span>Name</span><input type="text" name="name" maxlength="60" required placeholder="e.g. Birch Court Neighbors"></label>
      <div class="grid3">
        <label class="field"><span>City</span><input type="text" name="city" maxlength="40" required autocomplete="address-level2"></label>
        <label class="field" style="grid-column:span 2"><span>State</span>
          <select name="state" required><option value="">Choose…</option>${stateOptions()}</select></label>
      </div>
      <label class="field"><span>Short description (optional)</span>
        <input type="text" name="description" maxlength="200" placeholder="Who it's for, e.g. the houses around Birch Ct"></label>

      <div class="field"><span class="label">Who can get in?</span>
        <label class="radio-card"><input type="radio" name="visibility" value="private" checked>
          <span><b>🔒 Private</b><br><span class="muted">Hidden from search. People join only with your invite key or link.</span></span></label>
        <label class="radio-card"><input type="radio" name="visibility" value="listed">
          <span><b>🔎 Listed</b><br><span class="muted">Neighbors can find it by searching and ask to join. You approve each person. Your invite key still works too.</span></span></label>
      </div>

      <div class="field"><span class="label">Where is it?</span>
        <button type="button" class="btn block" id="loc-btn">📍 ${me.person.location ? "Use my current location instead" : "Use my location"}</button>
        <input type="hidden" name="location" id="loc-val">
        <p class="muted" id="loc-status" style="margin:6px 0 0">${me.person.location ? "Using your saved location (rounded to about half a mile)." : "Needed so neighbors can find it by distance. Rounded to about half a mile."}</p>
      </div>
      <button class="btn primary block">Create neighborhood</button>
    </form>`;

  locationButton("#loc-btn", "#loc-val", "#loc-status");
  $("#create-form").onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const res = await api("/api/circles", {
        method: "POST",
        body: {
          name: f.get("name"), city: f.get("city"), state: f.get("state"),
          description: f.get("description"), visibility: f.get("visibility"),
          location: f.get("location") ? JSON.parse(f.get("location")) : null,
        },
      });
      await refreshMe();
      await renderChrome();
      toast("Neighborhood created!");
      location.hash = `#/hoods/${res.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  };
}

function hoodJoin(prefill = "") {
  app.innerHTML = `
    <a class="back" href="#/hoods">‹ Neighborhoods</a>
    <h1>Join with a key</h1>
    <p class="lede">Enter the invite key from your neighborhood's organizer or a friend who's already in.</p>
    <form class="card" id="key-form">
      <label class="field"><span>Invite key</span>
        <input type="text" name="key" value="${esc(prefill)}" required autocomplete="off" autocapitalize="characters"
          placeholder="ABC-123" class="key-input"></label>
      <button class="btn primary block">Join</button>
    </form>
    <p class="muted">No key? <a href="#/hoods/find">Find a listed neighborhood</a> and ask to join.</p>`;
  $("#key-form").onsubmit = async (e) => {
    e.preventDefault();
    try {
      const res = await api("/api/circles/join", { method: "POST", body: { key: new FormData(e.target).get("key") } });
      await refreshMe();
      await renderChrome();
      toast(`Welcome to ${res.name}!`);
      location.hash = `#/hoods/${res.id}`;
    } catch (err) {
      toast(err.message, true);
    }
  };
}

let findState = { q: "", state: "", within: "" };

async function hoodFind() {
  await refreshMe();
  const hasLoc = Boolean(me.person.location);
  app.innerHTML = `
    <a class="back" href="#/hoods">‹ Neighborhoods</a>
    <h1>Find a neighborhood</h1>
    <p class="lede">Listed neighborhoods only. Private ones never show up here. Every one has an organizer who approves new members.</p>
    <form id="find-form" class="card find-bar">
      <input type="search" name="q" placeholder="Search by name or city" value="${esc(findState.q)}" aria-label="Search">
      <div class="grid2">
        <select name="state" aria-label="State"><option value="">All states</option>${stateOptions(findState.state)}</select>
        <select name="within" aria-label="Distance" ${hasLoc ? "" : "disabled"}>
          ${[["", "Any distance"], ["2", "Within 2 mi"], ["5", "Within 5 mi"], ["10", "Within 10 mi"], ["25", "Within 25 mi"], ["50", "Within 50 mi"]]
            .map(([v, l]) => `<option value="${v}" ${v === findState.within ? "selected" : ""}>${l}</option>`).join("")}
        </select>
      </div>
      ${hasLoc ? "" : `<button type="button" class="btn small" id="find-loc">📍 Use my location to sort by distance</button>`}
    </form>
    <div id="results" aria-live="polite"></div>`;

  const form = $("#find-form");
  let debounce;
  const run = async () => {
    const f = new FormData(form);
    findState = { q: f.get("q") ?? "", state: f.get("state") ?? "", within: f.get("within") ?? "" };
    const results = await api(`/api/circles/search?${new URLSearchParams(findState)}`);
    $("#results").innerHTML = results.length ? results.map(findCard).join("") : `
      <div class="empty card"><div class="big">🏡</div>
        <p>No listed neighborhoods match. You could <a href="#/hoods/new">start one</a>.</p></div>`;
  };
  form.oninput = () => { clearTimeout(debounce); debounce = setTimeout(run, 200); };
  form.onsubmit = (e) => { e.preventDefault(); run(); };
  $("#find-loc")?.addEventListener("click", async () => {
    try {
      await api("/api/me", { method: "PUT", body: { location: await getRoundedLocation() } });
      toast("Location saved");
      hoodFind();
    } catch (err) {
      toast(err.message, true);
    }
  });
  await run();
}

function findCard(c) {
  const action = c.myStatus === "active"
    ? `<a class="btn small" href="#/hoods/${esc(c.id)}">You're a member ›</a>`
    : c.myStatus === "pending"
      ? `<span class="pill warn">Request sent, waiting for approval</span>`
      : c.myStatus === "denied" || c.myStatus === "removed"
        ? `<span class="pill">Ask the organizer for a key</span>`
        : `<button class="btn small primary" data-action="ask-join" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Ask to join</button>`;
  return `
    <article class="card fadein">
      <div class="row spread">
        <div><div class="req-title" style="margin:0">${esc(c.name)}</div>
          <div class="muted">${esc(c.city)}, ${esc(c.state)}${c.miles != null ? ` · ${c.miles < 0.5 ? "right around you" : `${c.miles} mi away`}` : ""}</div></div>
        <span class="pill">${c.members} member${c.members === 1 ? "" : "s"}</span>
      </div>
      ${c.description ? `<p class="small" style="margin:10px 0 0;color:var(--ink-2)">${esc(c.description)}</p>` : ""}
      <div class="actions">${action}</div>
    </article>`;
}

async function hoodDetail(id) {
  const [c, m] = await Promise.all([api(`/api/circles/${id}`), api(`/api/circles/${id}/metrics`)]);
  const organizer = c.role === "organizer";
  app.innerHTML = `
    <a class="back" href="#/hoods">‹ Neighborhoods</a>
    <h1>${esc(c.name)}</h1>
    <div class="row" style="margin-bottom:16px">
      <span class="muted">${esc(c.city)}, ${esc(c.state)}</span>${visibilityPill(c.visibility)}
      ${organizer ? `<span class="pill brand">You're an organizer</span>` : ""}
    </div>
    ${c.description ? `<p class="lede">${esc(c.description)}</p>` : ""}

    ${organizer ? inviteCard(c) + pendingSection(c) : ""}

    <h2>Impact</h2>
    ${impactSection(m, c)}

    ${organizer ? organizerSection(c) : ""}

    <div class="actions" style="margin-top:24px">
      <button class="btn danger" data-action="leave" data-id="${esc(c.id)}" data-name="${esc(c.name)}">Leave neighborhood</button>
    </div>`;
}

function inviteCard(c) {
  return `
    <section class="card invite">
      <div class="muted">Invite key</div>
      <div class="key">${esc(c.inviteKey)}</div>
      <p class="small" style="color:var(--ink-2)">Anyone with this key or link joins right away, no approval needed. Share it with people you know.</p>
      <div class="actions">
        <button class="btn primary" data-action="share-invite" data-name="${esc(c.name)}" data-key="${esc(c.inviteKey)}">Share invite link</button>
        <button class="btn small" data-action="rotate-key" data-id="${esc(c.id)}">Make a new key</button>
      </div>
    </section>`;
}

function pendingSection(c) {
  if (!c.pendingPeople.length) return "";
  return `
    <h2>Asking to join <span class="pill bad">${c.pendingPeople.length}</span></h2>
    ${c.pendingPeople.map((p) => `
      <article class="card fadein">
        <div class="row spread"><b>${esc(p.name)}</b>${p.isMinor ? `<span class="pill warn">Under 18</span>` : ""}</div>
        ${p.note ? `<p class="small" style="margin:6px 0 0;color:var(--ink-2)">"${esc(p.note)}"</p>` : ""}
        <div class="muted" style="margin-top:6px">Asked ${ago(p.requestedAt)} · ${p.reputation.confidence > 0 ? repLine(p.reputation) : "No history yet"}
          ${p.isMinor ? `<br>Guardian: ${esc(p.guardianContact)}` : ""}</div>
        <div class="actions">
          <button class="btn primary small" data-action="member" data-decision="approve" data-circle="${esc(c.id)}" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Approve</button>
          <button class="btn small" data-action="member" data-decision="deny" data-circle="${esc(c.id)}" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Decline</button>
        </div>
      </article>`).join("")}`;
}

function impactSection(m, c) {
  const maxPosted = Math.max(1, ...m.byTask.map((t) => t.posted));
  const pct = (x) => `${Math.round(x * 100)}%`;
  return `
    <div class="hero">${esc(me.demo ? m.sentence.replace("real requests", "sample requests") : m.sentence)}</div>
    <div class="tiles">
      <div class="tile"><div class="num">${m.posted}</div><div class="lbl">requests posted</div></div>
      <div class="tile"><div class="num">${pct(m.matchedPct)}</div><div class="lbl">found a volunteer</div></div>
      <div class="tile"><div class="num">${m.medianHoursToMatch == null ? "–" : m.medianHoursToMatch < 1 ? `${Math.round(m.medianHoursToMatch * 60)}m` : `${m.medianHoursToMatch.toFixed(1)}h`}</div><div class="lbl">median time to match</div></div>
      <div class="tile"><div class="num">${c.members}</div><div class="lbl">members · ${c.volunteers} volunteer${c.volunteers === 1 ? "" : "s"}</div></div>
    </div>
    ${m.posted ? `
    <div class="card hbars" style="margin-top:12px" role="table" aria-label="Requests posted and matched by task type">
      ${m.byTask.map((t) => `
        <div class="hbar" role="row" title="${esc(t.label)}: ${t.posted} posted, ${t.matched} matched">
          <span role="cell">${esc(t.label)}</span>
          <span class="track" role="cell"><i style="width:${(t.posted / maxPosted) * 100}%"></i></span>
          <span class="v" role="cell">${t.posted} <span class="muted">(${t.matched} ✓)</span></span>
        </div>`).join("")}
      <p class="muted" style="margin:0">Bar = requests posted. ✓ = how many found a volunteer.</p>
    </div>` : ""}`;
}

const APPEAL_PILL = { pending: ["Needs a decision", "bad"], overturned: ["No-show removed", "good"], upheld: ["No-show kept", ""] };

/** One appeal, with the context an organizer needs to decide fairly. */
function appealCard(a, circleId) {
  const [label, tone] = APPEAL_PILL[a.status];
  const v = a.volunteer;
  const rq = a.requester;
  const reportRate = rq.requests ? Math.round((rq.noShowsReported / rq.requests) * 100) : 0;
  return `
    <article class="card fadein ${a.status === "pending" ? "card-bad" : ""}">
      <div class="row spread"><b>${esc(v.name)} appeals a no-show</b><span class="pill ${tone}">${label}</span></div>
      ${a.request ? `<div class="muted" style="margin-top:4px">"${esc(a.request.description)}" · ${fmtWindow(a.request.window)}</div>` : ""}
      <blockquote class="statement">${esc(a.statement)}</blockquote>
      ${a.imageCount ? `<div class="row">${Array.from({ length: a.imageCount }, (_, n) =>
        `<button class="btn small" data-action="appeal-photo" data-id="${esc(a.id)}" data-n="${n}">📷 Photo ${n + 1}</button>`).join("")}</div>` : ""}
      <div class="appeal-context">
        <div><b>${esc(v.name)}</b>${v.isMinor ? ` <span class="pill warn">Under 18</span>` : ""}<br>
          <span class="muted">${repLine(v.reputation)} · ${v.noShows} no-show${v.noShows === 1 ? "" : "s"} total</span></div>
        <div><b>Reported by ${esc(rq.name)}</b><br>
          <span class="muted">has reported ${rq.noShowsReported} no-show${rq.noShowsReported === 1 ? "" : "s"} across ${rq.requests} request${rq.requests === 1 ? "" : "s"}${reportRate >= 50 && rq.noShowsReported >= 2 ? ` <span class="pill warn">reports a lot</span>` : ""}</span></div>
      </div>
      ${a.status === "pending" ? a.conflict
        ? `<p class="small muted" style="margin:10px 0 0">You're part of this case, so another organizer has to decide it.</p>`
        : `<label class="field" style="margin:12px 0 0"><span>Note to ${esc(v.name.split(" ")[0])} (optional)</span>
             <input type="text" id="appeal-note-${esc(a.id)}" maxlength="300" placeholder="e.g. Talked to both of you. Thanks for the photo."></label>
           <div class="actions">
             <button class="btn primary" data-action="decide-appeal" data-decision="overturn" data-id="${esc(a.id)}" data-circle="${esc(circleId)}">Remove the no-show</button>
             <button class="btn" data-action="decide-appeal" data-decision="uphold" data-id="${esc(a.id)}" data-circle="${esc(circleId)}">Keep it</button>
           </div>`
        : a.decisionNote ? `<p class="small muted" style="margin:10px 0 0">Your note: ${esc(a.decisionNote)}</p>` : ""}
    </article>`;
}

function organizerSection(c) {
  const open = c.reports.filter((r) => !r.resolved);
  const pendingAppeals = c.appeals.filter((a) => a.status === "pending").length;
  return `
    <h2>Organizer tools</h2>
    <h3 class="subhead">No-show appeals <span class="pill ${pendingAppeals ? "bad" : "good"}">${pendingAppeals} to review</span></h3>
    ${c.appeals.length ? c.appeals.map((a) => appealCard(a, c.id)).join("")
      : `<p class="muted">Volunteers who were reported as a no-show can appeal with a statement and photos. Appeals show up here.</p>`}
    <div class="card">
      <div class="row spread"><h3 style="margin:0">Safety reports</h3><span class="pill ${open.length ? "bad" : "good"}">${open.length} open</span></div>
      ${c.reports.length ? c.reports.map((r) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--border)">
          <div class="small"><b>${esc(r.fromName)}</b> · ${ago(r.at)} ${r.resolved ? `<span class="pill good">resolved</span>` : ""}</div>
          <div>${esc(r.note)}</div>
          ${r.resolved ? "" : `<button class="btn small" style="margin-top:6px" data-action="resolve" data-circle="${esc(c.id)}" data-id="${esc(r.id)}">Mark resolved</button>`}
        </div>`).join("") : `<p class="muted" style="margin:8px 0 0">No reports. Members can report a concern from any task.</p>`}
    </div>
    <div class="card">
      <h3>Members</h3>
      <div class="table-wrap"><table class="members">
        <thead><tr><th>Name</th><th>Reliability</th><th></th></tr></thead>
        <tbody>${c.people.map((p) => `
          <tr>
            <td><b>${esc(p.name)}</b>${p.role === "organizer" ? ` <span class="pill brand">organizer</span>` : ""}
              ${p.isMinor ? `<div class="small"><span class="pill warn">Under 18</span> Guardian: ${esc(p.guardianContact)}</div>` : ""}
              <div class="muted">${p.volunteering ? "volunteer · " : ""}joined ${ago(p.joinedAt)}</div></td>
            <td class="small">${p.volunteering || p.reputation.confidence > 0
              ? `${esc(p.reputation.label)}<br><span class="muted">${Math.round(p.reputation.score)}/100</span>`
              : `<span class="muted">not volunteering</span>`}</td>
            <td style="text-align:right">${p.id === me.person.id ? "" : `
              <div class="stack-sm">
                ${p.role !== "organizer" && !p.isMinor ? `<button class="btn small" data-action="member" data-decision="organizer" data-circle="${esc(c.id)}" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Make organizer</button>` : ""}
                <button class="btn small danger" data-action="member" data-decision="remove" data-circle="${esc(c.id)}" data-id="${esc(p.id)}" data-name="${esc(p.name)}">Remove</button>
              </div>`}</td>
          </tr>`).join("")}</tbody>
      </table></div>
    </div>
    <button class="btn block" data-action="csv" data-id="${esc(c.id)}">Download pilot data (CSV, anonymized)</button>`;
}

// ---------- board ----------

const HIDDEN_LABEL = (reason) => {
  if (reason.startsWith("under-18")) return "inside a home or in a car (under-18 safety rule)";
  return { "too far": "beyond your travel distance", "not available then": "outside the times you're free" }[reason] ?? reason;
};

async function board() {
  const data = await api("/api/board");
  if (!data.volunteering) {
    app.innerHTML = `
      <h1>Volunteer board</h1>
      <div class="empty card"><div class="big">🤝</div>
        <p>Turn on volunteering to see requests from your neighborhoods, ranked for you.</p>
        <a class="btn primary" href="#/me">Set up volunteering</a></div>`;
    return;
  }

  const hiddenEntries = Object.entries(
    Object.entries(data.hidden).reduce((acc, [reason, n]) => {
      const label = HIDDEN_LABEL(reason);
      acc[label] = (acc[label] ?? 0) + n;
      return acc;
    }, {})
  );
  const hiddenTotal = hiddenEntries.reduce((s, [, n]) => s + n, 0);
  const multi = data.circles > 1;

  app.innerHTML = `
    <div class="row spread"><h1>Your board</h1><span class="updated">Live · updated just now</span></div>
    <p class="lede">Open requests from ${multi ? `your ${data.circles} neighborhoods` : esc(activeCircles()[0]?.name ?? "your neighborhood")}, ranked for <b>you</b> by how urgent they are, how close, and how well they fit your skills.</p>
    <div class="legend" style="margin-bottom:14px">
      <span><b class="f-urgency"></b>Urgency ×${WEIGHTS.urgency}</span>
      <span><b class="f-distance"></b>Distance ×${WEIGHTS.distance}</span>
      <span><b class="f-skill"></b>Skill fit ×${WEIGHTS.skill}</span>
    </div>
    ${data.items.length ? data.items.map((item, i) => boardCard(item, i, multi)).join("") : `
      <div class="empty card"><div class="big">☀️</div><p>Nothing open that fits you right now. New requests show up here as they come in.</p></div>`}
    ${hiddenTotal ? `
      <div class="notice small">
        <b>${hiddenTotal} request${hiddenTotal === 1 ? " isn't" : "s aren't"} shown to you:</b>
        ${hiddenEntries.map(([label, n]) => `${n} ${esc(label)}`).join(" · ")}
      </div>` : ""}`;

  // Live: re-rank every 15s, unless the user is reading a breakdown or a dialog.
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    const onBoard = !location.hash || location.hash.startsWith("#/board");
    if (!onBoard || document.hidden || $("details[open]") || $("#dialog").open) return;
    board().catch(() => {});
  }, 15000);
}

function boardCard(item, i, multi) {
  const r = item.request;
  const p = item.parts;
  const contrib = (k) => WEIGHTS[k] * p[k];
  const factors = [
    ["urgency", "Urgency", "How soon it's needed (halves every 24h of lead time), plus a boost if the person is housebound."],
    ["distance", "Distance", `1.0 next door, down to 0 at your ${me.person.maxDistanceMiles}-mile limit.`],
    ["skill", "Skill fit", "1.0 if it's one of your skills, 0.3 otherwise, so willing helpers still see it."],
  ];
  return `
    <article class="card fadein rank-${i + 1}">
      <div class="row spread">
        <div class="row">
          <span class="rank-num" title="Rank for you">${i + 1}</span>
          <span class="pill brand">${esc(r.taskLabel)}</span>
          <span class="pill">${SETTING_LABEL[r.setting]}</span>
        </div>
      </div>
      <div class="req-title">${esc(r.description)}</div>
      <div class="muted">${esc(r.onBehalfOf ? `${r.onBehalfOf} (via ${r.requesterName})` : r.requesterName)} · ${fmtWindow(r.window)}${multi ? ` · <span class="circle-tag">${esc(r.circleName)}</span>` : ""}</div>
      <div class="why">${item.why.split(" · ").map((b) => `<span class="${/housebound|within/.test(b) ? "hot" : ""}">${esc(b)}</span>`).join("")}</div>
      <div class="score">
        <div class="score-bar" role="img" aria-label="Match score ${Math.round(item.total * 100)} out of 100">
          ${factors.map(([k, label]) => `<i class="f-${k}" style="width:${contrib(k) * 100}%" title="${label}: ${p[k].toFixed(2)} × ${WEIGHTS[k]} = ${contrib(k).toFixed(2)}"></i>`).join("")}
        </div>
        <span class="score-val">${Math.round(item.total * 100)}</span>
      </div>
      <details class="math"><summary>How was this ranked?</summary>
        <table>
          ${factors.map(([k, label]) => `<tr><td><b class="f-${k}" style="display:inline-block;width:9px;height:9px;border-radius:3px;margin-right:6px"></b>${label}</td><td>${p[k].toFixed(2)}</td><td>× ${WEIGHTS[k]}</td><td>${contrib(k).toFixed(2)}</td></tr>`).join("")}
          <tr><td>Match score</td><td></td><td></td><td>${item.total.toFixed(2)}</td></tr>
        </table>
        <ul style="padding-left:18px;margin:10px 0 0">${factors.map(([, label, how]) => `<li><b>${label}:</b> ${how}</li>`).join("")}</ul>
      </details>
      <div class="actions"><button class="btn primary" data-action="accept" data-id="${esc(r.id)}">I can help</button></div>
    </article>`;
}

// ---------- ask ----------

function ask() {
  const circles = activeCircles();
  if (!circles.length) {
    app.innerHTML = `
      <h1>Ask for help</h1>
      <div class="empty card"><div class="big">🏡</div><p>Join a neighborhood first, so your request goes to people you can trust.</p>
        <a class="btn primary" href="#/hoods">Neighborhoods</a></div>`;
    return;
  }
  const now = new Date();
  const later = new Date(now.getTime() + 3 * 864e5);
  app.innerHTML = `
    <h1>Ask for help</h1>
    <p class="lede">Describe it like you'd text a neighbor. We'll fill in the details; check them before posting.</p>
    <form id="ask-form">
      <label class="field"><span>What do you need?</span>
        <textarea name="description" id="q" maxlength="280" required placeholder="Need help carrying groceries in Saturday morning, I'm recovering from knee surgery"></textarea></label>
      <div class="understood" id="understood" aria-live="polite"></div>
      <div id="scope"></div>
      <div class="card">
        ${circles.length > 1 ? `
          <label class="field"><span>Which neighborhood?</span>
            <select name="circleId">${circles.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join("")}</select></label>`
          : `<input type="hidden" name="circleId" value="${esc(circles[0].id)}">
             <p class="muted" style="margin-top:0">Posting to <b>${esc(circles[0].name)}</b></p>`}
        <label class="field"><span>Kind of help</span>
          <select name="taskType" id="taskType" required>
            <option value="">Choose…</option>
            ${Object.entries(TASK_TYPES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("")}
          </select></label>
        <div class="grid2">
          <label class="field"><span>Earliest</span><input type="datetime-local" name="start" id="start" value="${toLocalInput(now)}" required></label>
          <label class="field"><span>Latest (deadline)</span><input type="datetime-local" name="end" id="end" value="${toLocalInput(later)}" required></label>
        </div>
        <label class="check"><input type="checkbox" name="forSomeone" id="for-someone">
          <span>I'm asking for someone else<br><span class="muted">A neighbor or relative who doesn't use the app. You'll confirm when it's done.</span></span></label>
        <div id="for-fields" hidden>
          <label class="field"><span>Their first name</span>
            <input type="text" name="onBehalfOf" maxlength="40" placeholder="e.g. Mrs. Lee"></label>
          <div class="field">
            <button type="button" class="btn small" id="req-loc-btn">📍 I'm at their place: use my current location</button>
            <input type="hidden" name="location" id="req-loc-val">
            <p class="muted" id="req-loc-status" style="margin:6px 0 16px">Otherwise we'll use your saved location to show distance.</p>
          </div>
        </div>
        <label class="check"><input type="checkbox" name="housebound" id="housebound">
          <span><span id="housebound-label">I can't easily get out right now</span><br><span class="muted">Moves the request up for volunteers.</span></span></label>
        <label class="field"><span>🔒 Phone number to reach you (optional)</span>
          <input type="tel" name="contactPhone" maxlength="25" autocomplete="tel" placeholder="(555) 123-4567"></label>
        <label class="field"><span>🔒 Private details (optional)</span>
          <textarea name="privateDetails" maxlength="200" placeholder="Street address, which door, gate code…"></textarea></label>
        <p class="muted" style="margin-top:-8px">🔒 fields are shown only to the one volunteer who accepts. Everyone else just sees how far away the request is.</p>
      </div>
      <p class="muted">Neighborly is for everyday practical help. For medical needs or personal care, please contact a professional.</p>
      <button class="btn primary block" id="post-btn">Post request</button>
    </form>`;

  const form = $("#ask-form");
  $("#for-someone").onchange = (e) => {
    $("#for-fields").hidden = !e.target.checked;
    $("#for-fields input[name=onBehalfOf]").required = e.target.checked;
    $("#housebound-label").textContent = e.target.checked ? "They can't easily get out right now" : "I can't easily get out right now";
  };
  locationButton("#req-loc-btn", "#req-loc-val", "#req-loc-status");
  const touched = new Set();
  ["taskType", "start", "end", "housebound"].forEach((id) => $(`#${id}`).addEventListener("change", () => touched.add(id)));

  $("#q").addEventListener("input", (e) => {
    const text = e.target.value;
    if (!text.trim()) return ($("#understood").innerHTML = "");
    const parsed = parseQuickPost(text, new Date());
    if (parsed.taskType && !touched.has("taskType")) $("#taskType").value = parsed.taskType;
    if (!touched.has("start")) $("#start").value = toLocalInput(parsed.window.start);
    if (!touched.has("end")) $("#end").value = toLocalInput(parsed.window.end);
    if (!touched.has("housebound")) $("#housebound").checked = parsed.housebound;

    const chips = [];
    if (parsed.taskType) chips.push(`<span class="pill brand">✓ ${esc(TASK_TYPES[parsed.taskType].label)}</span>`);
    chips.push(`<span class="pill brand">✓ ${esc(parsed.window.label)}</span>`);
    if (parsed.housebound) chips.push(`<span class="pill warn">✓ Housebound: higher priority</span>`);
    $("#understood").innerHTML = `<span class="muted" style="margin-right:2px">Understood:</span>${chips.join("")}`;
    $("#scope").innerHTML = parsed.scope.ok ? "" : `<div class="notice bad">${esc(parsed.scope.reason)}</div>`;
    $("#post-btn").disabled = !parsed.scope.ok;
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const start = new Date(f.get("start"));
    const end = new Date(f.get("end"));
    if (end <= start) return toast("The deadline has to be after the earliest time", true);
    try {
      await api("/api/requests", {
        method: "POST",
        body: {
          circleId: f.get("circleId"), description: f.get("description"), taskType: f.get("taskType"),
          start: start.toISOString(), end: end.toISOString(),
          housebound: f.get("housebound") === "on", privateDetails: f.get("privateDetails"),
          contactPhone: f.get("contactPhone"),
          onBehalfOf: f.get("forSomeone") === "on" ? f.get("onBehalfOf") : "",
          location: f.get("forSomeone") === "on" && f.get("location") ? JSON.parse(f.get("location")) : null,
        },
      });
      toast("Posted! Want it seen faster? Share it to your group chat.");
      location.hash = "#/mine";
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- mine ----------

// Two tabs: requests you asked for, and tasks you're helping with. Each has
// Active and Past. #/mine/requests and #/mine/helping link straight to a tab.
async function mine(tab) {
  const { posted, accepted } = await api("/api/mine");
  if (tab !== "requests" && tab !== "helping") {
    tab = me.person.volunteering || (accepted.length && !posted.length) ? "helping" : "requests";
  }
  const requestActive = (r) => r.status === "open" || r.status === "accepted";
  const helpActive = (r) => r.myStatus === "active";
  const needsAppeal = accepted.filter((r) => r.canAppeal).length;
  const activeRequests = posted.filter(requestActive).length;
  const activeHelping = accepted.filter(helpActive).length;

  const section = (title, items, render, empty) => `
    <h2>${title}</h2>
    ${items.length ? items.map(render).join("") : `<p class="muted">${empty}</p>`}`;

  const body = tab === "requests"
    ? section("Active", posted.filter(requestActive), requestCard, `No open requests. <a href="#/ask">Ask for help</a>.`)
      + section("Past", posted.filter((r) => !requestActive(r)), requestCard, "Finished and withdrawn requests show up here.")
    : section("Active", accepted.filter(helpActive), taskCard, `Nothing right now. Pick something from your <a href="#/board">board</a>.`)
      + section("Past", accepted.filter((r) => !helpActive(r)), taskCard, "Tasks you've finished show up here.");

  app.innerHTML = `
    <h1>Mine</h1>
    <div class="segmented" role="tablist">
      <a role="tab" href="#/mine/requests" class="${tab === "requests" ? "on" : ""}" aria-selected="${tab === "requests"}">
        My requests${activeRequests ? ` <span class="count">${activeRequests}</span>` : ""}</a>
      <a role="tab" href="#/mine/helping" class="${tab === "helping" ? "on" : ""}" aria-selected="${tab === "helping"}">
        Helping with${needsAppeal ? ` <span class="count bad" title="Something you can appeal">!</span>` : activeHelping ? ` <span class="count">${activeHelping}</span>` : ""}</a>
    </div>
    ${body}`;
}

const STATUS = {
  open: ["Waiting for a volunteer", "warn"],
  accepted: ["Someone's helping", "good"],
  completed: ["Done", "good"],
  cancelled: ["Withdrawn", ""],
};

function requestCard(r) {
  const [label, tone] = STATUS[r.status];
  const v = r.volunteer;
  return `
    <article class="card fadein">
      <div class="row spread"><span class="pill brand">${esc(r.taskLabel)}</span>
        <span class="pill ${tone}">${r.status === "accepted" && v ? `${esc(v.name)} is helping` : r.status === "completed" && v ? `Done by ${esc(v.name)}` : label}</span></div>
      <div class="req-title">${esc(r.description)}</div>
      <div class="muted">${r.onBehalfOf ? `For ${esc(r.onBehalfOf)} · ` : ""}${fmtWindow(r.window)} · ${esc(r.circleName)} · posted ${ago(r.createdAt)}</div>
      ${r.status === "accepted" && v ? `
        <div class="notice good" style="margin:12px 0 0">
          <b>${esc(v.name)}</b>${v.isMinor ? ` <span class="pill">Under 18</span>` : ""} accepted.
          <div class="small">${repLine(v.reputation)}</div>
          ${v.phone ? `<div class="small">📞 <a href="tel:${esc(v.phone)}">${esc(v.phone)}</a></div>` : ""}
          ${v.isMinor && v.guardianContact ? `<div class="small">Parent/guardian: ${esc(v.guardianContact)}</div>` : ""}
          ${r.privateDetails || r.contactPhone ? `<div class="small">They can now see your 🔒 details.</div>` : ""}
        </div>
        <div class="actions">
          <button class="btn primary" data-action="complete" data-id="${esc(r.id)}" data-name="${esc(v.name)}">✓ It's done</button>
          <button class="btn" data-action="noshow" data-id="${esc(r.id)}" data-name="${esc(v.name)}">They didn't come</button>
          <button class="btn small" data-action="report" data-id="${esc(r.id)}">Report a concern</button>
        </div>` : ""}
      ${r.status === "open" ? `<div class="actions">
        <button class="btn small primary" data-action="share-request" data-desc="${esc(r.description)}" data-when="${esc(fmtWindow(r.window))}" data-circle="${esc(r.circleName)}">Share to group chat</button>
        <button class="btn small" data-action="withdraw" data-id="${esc(r.id)}">Withdraw request</button>
      </div>` : ""}
    </article>`;
}

const HELP_STATUS = {
  active: ["You're helping", "good"],
  completed: ["✓ Done", "good"],
  no_show: ["Reported as a no-show", "bad"],
  no_show_overturned: ["No-show removed on appeal", "good"],
  cancelled_late: ["You cancelled late", "warn"],
};

const APPEAL_STATUS = {
  pending: ["Appeal sent. Waiting for an organizer to review it.", "warn"],
  overturned: ["Appeal accepted: the no-show was removed from your record.", "good"],
  upheld: ["Appeal reviewed: the organizer kept the no-show.", "bad"],
};

function taskCard(r) {
  const [label, tone] = HELP_STATUS[r.myStatus];
  const daysLeft = r.canAppeal ? Math.max(1, Math.ceil(14 - (Date.now() - new Date(r.eventAt)) / 864e5)) : 0;
  return `
    <article class="card fadein ${r.myStatus === "no_show" ? "card-bad" : ""}">
      <div class="row spread"><span class="pill brand">${esc(r.taskLabel)}</span><span class="pill ${tone}">${label}</span></div>
      <div class="req-title">${esc(r.description)}</div>
      <div class="muted">For ${esc(r.onBehalfOf || r.requesterName)}${r.onBehalfOf ? ` (posted by ${esc(r.requesterName)})` : ""} · ${fmtWindow(r.window)} · ${esc(r.circleName)}</div>
      ${r.myStatus === "active" ? `
        <div class="notice lock" style="margin:12px 0 0">🔒 <b>Shared only with you:</b>
          ${r.contactPhone ? `<div>📞 <a href="tel:${esc(r.contactPhone)}">${esc(r.contactPhone)}</a></div>` : ""}
          ${r.privateDetails ? `<div>${esc(r.privateDetails)}</div>` : ""}
          ${!r.privateDetails && !r.contactPhone ? `<span class="muted">No contact details were added. Ask your neighborhood's organizer to put you in touch with ${esc(r.requesterName)}.</span>` : ""}
        </div>
        <div class="actions">
          <button class="btn" data-action="cancel" data-id="${esc(r.id)}" data-start="${esc(r.window.start)}">I can't make it</button>
          <button class="btn small" data-action="report" data-id="${esc(r.id)}">Report a concern</button>
        </div>
        <p class="muted" style="margin:10px 0 0">${esc(r.requesterName)} will mark it done after you help, which builds your reliability.</p>` : ""}
      ${r.myStatus === "no_show" && !r.appeal ? `
        <p class="small" style="margin:10px 0 0;color:var(--bad-ink)">${esc(r.requesterName)} said you didn't come (${ago(r.eventAt)}). That costs 15 points on your reliability.</p>
        ${r.canAppeal ? `
          <div class="actions">
            <button class="btn danger-solid" data-action="appeal" data-id="${esc(r.id)}" data-desc="${esc(r.description)}" data-name="${esc(r.requesterName)}">I was there: appeal</button>
          </div>
          <p class="muted" style="margin:8px 0 0">${daysLeft} day${daysLeft === 1 ? "" : "s"} left to appeal.</p>`
          : `<p class="muted" style="margin:8px 0 0">The 14-day appeal window has closed.</p>`}` : ""}
      ${r.appeal ? `
        <div class="notice ${APPEAL_STATUS[r.appeal.status][1]} small" style="margin:12px 0 0">
          ${APPEAL_STATUS[r.appeal.status][0]}
          ${r.appeal.decisionNote ? `<div style="margin-top:4px"><b>Organizer's note:</b> ${esc(r.appeal.decisionNote)}</div>` : ""}
        </div>` : ""}
    </article>`;
}

// ---------- me / profile ----------

/** The score as a sum anyone can check: 60 + getting started + consistency − penalties. */
function repBreakdown(parts, nextGain) {
  const row = (label, hint, value) => `<tr><td>${label}<div class="muted">${hint}</div></td><td>${value}</td></tr>`;
  return `
    <table class="rep-math">
      ${row("Starting score", "everyone begins here", parts.start)}
      ${row("Getting started", "fills fast, mostly done after ~4 tasks", `+${parts.quick.toFixed(1)} <span class="muted">/ 20</span>`)}
      ${row("Consistency", `fills slowly over ~20 tasks · ${Math.round(parts.followThrough * 100)}% follow-through`, `+${parts.steady.toFixed(1)} <span class="muted">/ 20</span>`)}
      ${parts.penalty > 0.05 ? row("Missed or late", "no-show −15, late cancel −6, fading over time", `−${parts.penalty.toFixed(1)}`) : ""}
    </table>
    <p class="small" style="margin:10px 0 0">Your next completed task: <b>+${nextGain.toFixed(1)}</b></p>`;
}

async function profile() {
  await refreshMe();
  const p = me.person;
  const rep = me.reputation;
  const now = new Date();
  const outcomeText = { completed: "✓ Completed a task", cancelled_late: "Cancelled late", no_show: "✗ Didn't show" };
  const circles = activeCircles();
  const history = p.history.map((e) => ({ ...e, at: new Date(e.at) }));
  const nextGain = reputation([...history, { outcome: "completed", at: now }], now).score - reputation(history, now).score;
  const counted = countedFlags(history);
  const events = history.map((e, i) => ({ ...e, counted: counted[i] })).sort((a, b) => b.at - a.at);

  app.innerHTML = `
    <h1>${esc(p.name)}</h1>
    <p class="lede">${circles.length ? circles.map((c) => esc(c.name)).join(" · ") : "Not in a neighborhood yet"}</p>

    <section class="card">
      <div class="row spread"><h3 style="margin:0">Reliability</h3><span class="pill ${rep.label === "Mixed history" ? "warn" : "brand"}">${esc(rep.label)}</span></div>
      <div class="rep-big" style="margin-top:10px"><span class="num">${Math.round(rep.score)}</span><span class="muted">/ 100 · ${rep.completed} tasks completed</span></div>
      ${repBreakdown(rep.parts, nextGain)}
      <p class="small" style="color:var(--ink-2);margin-top:12px">
        This is what neighbors see when you offer to help, in every neighborhood you're in.
        Reaching 80 takes a few good tasks; getting past 90 takes many, with no slip-ups.
        Recent tasks count most: each one's weight halves every 90 days. Missed tasks fade more slowly.
      </p>
      ${events.length ? `
        <ul class="events">
          ${events.map((e) => {
            const good = e.outcome === "completed";
            if (e.overturned) {
              return `<li><span><s>${outcomeText[e.outcome]}</s> <span class="muted">${ago(e.at)}</span></span>
                <span class="small" style="grid-column:span 2;text-align:right;color:var(--good-ink)">removed on appeal</span></li>`;
            }
            if (good && !e.counted) {
              return `<li><span>${outcomeText[e.outcome]} <span class="muted">${ago(e.at)}</span></span>
                <span class="small muted" style="grid-column:span 2;text-align:right">doesn't count: more than ${SAME_NEIGHBOR.max} for the same neighbor in ${SAME_NEIGHBOR.days} days</span></li>`;
            }
            const w = (good ? decayWeight : penaltyWeight)(e.at, now);
            const right = good ? `${Math.round(w * 100)}%` : `−${(PENALTY[e.outcome] * w).toFixed(1)}`;
            return `<li><span>${outcomeText[e.outcome]} <span class="muted">${ago(e.at)}</span></span>
              <span class="wbar ${good ? "" : "bad"}" title="${good ? `Counts ${Math.round(w * 100)}% today` : `Costing ${(PENALTY[e.outcome] * w).toFixed(1)} points today`}"><i style="width:${w * 100}%"></i></span>
              <span class="muted" style="text-align:right">${right}</span></li>`;
          }).join("")}
        </ul>
        <p class="muted" style="margin:6px 0 0">Bars show how much each event still counts today.</p>` : `<p class="muted">No tasks yet. Your history will show up here.</p>`}
    </section>

    <form class="card" id="profile-form">
      <label class="check"><input type="checkbox" name="volunteering" ${p.volunteering ? "checked" : ""}>
        <span><b>I want to volunteer</b><br><span class="muted">Your board will show requests from your neighborhoods that fit you.</span></span></label>
      ${p.isMinor ? `<div class="notice warn small"><b>Under-18 safety rule:</b> you can help at the door or outside (groceries, yard work, leaves) but not inside someone's home or in a car. Guardian on file: ${esc(p.guardianContact)}</div>` : ""}
      <div class="field"><span class="label">What you're happy to do</span>
        <div class="chips">${Object.entries(TASK_TYPES).map(([k, t]) => {
          const blocked = p.isMinor && !MINOR_ALLOWED_SETTINGS.has(t.setting);
          return `<label class="chip"><input type="checkbox" name="skills" value="${k}" ${p.skills.includes(k) ? "checked" : ""} ${blocked ? "disabled" : ""}><span>${esc(t.label)}</span></label>`;
        }).join("")}</div></div>
      <div class="field" style="margin-top:16px"><span class="label">When you're usually free</span>
        <div class="chips">${Object.entries(SLOTS).map(([k, s]) =>
          `<label class="chip"><input type="checkbox" name="slots" value="${k}" ${p.slots.includes(k) ? "checked" : ""}><span>${esc(s.label)}</span></label>`).join("")}</div></div>
      <label class="field" style="margin-top:16px"><span>How far you'll go: <output id="miles-out">${p.maxDistanceMiles}</output> mi</span>
        <input type="range" name="maxDistanceMiles" min="0.5" max="10" step="0.5" value="${p.maxDistanceMiles}" style="width:100%;accent-color:var(--brand)"></label>
      <div class="field"><span class="label">Your location</span>
        <div class="row spread">
          <span class="small">${p.location ? "📍 Set, rounded to about half a mile" : `<span class="pill warn">Not set: needed to volunteer</span>`}</span>
          <button type="button" class="btn small" id="update-loc">Use my current location</button>
        </div>
      </div>
      <label class="field"><span>Phone (optional)</span>
        <input type="tel" name="phone" maxlength="25" autocomplete="tel" value="${esc(p.phone ?? "")}" placeholder="(555) 123-4567">
        <span class="muted" style="display:block;margin-top:5px;font-weight:400">Shared only with neighbors whose request you accept, so they can reach you.${p.isMinor ? " Your guardian's contact is shared with them too." : ""}</span></label>
      <button class="btn primary block">Save</button>
    </form>

    <section class="card">
      <h3>Use Neighborly on another device</h3>
      <p class="small" style="color:var(--ink-2)">Your account lives in this browser. Save this private link (text it to yourself) to sign in on a new phone, or if you clear your browser.</p>
      <div class="notice warn small">Anyone with this link can act as you. Don't share it.</div>
      <button type="button" class="btn" data-action="copy-signin">Copy my sign-in link</button>
    </section>
    ${me.demo ? "" : `<button class="btn block" data-action="signout">Sign out</button>`}`;

  const form = $("#profile-form");
  form.maxDistanceMiles.oninput = (e) => ($("#miles-out").textContent = e.target.value);
  $("#update-loc").onclick = async () => {
    try {
      await api("/api/me", { method: "PUT", body: { location: await getRoundedLocation() } });
      toast("Location updated");
      profile();
    } catch (err) {
      toast(err.message, true);
    }
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      await api("/api/me", {
        method: "PUT",
        body: {
          volunteering: f.get("volunteering") === "on",
          skills: f.getAll("skills"),
          slots: f.getAll("slots"),
          maxDistanceMiles: Number(f.get("maxDistanceMiles")),
          phone: f.get("phone"),
        },
      });
      await refreshMe();
      toast("Saved");
      if (me.person.volunteering) location.hash = "#/board";
    } catch (err) {
      toast(err.message, true);
    }
  };
}

// ---------- actions (event delegation) ----------

const actions = {
  async "demo-login"(el) {
    token = el.dataset.token;
    storage.set("neighborly.token", token);
    me = null;
    location.hash = "#/board";
    await route();
  },
  async accept(el) {
    await api(`/api/requests/${el.dataset.id}/accept`, { method: "POST" });
    toast("You're on it! Details are under Mine.");
    location.hash = "#/mine";
  },
  async complete(el) {
    await api(`/api/requests/${el.dataset.id}/complete`, { method: "POST" });
    toast(`Marked done. Thanks for letting ${el.dataset.name} know it counted!`);
    await route();
  },
  async noshow(el) {
    const ok = await confirmDialog(`Did ${el.dataset.name} not come?`,
      "This goes on their reliability record and your request reopens for other volunteers.", "Yes, report no-show", true);
    if (!ok) return;
    await api(`/api/requests/${el.dataset.id}/noshow`, { method: "POST" });
    toast("Reported. Your request is open again.");
    await route();
  },
  async cancel(el) {
    const hours = (new Date(el.dataset.start) - Date.now()) / 36e5;
    const late = hours < 12;
    const ok = await confirmDialog("Can't make it?",
      late ? "It's less than 12 hours before the start time, so this will count as a <b>late cancellation</b> on your reliability. The request goes back on the board."
           : "No problem. You're giving plenty of notice, so this won't affect your reliability. The request goes back on the board.",
      "Release it", late);
    if (!ok) return;
    await api(`/api/requests/${el.dataset.id}/cancel`, { method: "POST" });
    toast("Released back to the board.");
    await route();
  },
  async withdraw(el) {
    if (!(await confirmDialog("Withdraw this request?", "Volunteers will no longer see it.", "Withdraw"))) return;
    await api(`/api/requests/${el.dataset.id}/withdraw`, { method: "POST" });
    await route();
  },
  report(el) {
    openDialog(`
      <h3>Report a concern</h3>
      <p class="small">This goes privately to the neighborhood's organizers. If anyone is in danger, call 911 first.</p>
      <form><label class="field"><span>What happened?</span><textarea name="note" maxlength="500" required></textarea></label>
      <div class="actions"><button class="btn primary">Send to organizer</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
      async (f) => {
        await api("/api/reports", { method: "POST", body: { requestId: el.dataset.id, note: f.get("note") } });
        toast("Sent to the organizers.");
      });
  },
  "ask-join"(el) {
    openDialog(`
      <h3>Ask to join ${esc(el.dataset.name)}</h3>
      <p class="small">An organizer will see your name and this note, and decide whether to let you in.</p>
      <form><label class="field"><span>Say who you are (optional)</span>
        <textarea name="note" maxlength="200" placeholder="e.g. I live on Birch Ct, two houses down from the park."></textarea></label>
      <div class="actions"><button class="btn primary">Send request</button><button class="btn" type="button" data-close>Cancel</button></div></form>`,
      async (f) => {
        await api(`/api/circles/${el.dataset.id}/request`, { method: "POST", body: { note: f.get("note") } });
        toast("Request sent. You'll be in once an organizer approves.");
        await hoodFind();
      });
  },
  /** No private details, no names: just enough for the group chat to go check the app. */
  async "share-request"(el) {
    const { desc, when, circle } = el.dataset;
    const text = `Can anyone in ${circle} help? "${desc}" (${when}). If you can, tap "I can help" on Neighborly: ${location.origin}/#/board`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "Can anyone help?", text });
        return;
      } catch { /* cancelled; fall through to copy */ }
    }
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it in your group chat.");
  },
  appeal(el) {
    const photos = [];
    openDialog(`
      <h3>Appeal this no-show</h3>
      <p class="small">${esc(el.dataset.name)} reported that you didn't come for "${esc(el.dataset.desc)}".
        Tell the organizer what happened. They'll decide, and if they agree, the 15-point penalty is removed.</p>
      <form>
        <label class="field"><span>What happened?</span>
          <textarea name="statement" maxlength="1000" minlength="20" required
            placeholder="e.g. I got there at 10:05, knocked and rang twice, and texted the number they gave. I waited 15 minutes."></textarea></label>
        <div class="field"><span class="label">Photos (optional, up to 3)</span>
          <label class="btn small" style="cursor:pointer">📷 Add photos
            <input type="file" accept="image/*" multiple id="appeal-files" hidden></label>
          <div class="appeal-thumbs" id="appeal-thumbs"></div>
          <p class="muted" style="margin:6px 0 0">e.g. a photo at the door or a screenshot of your texts. Location data is removed from photos before upload.
            Only this neighborhood's organizers will see them.</p>
        </div>
        <div class="actions"><button class="btn primary">Send appeal</button><button class="btn" type="button" data-close>Cancel</button></div>
      </form>`,
      async (f) => {
        await api("/api/appeals", { method: "POST", body: { requestId: el.dataset.id, statement: f.get("statement"), images: photos } });
        toast("Appeal sent to the organizers.");
        await route();
      });

    const thumbs = $("#appeal-thumbs");
    const draw = () => {
      thumbs.innerHTML = photos.map((src, i) => `
        <span class="thumb"><img src="${src}" alt="Photo ${i + 1}">
          <button type="button" aria-label="Remove photo ${i + 1}" data-remove="${i}">×</button></span>`).join("");
    };
    thumbs.onclick = (e) => {
      const i = e.target.closest("[data-remove]")?.dataset.remove;
      if (i !== undefined) { photos.splice(Number(i), 1); draw(); }
    };
    $("#appeal-files").onchange = async (e) => {
      for (const file of [...e.target.files]) {
        if (photos.length >= 3) { toast("Up to 3 photos", true); break; }
        try {
          photos.push(await compressPhoto(file));
        } catch (err) {
          toast(err.message, true);
        }
      }
      e.target.value = "";
      draw();
    };
  },
  async "appeal-photo"(el) {
    const { dataUrl } = await api(`/api/appeals/${el.dataset.id}/images/${el.dataset.n}`);
    const dialog = $("#dialog");
    dialog.innerHTML = `<img src="${dataUrl}" alt="Appeal photo" style="width:100%;border-radius:10px;display:block">
      <div class="actions"><button class="btn" data-close>Close</button></div>`;
    dialog.showModal();
    $("[data-close]", dialog).onclick = () => dialog.close();
  },
  async "decide-appeal"(el) {
    const { id, decision, circle } = el.dataset;
    const note = $(`#appeal-note-${id}`)?.value ?? "";
    const ok = await confirmDialog(
      decision === "overturn" ? "Remove this no-show?" : "Keep this no-show?",
      decision === "overturn"
        ? "The 15-point penalty comes off their reliability score right away."
        : "The penalty stays. They'll see your note, if you wrote one.",
      decision === "overturn" ? "Remove it" : "Keep it");
    if (!ok) return;
    await api(`/api/appeals/${id}/decide`, { method: "POST", body: { decision, note } });
    toast(decision === "overturn" ? "No-show removed." : "No-show kept.");
    await hoodDetail(circle);
  },
  async "share-invite"(el) {
    await shareInvite({ name: el.dataset.name, inviteKey: el.dataset.key });
  },
  async "rotate-key"(el) {
    const ok = await confirmDialog("Make a new invite key?",
      "The old key and link stop working right away. People already in the neighborhood stay in.", "Make new key");
    if (!ok) return;
    await api(`/api/circles/${el.dataset.id}/key`, { method: "POST" });
    toast("New key ready.");
    await hoodDetail(el.dataset.id);
  },
  async member(el) {
    const { decision, circle, id, name } = el.dataset;
    if (decision === "remove") {
      const ok = await confirmDialog(`Remove ${name}?`,
        "They lose access to this neighborhood right away. Their open requests here are withdrawn and any tasks they accepted here go back on the board.", "Remove", true);
      if (!ok) return;
    }
    if (decision === "organizer") {
      const ok = await confirmDialog(`Make ${name} an organizer?`,
        "They'll be able to approve and remove members, see guardian contacts, and handle safety reports.", "Make organizer");
      if (!ok) return;
    }
    await api(`/api/circles/${circle}/members/${id}/${decision}`, { method: "POST" });
    toast({ approve: `${name} is in!`, deny: "Request declined.", remove: `${name} was removed.`, organizer: `${name} is now an organizer.` }[decision]);
    await hoodDetail(circle);
  },
  async leave(el) {
    const ok = await confirmDialog(`Leave ${el.dataset.name}?`,
      "Your open requests there are withdrawn and tasks you accepted there go back on the board. Your reliability stays with you.", "Leave", true);
    if (!ok) return;
    await api(`/api/circles/${el.dataset.id}/leave`, { method: "POST" });
    await refreshMe();
    await renderChrome();
    location.hash = "#/hoods";
  },
  async resolve(el) {
    await api(`/api/circles/${el.dataset.circle}/reports/${el.dataset.id}/resolve`, { method: "POST" });
    await hoodDetail(el.dataset.circle);
  },
  async csv(el) {
    const { csv } = await api(`/api/circles/${el.dataset.id}/metrics.csv`);
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "neighborly-pilot.csv" });
    a.click();
    URL.revokeObjectURL(url);
  },
  async "copy-signin"() {
    await navigator.clipboard.writeText(`${location.origin}/#/signin/${token}`);
    toast("Sign-in link copied. Keep it private.");
  },
  signout: signOut,
};

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  el.disabled = true;
  try {
    await actions[el.dataset.action](el);
  } catch (err) {
    toast(err.message, true);
  } finally {
    el.disabled = false;
  }
});

window.addEventListener("hashchange", route);
route();
