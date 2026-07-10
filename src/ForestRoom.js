// Player schema + ForestRoom: broadcasts presence (position, dir, look, name).
// Presence-only (Tier 1): the server does NOT own monsters/loot — those stay
// client-local. It relays where each connected player is so others can see them.
import { Room } from "@colyseus/core";
import { Schema, MapSchema, defineTypes } from "@colyseus/schema";

class Player extends Schema {
  constructor() {
    super();
    this.x = 55 * 24;
    this.y = 55 * 24;
    this.dir = "down";
    this.moving = false;
    this.name = "Anasta";
    this.look = "{}";   // JSON string of appearance (skin/hair/shirt/...)
  }
}
defineTypes(Player, {
  x: "number",
  y: "number",
  dir: "string",
  moving: "boolean",
  name: "string",
  look: "string",
});

class ForestState extends Schema {
  constructor() {
    super();
    this.players = new MapSchema();
  }
}
defineTypes(ForestState, {
  players: { map: Player },
});

export class ForestRoom extends Room {
  onCreate() {
    this.maxClients = 50;
    this.autoDispose = false;   // keep room alive so late joiners land in the same world
    this.setState(new ForestState());
    // patch rate: how often deltas are flushed to clients (ms). 50ms = 20Hz.
    this.setPatchRate(50);

    this.onMessage("move", (client, data) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || !data) return;
      // light sanity clamp (anti-garbage; real anti-cheat would verify deltas)
      if (typeof data.x === "number" && typeof data.y === "number") {
        p.x = Math.max(0, Math.min(110 * 24, data.x));
        p.y = Math.max(0, Math.min(110 * 24, data.y));
      }
      if (typeof data.dir === "string") p.dir = data.dir;
      if (typeof data.moving === "boolean") p.moving = data.moving;
    });

    this.onMessage("chat", (client, text) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof text !== "string") return;
      this.broadcast("chat", { name: p.name, text: String(text).slice(0, 120) });
    });

    console.log("ForestRoom created:", this.roomId);
  }

  onJoin(client, options = {}) {
    const p = new Player();
    p.name = (options.name || "Traveler").slice(0, 16);
    p.look = typeof options.look === "string" ? options.look.slice(0, 400) : "{}";
    if (typeof options.x === "number") p.x = options.x;
    if (typeof options.y === "number") p.y = options.y;
    this.state.players.set(client.sessionId, p);
    console.log(`${p.name} joined (${client.sessionId}). Players: ${this.state.players.size}`);
  }

  onLeave(client) {
    this.state.players.delete(client.sessionId);
    console.log(`Left ${client.sessionId}. Players: ${this.state.players.size}`);
  }

  onDispose() {
    console.log("ForestRoom disposed:", this.roomId);
  }
}
