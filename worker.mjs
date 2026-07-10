// Anasta presence server — Cloudflare Worker + Durable Object (free, no card).
// Durable Object "Room" holds all live WS connections and relays JSON messages.
// Browser WS works fine here (CF has proper WS proxy, unlike Railway free).

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map(); // id -> WebSocket
    this.meta = new Map();      // id -> { name, look, x, y, dir, moving }
    this.nextId = 1;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, players: this.sessions.size });
    }
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Anasta server — connect via WebSocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = pair;
    const id = "p" + (this.nextId++);
    this.sessions.set(id, server);
    this.meta.set(id, { id, name: "Traveler", look: "{}", x: 55 * 24, y: 55 * 24, dir: "down", moving: false });

    server.accept();

    const snapshot = () => [...this.meta.entries()].map(([i, m]) => ({
      id: i, name: m.name, look: m.look, x: Math.round(m.x), y: Math.round(m.y), dir: m.dir, moving: m.moving,
    }));

    const broadcast = (obj, exceptId) => {
      const msg = JSON.stringify(obj);
      for (const [i, ws] of this.sessions) {
        if (i === exceptId) continue;
        try { ws.send(msg); } catch {}
      }
    };

    server.addEventListener("message", (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      const meta = this.meta.get(id);
      if (!meta) return;

      if (m.t === "join") {
        meta.name = String(m.name || "Traveler").slice(0, 16);
        meta.look = String(m.look || "{}").slice(0, 4000);
        if (m.x) meta.x = m.x; if (m.y) meta.y = m.y;
        server.send(JSON.stringify({ t: "welcome", id, room: "forest" }));
        server.send(JSON.stringify({ t: "players", list: snapshot() }));
        broadcast({ t: "join", player: meta }, id);
        console.log(`${meta.name} joined (${id}). Players: ${this.sessions.size}`);
      } else if (m.t === "move") {
        meta.x = m.x; meta.y = m.y; meta.dir = m.dir; meta.moving = !!m.moving;
        broadcast({ t: "state", id, x: Math.round(meta.x), y: Math.round(meta.y), dir: meta.dir, moving: meta.moving }, id);
      } else if (m.t === "ping") {
        server.send(JSON.stringify({ t: "pong" }));
      } else if (m.t === "chat") {
        broadcast({ t: "chat", id, name: meta.name, text: String(m.text || "").slice(0, 200) });
      }
    });

    server.addEventListener("close", () => {
      const meta = this.meta.get(id);
      this.sessions.delete(id);
      this.meta.delete(id);
      broadcast({ t: "leave", id });
      if (meta) console.log(`${meta.name} left (${id}). Players: ${this.sessions.size}`);
    });

    server.addEventListener("error", () => { /* ignore */ });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const id = env.ROOM.idFromName("forest");
      const stub = env.ROOM.get(id);
      return stub.fetch(request);
    }
    const id = env.ROOM.idFromName("forest");
    const stub = env.ROOM.get(id);
    return stub.fetch(request);
  }
};
