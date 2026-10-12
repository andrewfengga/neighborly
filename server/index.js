// Neighborly web server. No dependencies — just Node 20+.
//
//   npm start           real pilot data (see store.js for where it's saved)
//   npm run demo:web    fresh sample data every start, with a user switcher
//
// Then open http://localhost:3000
//
// Environment (all optional):
//   PORT                          set by the host
//   DATA_DIR                      folder for db.json, e.g. a persistent disk
//   UPSTASH_REDIS_REST_URL/TOKEN  save to Upstash Redis instead of a file

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, openUpstashStore } from "./store.js";
import { seedDemo } from "./seed.js";
import * as api from "./api.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO = process.argv.includes("--demo");
const PORT = Number(process.env.PORT) || 3000;
const { UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, DATA_DIR } = process.env;

const { db, save, blobs, where } = DEMO
  ? openStore(path.join(ROOT, "data/demo.json"), seedDemo())
  : UPSTASH_REDIS_REST_URL
    ? await openUpstashStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN })
    : openStore(path.join(DATA_DIR ?? path.join(ROOT, "data"), "db.json"));

// ---------- security headers ----------
// The app's own scripts only; Google Fonts for the typefaces; no framing.

const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "geolocation=(self), camera=(), microphone=()",
};

// ---------- rate limits ----------
// Per IP, in memory. Stops key-guessing and sign-up spam; normal use never hits them.

const LIMITS = {
  signup: { max: 10, windowMs: 60 * 60e3 }, // new accounts per hour
  key: { max: 20, windowMs: 10 * 60e3 }, // invite-key tries per 10 minutes
  write: { max: 120, windowMs: 60e3 }, // any change per minute
  upload: { max: 10, windowMs: 60 * 60e3 }, // appeals with photos per hour
};
const hits = new Map();

function overLimit(ip, bucket) {
  const { max, windowMs } = LIMITS[bucket];
  const id = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(id) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(id, recent);
  return recent.length > max;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, times] of hits) if (times.every((t) => now - t > 60 * 60e3)) hits.delete(id);
}, 10 * 60e3).unref();

const clientIp = (req) => (req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress;

function bucketsFor(method, pathname) {
  if (method === "GET" && pathname !== "/api/circles/preview") return [];
  const buckets = method === "GET" ? [] : ["write"];
  if (pathname === "/api/signup") buckets.push("signup");
  if (pathname === "/api/appeals") buckets.push("upload");
  if (pathname === "/api/circles/join" || pathname === "/api/circles/preview") buckets.push("key");
  return buckets;
}

// ---------- static files ----------
// Only public/ and the shared engine in src/ are served.

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  const rel = url.pathname === "/" ? "/index.html" : url.pathname;
  const base = rel.startsWith("/src/") ? ROOT : path.join(ROOT, "public");
  const file = path.resolve(base, "." + rel);
  const allowed = [path.join(ROOT, "public"), path.join(ROOT, "src")];
  if (!allowed.some((dir) => file.startsWith(dir + path.sep)) || !fs.existsSync(file)) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
}

// ---------- API ----------

function readBody(req, maxBytes = 20_000) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > maxBytes) reject(new api.ApiError("That's too large to upload", 413));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new api.ApiError("Invalid JSON"));
      }
    });
  });
}

// Routes: "METHOD /path/:param", handler(ctx), needsAuth, writes.
// Order matters: fixed paths like /circles/search come before /circles/:id.
const route = (spec, handler, needsAuth = true, writes = false) => {
  const [method, path] = spec.split(" ");
  const pattern = new RegExp(`^${path.replace(/\./g, "\\.").replace(/:\w+/g, "([\\w-]+)")}$`);
  return [method, pattern, handler, needsAuth, writes];
};

const routes = [
  // account
  route("POST /api/signup", (c) => api.signup(db, c.body, c.now), false, true),
  route("GET /api/me", (c) => api.me(db, c.me, { demo: DEMO }, c.now)),
  route("PUT /api/me", (c) => api.updateProfile(db, c.me, c.body), true, true),

  // neighborhoods
  route("POST /api/circles", (c) => api.createCircle(db, c.me, c.body, c.now), true, true),
  route("GET /api/circles/preview", (c) => api.previewKey(db, c.query.get("key")), false),
  route("GET /api/circles/search", (c) => api.searchCircles(db, c.me, c.query)),
  route("POST /api/circles/join", (c) => api.joinWithKey(db, c.me, c.body, c.now), true, true),
  route("GET /api/circles/:id", (c) => api.circleDetail(db, c.me, c.params[0], c.now)),
  route("POST /api/circles/:id/request", (c) => api.requestToJoin(db, c.me, c.params[0], c.body, c.now), true, true),
  route("POST /api/circles/:id/leave", (c) => api.leaveCircle(db, c.me, c.params[0]), true, true),
  route("POST /api/circles/:id/key", (c) => api.rotateKey(db, c.me, c.params[0]), true, true),
  route("POST /api/circles/:id/members/:pid/:decision",
    (c) => c.params[2] === "organizer"
      ? api.makeOrganizer(db, c.me, c.params[0], c.params[1])
      : api.decideMember(db, c.me, c.params[0], c.params[1], c.params[2], c.now), true, true),
  route("POST /api/circles/:id/reports/:rid/resolve", (c) => api.resolveReport(db, c.me, c.params[0], c.params[1]), true, true),
  route("GET /api/circles/:id/metrics", (c) => api.metrics(db, c.me, c.params[0])),
  route("GET /api/circles/:id/metrics.csv", (c) => ({ csv: api.metricsCsv(db, c.me, c.params[0]) })),

  // help requests
  route("GET /api/board", (c) => api.board(db, c.me, c.now)),
  route("POST /api/requests", (c) => api.postRequest(db, c.me, c.body, c.now), true, true),
  route("GET /api/mine", (c) => api.mine(db, c.me, c.now)),
  route("POST /api/requests/:id/:action", (c) => api.act(db, c.me, c.params[0], c.params[1], c.now), true, true),
  route("POST /api/reports", (c) => api.report(db, c.me, c.body, c.now), true, true),

  // appeals of no-show reports
  route("POST /api/appeals", (c) => api.fileAppeal(db, blobs, c.me, c.body, c.now), true, true),
  route("GET /api/appeals/:id/images/:n", (c) => api.appealImage(db, blobs, c.me, c.params[0], c.params[1])),
  route("POST /api/appeals/:id/decide", (c) => api.decideAppeal(db, c.me, c.params[0], c.body, c.now), true, true),

  // Demo mode only: the user switcher for recording the video.
  route("GET /api/demo/people", () => {
    if (!DEMO) throw new api.ApiError("Not found", 404);
    return db.people.filter((p) => !p.background).map((p) => {
      const active = db.memberships.filter((m) => m.personId === p.id && m.status === "active");
      return {
        name: p.name, token: p.token, isMinor: p.isMinor, volunteering: p.volunteering,
        isOrganizer: active.some((m) => m.role === "organizer"), circles: active.length,
      };
    });
  }, false),
];

async function handleApi(req, res) {
  const url = new URL(req.url, "http://x");
  const send = (status, payload) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  try {
    for (const bucket of bucketsFor(req.method, url.pathname)) {
      if (overLimit(clientIp(req), bucket)) throw new api.ApiError("Too many tries. Please wait a few minutes and try again.", 429);
    }
    for (const [method, pattern, handler, needsAuth = true, writes = false] of routes) {
      const match = url.pathname.match(pattern);
      if (!match || req.method !== method) continue;
      const ctx = { now: new Date(), params: match.slice(1), query: url.searchParams, body: {} };
      if (needsAuth) {
        const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
        ctx.me = api.personByToken(db, token);
        if (!ctx.me) throw new api.ApiError("Please sign in again", 401);
      }
      // Appeals can carry up to 3 photos; everything else is small.
      if (method !== "GET") ctx.body = await readBody(req, url.pathname === "/api/appeals" ? 3_000_000 : 20_000);
      const result = await handler(ctx);
      if (writes) save();
      return send(200, result);
    }
    send(404, { error: "Not found" });
  } catch (err) {
    if (!(err instanceof api.ApiError)) {
      // Engine validation errors (e.g. "Can't accept: too far") are user-facing too.
      if (err instanceof Error && !(err instanceof TypeError) && !(err instanceof ReferenceError)) {
        return send(400, { error: err.message });
      }
      console.error(err);
      return send(500, { error: "Something went wrong on our end" });
    }
    send(err.status, { error: err.message });
  }
}

http
  .createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (req.url === "/healthz") return res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
    return req.url.startsWith("/api/") ? handleApi(req, res) : serveStatic(req, res);
  })
  .listen(PORT, () => {
    console.log(`Neighborly running at http://localhost:${PORT}${DEMO ? "  (DEMO MODE — sample data)" : ""}`);
    console.log(`Saving data to: ${where}`);
  });
