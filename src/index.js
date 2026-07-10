// Anasta presence server — plain JSON WebSocket relay (no Colyseus client needed).
// Browsers handle wss:// + JSON reliably; Colyseus' binary protocol over TLS was
// broken in colyseus.js 0.15.x. This keeps a single "forest" room and relays
// player positions/names/chat between everyone connected.
import http from "http";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 2567;
const ROOM = "forest";

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("Anasta presence server OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now(), players: players.size }));

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// id -> { ws, name, look, x, y, dir, moving }
const players = new Map();
let nextId = 1;

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function broadcast(obj, exceptId) {
  const msg = JSON.stringify(obj);
  for (const [id, p] of players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === p.ws.OPEN) p.ws.send(msg);
  }
}

function snapshot() {
  return [...players.values()].map((p) => ({
    id: p.id, name: p.name, look: p.look, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving,
  }));
}

wss.on("connection", (ws) => {
  let myId = null;

  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === "join") {
      myId = "p" + (nextId++);
      players.set(myId, {
        id: myId, ws,
        name: String(m.name || "Traveler").slice(0, 16),
        look: String(m.look || "{}").slice(0, 4000),
        x: m.x || 55 * 24, y: m.y || 55 * 24, dir: m.dir || "down", moving: false,
      });
      send(ws, { t: "welcome", id: myId, room: ROOM });
      send(ws, { t: "players", list: snapshot() });
      broadcast({ t: "join", player: players.get(myId) }, myId);
      console.log(`${players.get(myId).name} joined (${myId}). Players: ${players.size}`);
    }
    else if (m.t === "move" && myId) {
      const p = players.get(myId);
      if (!p) return;
      p.x = m.x; p.y = m.y; p.dir = m.dir; p.moving = !!m.moving;
      broadcast({ t: "state", id: myId, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving }, myId);
    }
    if (m.t === "ping") {
      send(ws, { t: "pong" });
    }
    else if (m.t === "chat" && myId) {
      const p = players.get(myId);
      if (!p) return;
      broadcast({ t: "chat", id: myId, name: p.name, text: String(m.text || "").slice(0, 200) });
    }
  });

  ws.on("close", () => {
    if (myId && players.has(myId)) {
      const name = players.get(myId).name;
      players.delete(myId);
      broadcast({ t: "leave", id: myId });
      console.log(`${name} left (${myId}). Players: ${players.size}`);
    }
  });
});

// Server-side heartbeat: keep the Railway TLS proxy from dropping idle browser
// sockets by sending a tiny tick to every client every 2s (two-way traffic).
setInterval(() => {
  broadcast({ t: "tick", ts: Date.now() });
}, 2000);

httpServer.listen(PORT, () => {
  console.log(`Anasta server listening on :${PORT}`);
});
