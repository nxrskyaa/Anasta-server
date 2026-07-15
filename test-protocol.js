import assert from "node:assert/strict";
import {
  Room,
  BOSS_X,
  BOSS_Y,
  PVP_MAX_RANGE,
} from "./worker.mjs";

class FakeSocket {
  constructor() { this.sent = []; }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  clear() { this.sent.length = 0; }
  ofType(type) { return this.sent.filter((message) => message.t === type); }
}

function join(room, id, name, x, y, now) {
  const socket = new FakeSocket();
  room.sessions.set(id, socket);
  room.meta.set(id, {
    id,
    joined: false,
    name: "Traveler",
    look: "{}",
    x,
    y,
    dir: "down",
    moving: false,
    duel: false,
    lastChatAt: -Infinity,
    lastMoveAt: now,
  });
  room.handleMessage(id, socket, { t: "join", name, x, y }, now);
  // Unit fixtures place players directly after the production join-spawn guard.
  Object.assign(room.meta.get(id), { x, y, lastMoveAt: now });
  return socket;
}

const room = new Room({}, {});
room.setWorld("duel-arena");
const start = 1_700_000_000_000;
const alice = join(room, "p1", "Alice", BOSS_X + 40, BOSS_Y, start);
const bob = join(room, "p2", "Bob", BOSS_X + 70, BOSS_Y, start + 1);
const cara = join(room, "p3", "Cara", BOSS_X + 100, BOSS_Y, start + 2);
const distant = join(room, "p4", "Distant", 100, 100, start + 3);
const sockets = [alice, bob, cara, distant];

assert.equal(alice.ofType("welcome")[0].protocol, 2, "join advertises protocol v2");
assert.equal(alice.ofType("welcome")[0].world, "duel-arena", "join advertises the isolated world");
assert.equal(alice.ofType("welcome")[0].capabilities.pvp, true, "duel world advertises PvP capability");
assert.equal(alice.ofType("boss_state").length, 0, "duel world never leaks raid boss state");
assert.equal(room.snapshot().length, 4, "presence snapshot keeps all joined players");

for (const socket of sockets) socket.clear();
room.handleMessage("p1", alice, { t: "chat", text: "  hello\n   forest  " }, start + 1000);
assert.equal(alice.ofType("chat")[0].text, "hello forest", "chat is cleaned and echoed to sender");
assert.equal(bob.ofType("chat")[0].name, "Alice", "chat is broadcast to peers");

for (const socket of sockets) socket.clear();
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 10 }, start + 2000);
assert.equal(alice.ofType("pvp_reject")[0].reason, "mutual_duel_required", "PvP requires mutual opt-in");

for (const socket of sockets) socket.clear();
room.handleMessage("p1", alice, { t: "duel", active: true }, start + 2100);
room.handleMessage("p2", bob, { t: "duel", active: true }, start + 2101);
assert.equal(room.meta.get("p1").duel, true);
assert.equal(room.meta.get("p2").duel, true);
assert.equal(cara.ofType("duel").length, 2, "duel state is visible to the room");

for (const socket of sockets) socket.clear();
room.meta.get("p2").x = room.meta.get("p1").x + PVP_MAX_RANGE + 1;
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 10 }, start + 2300);
assert.equal(alice.ofType("pvp_reject")[0].reason, "out_of_range", "PvP validates distance");

alice.clear();
room.meta.get("p2").x = room.meta.get("p1").x + 30;
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 999 }, start + 2400);
assert.equal(alice.ofType("pvp_reject")[0].reason, "invalid_damage", "PvP rejects excessive damage");

for (const socket of sockets) socket.clear();
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 17.6, kind: "skill" }, start + 2500);
const acceptedHit = bob.ofType("pvp_hit")[0];
assert.deepEqual(
  { source: acceptedHit.source, target: acceptedHit.target, damage: acceptedHit.damage, kind: acceptedHit.kind },
  { source: "p1", target: "p2", damage: 18, kind: "skill" },
  "valid PvP hit is normalized and broadcast",
);
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 10 }, start + 2550);
assert.equal(alice.ofType("pvp_reject")[0].reason, "rate_limited", "PvP hit rate is bounded");

for (const socket of sockets) socket.clear();
room.handleMessage("p2", bob, { t: "duel", active: false }, start + 2700);
room.handleMessage("p1", alice, { t: "pvp_hit", target: "p2", damage: 10 }, start + 2900);
assert.equal(alice.ofType("pvp_reject")[0].reason, "mutual_duel_required", "turning duel off immediately restores protection");

for (const socket of sockets) socket.clear();
room.setWorld("raid-sanctum");
room.ensureBoss(start + 3900);
room.meta.get("p1").x = room.boss.x + 160;
room.meta.get("p1").y = room.boss.y;
const bossStartX = room.boss.x;
room.maybeBossMove(start + 4100);
assert.ok(room.boss.x > bossStartX, "shared boss moves toward the nearest active traveler");
assert.equal(alice.ofType("boss_move").length, 1, "boss movement is broadcast to every client");
assert.equal(alice.ofType("boss_move")[0].x, bob.ofType("boss_move")[0].x, "all clients receive the same boss position");
for (const socket of sockets) socket.clear();
room.boss.hp = 70;
room.boss.nextAttackAt = start + 4190;
room.handleMessage("p1", alice, { t: "boss_hit", bossId: room.boss.id, damage: 20 }, start + 4200);
assert.equal(room.boss.hp, 50, "first boss hit updates the shared HP pool");
assert.equal(alice.ofType("boss_attack").length, 1, "boss attack target is broadcast by the shared server");
assert.equal(bob.ofType("boss_attack")[0].target, alice.ofType("boss_attack")[0].target, "all clients receive the same boss target");
room.handleMessage("p3", cara, { t: "boss_hit", bossId: room.boss.id, damage: 20 }, start + 4201);
assert.equal(room.boss.hp, 30, "a second contributor shares the same HP pool");
room.handleMessage("p2", bob, { t: "boss_hit", bossId: room.boss.id, damage: 30 }, start + 4202);
assert.equal(room.boss.active, false, "shared boss is defeated once for the room");
assert.equal(distant.ofType("boss_defeated").length, 1, "defeat event is visible to the whole room");
assert.equal(alice.ofType("boss_reward").length, 1, "participant receives reward");
assert.equal(bob.ofType("boss_reward").length, 1, "second participant receives reward");
assert.equal(cara.ofType("boss_reward").length, 1, "eligible contributor receives the equal reward");
assert.equal(distant.ofType("boss_reward").length, 0, "distant non-participant is not rewarded");
assert.deepEqual(
  alice.ofType("boss_reward")[0].reward,
  cara.ofType("boss_reward")[0].reward,
  "all eligible players receive the same reward payload",
);

alice.clear();
room.handleMessage("p1", alice, { t: "boss_hit", bossId: room.boss.id, damage: 10 }, start + 5000);
assert.equal(alice.ofType("boss_reject")[0].reason, "inactive", "dead boss cannot take more hits during cooldown");

const defeatedBossId = room.boss.id;
for (const socket of sockets) socket.clear();
room.handleMessage("p1", alice, { t: "ping" }, room.boss.respawnAt);
assert.notEqual(room.boss.id, defeatedBossId, "keepalive wakes the next shared boss after cooldown");
assert.equal(room.boss.active, true);
assert.equal(bob.ofType("boss_spawn").length, 1, "respawn is announced without requiring a reconnect");

const overworld = new Room({}, {});
overworld.setWorld("overworld");
const safeTraveler = join(overworld, "safe-1", "Safe", 55 * 24, 55 * 24, start);
const safeTarget = join(overworld, "safe-2", "Target", 55 * 24 + 20, 55 * 24, start + 1);
overworld.handleMessage("safe-1", safeTraveler, { t: "duel", active: true }, start + 100);
assert.equal(overworld.meta.get("safe-1").duel, false, "overworld cannot arm PvP");
overworld.handleMessage("safe-1", safeTraveler, { t: "pvp_hit", target: "safe-2", damage: 10 }, start + 200);
assert.equal(safeTraveler.ofType("pvp_reject")[0].reason, "wrong_world", "overworld rejects player damage");
overworld.handleMessage("safe-1", safeTraveler, { t: "boss_hit", damage: 10 }, start + 300);
assert.equal(safeTraveler.ofType("boss_reject")[0].reason, "wrong_world", "overworld rejects raid damage");
assert.equal(safeTarget.ofType("pvp_hit").length, 0, "safe target receives no damage event");

console.log("PROTOCOL TEST PASS — presence, chat, duel validation and shared boss rewards");
