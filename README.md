# Neighborly

Small, real help (groceries, yard work, a ride, a tech fix) from neighbors you already trust.

Neighborhood groups already want to help each other. What's missing is a way to get a
specific need in front of the specific person who can help *right now*, and a reason
to trust that person. Neighborly does that inside neighborhoods that anyone can start,
but nobody can get into without the group's say-so.

## Run it

Requires Node 20+. No other dependencies.

```bash
npm run demo:web     # sample data + a user switcher, resets on every start
npm start            # real pilot data, saved in data/db.json
npm test             # 72 tests
```

Open http://localhost:3000. In demo mode, pick a person on the first screen, or switch
people with the menu in the top-right corner.

To start a real pilot: sign up in the app, tap **Groups → Create**, and share the invite
link it gives you. Anyone who opens the link creates an account and joins right away.

## How it works

### 0. Neighborhoods
Anyone can create a neighborhood (name, city, state, and a location rounded to about
half a mile) and becomes its organizer. Each neighborhood is either:
- **Private:** hidden from search. People join only with the invite key or link.
- **Listed:** searchable by name, city, state, and distance. People *ask* to join, and
  an organizer approves or declines each one. The invite key still works too.

People can belong to several neighborhoods. Their board combines requests from all of
them, and their reputation follows them between neighborhoods. Organizers can approve
members, remove members, make other adults organizers, and make a new invite key if
the old one leaks.

Organizers also get an **activity feed**: one card per request with its timeline
(posted → offered to help → done, plus cancellations, no-shows and appeals), split into
**Active** and **Past** and grouped into **Today / Past 7 days / Past 30 days / Older**.
Volunteers under 18 are flagged on every task they take. A "new updates" badge on the
Groups tab shows when something changed. Private details and phone numbers never
appear in the feed.

### 1. Ask in one sentence
"Need help carrying groceries in Saturday morning, I just had knee surgery" becomes a
grocery task, Saturday 8am–12pm, flagged housebound. The requester sees every guess and
can fix it before posting ([src/parse.js](src/parse.js)). The same file runs the
**scope check**: requests that sound like medical or personal care are refused, by the
server and not just the form.

### 2. Urgency-aware matching ([src/ranking.js](src/ranking.js))
Two stages:
- **Eligibility (hard rules):** same group, within the volunteer's travel distance,
  overlaps their free time, and allowed by the under-18 rules.
- **Scoring (soft ranking):** `0.45 × urgency + 0.30 × distance + 0.25 × skill fit`.
  Urgency halves for every 24 hours until the deadline, and housebound requesters get
  a boost.

Every card shows *why* it ranked where it did, with the full calculation one tap away.
Volunteers also see what they **aren't** shown and why ("3 inside a home or in a car,
under-18 safety rule").

### 3. Trust and safety
| Risk | Design |
|---|---|
| Strangers | No open neighborhoods. You get in with an invite key from a member, or an organizer approves you. Private neighborhoods never appear in search. Leaked key? The organizer makes a new one, and the old one stops working. |
| Minors | Under-18 members need a guardian contact, and they can only help **at the door or outside**: never inside a home or in a car. Enforced at sign-up, on the board, and again when they accept, so a direct API call can't get around it. |
| Exact addresses | Locations are rounded to about half a mile **on the phone, before they're sent**, and the board shows only a distance. Exact details are shown **only to the one volunteer who accepts**. |
| Fake reputation | Only the *requester* can confirm a task was completed or report a no-show. |
| Flaky volunteers | Late cancellations (under 12 hours' notice) and no-shows go on the record. A no-show reopens the request. |
| False no-show reports | A volunteer can appeal within 14 days with a statement and up to 3 photos (location data is stripped on the phone; only organizers see them). Organizers see how often the requester reports no-shows, can't rule on a case they're part of, and a removed no-show stops counting against the score. The penalty stays while an appeal is pending, so appealing everything doesn't dodge penalties. |
| Bad actors | Anyone can privately report a concern to the organizers. An organizer can remove a member, which cuts off their access to that neighborhood immediately, releases their tasks there, and blocks them from rejoining. |
| Out-of-scope care | Medical and personal-care requests are blocked. The app says it's for everyday help. |

### 4. Weighted-decay reputation ([src/reputation.js](src/reputation.js))
A 0–100 score that's easy to start and hard to max out:

```
score = 60 + up to 20 "getting started" + up to 20 "consistency" − penalties
```

- **Getting started** fills fast (`20 × (1 − e^(−n/2))`): about 3–4 good tasks gets you to 80.
- **Consistency** fills slowly (`20 × (1 − e^(−n/15))`) and is multiplied by your
  follow-through rate: reaching 95 takes about 20 tasks with no slip-ups. Every extra
  point costs more tasks than the one before.
- **Penalties are heavy:** a no-show is −15 and a late cancellation −6. One no-show
  wipes out most of the progress past 80.
- **Everything decays:** good tasks halve in weight every 90 days, and penalties every
  180 days, so mistakes stay on the record longer than successes.

Volunteers see the full breakdown and how much their next task would add.

### 5. Measured impact ([src/metrics.js](src/metrics.js))
The Impact tab computes the pilot claim from real timestamps only: *"Across N real
requests over M weeks, X% were matched with a volunteer within 24 hours."* Organizers
can export an anonymized CSV. In demo mode the numbers are labeled as sample data.

## Architecture

```
src/       the engine: pure functions, shared by the server AND the browser
server/    Node http server, JSON-file storage, every rule enforced here
public/    mobile-first web app, plain ES modules, no build step
test/      node:test suites for the engine, features, and API rules
```

The browser imports the same `src/` files the server runs, so the quick-post preview
and reputation breakdown match exactly what the server computes.

## Out of scope (future work)
- **Payments:** this is volunteer help.
- **Background checks:** trust comes from closed groups plus reputation for now. A
  check integration is the natural next step for opening beyond existing groups.
- **Medical or caregiving tasks:** these need licensed care, and the app actively
  blocks them.
- **Live GPS:** neighborhood-level locations are a deliberate privacy choice.

## Two-minute demo script

1. **(0:00) Problem.** A request posted on a group thread at 9am can sit for days. Say
   who you talked to and what they told you.
2. **(0:20) Ask.** As **Rosa**, type *"Need help carrying groceries in Saturday morning,
   I just had knee surgery."* Show the app understanding it, then post it.
3. **(0:45) Ranked board.** Switch to **Maya (16)**. Rosa's request is #1. Open "How was
   this ranked?" and point out the hidden-requests note: in-home and car tasks are
   filtered out because she's under 18.
4. **(1:10) Accept.** Maya taps "I can help", and Rosa's private details are shown only
   to her.
5. **(1:25) Complete.** Switch to Rosa, tap "It's done", then show Maya's reliability
   score going up and the decay bars.
6. **(1:40) Impact.** As **Priya** (organizer), show the impact tab and the safety tools.
   Close with your **real** pilot number.
