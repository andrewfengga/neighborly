// The database: one JSON document, kept in memory and saved after every change.
// Fine for a pilot of a few hundred people; swap for Postgres if it ever grows.
//
// Two places it can be saved:
//   file     data/db.json, or $DATA_DIR/db.json (a persistent disk on the host)
//   upstash  a free Upstash Redis database, for hosts whose disk is wiped on
//            restart. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.

import fs from "node:fs";
import path from "node:path";

export const emptyDb = () => ({ people: [], circles: [], memberships: [], requests: [], reports: [], appeals: [] });
const withTables = (data) => ({ ...emptyDb(), ...data });

/** Synchronous file store. `initial` replaces whatever is on disk (demo mode). */
export function openStore(file, initial = null) {
  const db = withTables(initial ?? (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}));
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, file); // write-then-rename so a crash never leaves half a file
  };
  if (initial) save();

  // Photos live next to the database, one file each, never inside it.
  const dir = path.join(path.dirname(file), "uploads");
  const blobs = {
    async put(id, bytes) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${safeId(id)}.jpg`), bytes);
    },
    async get(id) {
      const f = path.join(dir, `${safeId(id)}.jpg`);
      return fs.existsSync(f) ? fs.readFileSync(f) : null;
    },
  };
  return { db, save, blobs, where: file };
}

const safeId = (id) => {
  if (!/^[\w-]+$/.test(id)) throw new Error("Bad file id");
  return id;
};

/** Upstash Redis over its REST API (plain fetch, no package needed). */
export async function openUpstashStore({ url, token, key = "neighborly:db" }) {
  const call = async (command) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    if (!res.ok) throw new Error(`Upstash ${command[0]} failed: ${res.status} ${await res.text()}`);
    return (await res.json()).result;
  };

  const stored = await call(["GET", key]);
  const db = withTables(stored ? JSON.parse(stored) : {});

  // Saves run one at a time, in order, so an older snapshot never overwrites a newer one.
  let chain = Promise.resolve();
  const save = () => {
    const snapshot = JSON.stringify(db);
    chain = chain
      .then(() => call(["SET", key, snapshot]))
      .catch((err) => console.error("SAVE FAILED, data may be lost on restart:", err.message));
    return chain;
  };
  // Photos get their own keys, so the main database stays small and fast.
  const blobs = {
    put: (id, bytes) => call(["SET", `neighborly:blob:${id}`, bytes.toString("base64")]),
    async get(id) {
      const b64 = await call(["GET", `neighborly:blob:${id}`]);
      return b64 ? Buffer.from(b64, "base64") : null;
    },
  };
  return { db, save, blobs, where: "Upstash Redis" };
}
