# Putting Neighborly online

The app needs two things once it's on the internet:
1. **HTTPS**, because phones only allow "Use my location" on secure sites. Both options
   below include it automatically.
2. **Somewhere to save data that survives restarts.** Otherwise your pilot data
   disappears.

Pick one option.

---

## Option A: Free (Render + Upstash)

**Cost:** $0. **Catch:** after 15 minutes with no visitors, the free server goes to
sleep, and the next visit takes about 30–60 seconds to load. Open the site yourself a
minute before showing anyone, or before recording.

### 1. Make a free Upstash database (data storage)
1. Go to https://upstash.com and sign up.
2. Create a **Redis** database. Any name; pick the region closest to you; free plan.
3. On the database page, find the **REST API** section. Copy:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   Keep the token private. It's a password for your data.

### 2. Put the app on Render
1. Go to https://render.com and sign up with your GitHub account.
2. Click **New → Blueprint**, pick the `neighborly` repository, and click **Apply**.
   Render reads `render.yaml` and sets everything up.
3. When it asks for `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, paste the
   two values from step 1.
4. Wait for the deploy to finish (a few minutes). Your app is at
   `https://neighborly-xxxx.onrender.com`.
5. Check the **Logs** tab for `Saving data to: Upstash Redis`. If it says a file path
   instead, the two Upstash values weren't set.

---

## Option B: Always on (Railway)

**Cost:** a free trial credit, then about $5/month. **Plus:** it never sleeps, so links
open instantly.

1. Go to https://railway.com and sign up with GitHub.
2. **New Project → Deploy from GitHub repo →** pick `neighborly`.
3. Open the service, then **Settings → Networking → Generate Domain** to get your public
   https address.
4. Add saved storage: right-click the service → **Attach volume**, with mount path `/data`.
5. **Variables →** add `DATA_DIR` = `/data`.
6. Redeploy. The logs should say `Saving data to: /data/db.json`.

---

## After it's online

1. Open the site on your phone, create your account, then **Groups → Create** your
   neighborhood.
2. Tap **Share invite link** and send it to your friends.
3. Test the whole loop once with a friend: they post a request, you accept it, they
   mark it done, and your score goes up.

## Updating the app later

Push changes to GitHub, and both hosts redeploy automatically. Your data is kept.

## Backups

Before the video, organizers can download each neighborhood's anonymized numbers from
its page (**Download pilot data (CSV)**). Do this every few days during the pilot so you
always have a copy.
