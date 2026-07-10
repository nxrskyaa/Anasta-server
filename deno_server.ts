// Anasta presence server — Deno Deploy version (no Colyseus, plain JSON WS).
// Free, no credit card, WebSocket-native. Deploy: `deno deploy --project anasta-server`
// Deno Deploy auto-binds the port; we just use Deno.serve + upgradeWebSocket.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const ROOM = "forest";
const players = new Map(); // id -> { id, socket, name, look, x, y, dir, moving }
let nextId = 1;

function snapshot() {
  return [...players.values()].map((p) => ({
    id: p.id, name: p.name, look: p.look,
    x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving,
  }));
}

function send(socket: WebSocket, obj: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

function broadcast(obj: unknown, exceptId?: string) {
  const msg = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.id === exceptId) continue;
    if (p.socket.readyState === WebSocket.OPEN) p.socket.send(msg);
  }
}

serve((req: Request) => {
  const url = new URL(req.url);

  // Upgrade to WebSocket MUST be checked first
  if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
    const { socket, response } = Deno.upgradeWebSocket(req);
    let myId: string | null = null;

    socket.onmessage = (e: MessageEvent) => {
      let m: any;
      try { m = JSON.parse(e.data as string); } catch { return; }

      if (m.t === "join") {
        myId = "p" + (nextId++);
        players.set(myId, {
          id: myId, socket,
          name: String(m.name || "Traveler").slice(0, 16),
          look: String(m.look || "{}").slice(0, 4000),
          x: m.x || 55 * 24, y: m.y || 55 * 24, dir: m.dir || "down", moving: false,
        });
        send(socket, { t: "welcome", id: myId, room: ROOM });
        send(socket, { t: "players", list: snapshot() });
        broadcast({ t: "join", player: players.get(myId) }, myId);
        console.log(`${players.get(myId)!.name} joined (${myId}). Players: ${players.size}`);
      } else if (m.t === "move" && myId) {
        const p = players.get(myId);
        if (!p) return;
        p.x = m.x; p.y = m.y; p.dir = m.dir; p.moving = !!m.moving;
        broadcast({ t: "state", id: myId, x: Math.round(p.x), y: Math.round(p.y), dir: p.dir, moving: p.moving }, myId);
      } else if (m.t === "ping") {
        send(socket, { t: "pong" });
      } else if (m.t === "chat" && myId) {
        const p = players.get(myId);
        if (!p) return;
        broadcast({ t: "chat", id: myId, name: p.name, text: String(m.text || "").slice(0, 200) });
      }
    };

    socket.onclose = () => {
      if (myId && players.has(myId)) {
        const name = players.get(myId)!.name;
        players.delete(myId);
        broadcast({ t: "leave", id: myId });
        console.log(`${name} left (${myId}). Players: ${players.size}`);
      }
    };

    return response;
  }

  // Non-WS routes (health checks, uptime)
  if (url.pathname === "/health") {
    return Response.json({ ok: true, ts: Date.now(), players: players.size });
  }
  if (url.pathname === "/" || url.pathname === "/ping") {
    return new Response("Anasta presence server OK", { status: 200 });
  }

  return new Response("Anasta server — use WebSocket", { status: 426 });
});

console.log("Anasta Deno server listening");
