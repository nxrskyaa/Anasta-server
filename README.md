# Anasta — Multiplayer Presence Server

Realtime "see other players walking around" server for **Anasta Chronicle**,
built on [Colyseus](https://colyseus.io) (Node + WebSocket).

This is **Tier 1: presence only** — it syncs each connected player's position,
facing, name, and appearance so everyone sees everyone else move in real time.
Monsters, loot, and combat remain client-local (not shared) in this tier.

---

## Run locally

```bash
cd anasta-server
npm install
npm start          # listens on ws://localhost:2567
```

Health check: open http://localhost:2567/health → `{"ok":true,...}`

Run the integration test (starts nothing itself — server must be running):

```bash
node test-presence.js   # → "TEST PASS ✅"
```

### Point the game at your local server
In `AnastaChronicle/js/config.js`:
```js
export const MULTIPLAYER_ENABLED = true;
export const SERVER_URL = "ws://localhost:2567";
```
Then open the game from two browser tabs/devices on the same machine — each is a
separate player and they'll see each other.

> Note: the **deployed** game on Vercel is HTTPS, so it can only talk to a
> `wss://` (TLS) server — a localhost `ws://` won't work from the live site.
> Deploy the server (below) and use its `wss://` URL for the live game.

---

## Deploy the server (free tier)

Colyseus needs a always-on host (Vercel can't do this). Two easy options:

### Option A — Railway (recommended)
1. Push this `anasta-server/` folder to a GitHub repo (its own repo is cleanest).
2. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
3. Select the repo. Railway auto-detects Node and runs `npm start`.
4. In the service **Settings → Networking**, click **Generate Domain**.
   You'll get something like `anasta-server-production.up.railway.app`.
5. Railway sets `PORT` automatically — the server already reads `process.env.PORT`.
6. Your WebSocket URL is: `wss://anasta-server-production.up.railway.app`

### Option B — Render
1. Push to GitHub.
2. https://render.com → **New → Web Service** → connect the repo.
3. Build command: `npm install` · Start command: `npm start`.
4. Instance type: **Free**.
5. Render gives you `https://anasta-server.onrender.com` →
   your WebSocket URL is `wss://anasta-server.onrender.com`.

### Then wire the live game to it
In `AnastaChronicle/js/config.js`:
```js
export const MULTIPLAYER_ENABLED = true;
export const SERVER_URL = "wss://YOUR-SERVER-DOMAIN";   // no trailing slash
```
Commit + redeploy the game to Vercel. Done — the live site is now multiplayer.

---

## Free-tier caveats
- **Cold starts:** free Railway/Render instances sleep when idle. The first player
  to connect after a nap may wait 10–30s while it wakes. Paid tier ($5–7/mo) stays warm.
- **Scale:** presence is light; a free instance handles ~20–50 players fine.
- **Anti-cheat:** this tier trusts client positions (fine for presence). If you go
  to Tier 2 (shared monsters/loot), the server must become authoritative.

## Protocol (for reference)
- Client → server: `room.send("move", { x, y, dir, moving })` (~12/sec, throttled)
- Client → server: `room.send("chat", "text")`
- Server → clients: auto state sync of `players` map (20Hz patch rate)
- Server → clients: `broadcast("chat", { name, text })`

## Version pinning (important)
Server and browser client **must** use matching Colyseus schema versions.
This project pins **Colyseus 0.15.x** (schema 2.x) on the server and
`colyseus.js@0.15.26` in the browser (loaded via CDN in `js/net.js`).
If you upgrade one, upgrade both.
