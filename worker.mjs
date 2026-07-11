// Anasta Chronicle realtime server — Cloudflare Worker + Durable Object.
// Presence remains backward-compatible while combat-sensitive events are
// validated and resolved by the room instead of being blindly relayed.

export const PROTOCOL_VERSION = 2;
export const WORLD_SIZE = 110 * 24;
export const PVP_MAX_RANGE = 420;
export const PVP_MAX_DAMAGE = 120;
export const PVP_HIT_COOLDOWN = 240;
export const BOSS_X = 87 * 24;
export const BOSS_Y = 82 * 24;
export const BOSS_MAX_HP = 2400;
export const BOSS_HIT_RANGE = 720;
export const BOSS_MAX_DAMAGE = 180;
export const BOSS_HIT_COOLDOWN = 100;
export const BOSS_RESPAWN_MS = 3 * 60 * 1000;
export const BOSS_REWARD_RADIUS = 640;
export const BOSS_MIN_CONTRIBUTION = 20;
export const BOSS_ATTACK_RANGE = 760;
export const SPAWN_X = 55 * 24;
export const SPAWN_Y = 55 * 24 + 46;
export const JOIN_SPAWN_RADIUS = 180;
export const MOVE_SPEED_PER_MS = .6;
export const MOVE_PACKET_SLACK = 24;

const DIRECTIONS = new Set(["up", "down", "left", "right"]);
const COMBAT_KINDS = new Set(["basic", "skill", "projectile"]);
const PVP_KIND_MAX = Object.freeze({ basic: 72, projectile: 92, skill: PVP_MAX_DAMAGE });
const BOSS_REWARD = Object.freeze({
  gold: 220,
  xp: 360,
  items: Object.freeze({ dragonscale: 1, ore: 8, gel: 6 }),
});

const finite = (value) => value !== null && value !== "" && Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function cleanName(value) {
  return String(value || "Traveler")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16) || "Traveler";
}

function cleanChat(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function validDamage(value, maximum) {
  const damage = Number(value);
  if (!Number.isFinite(damage) || damage < 1 || damage > maximum) return null;
  return Math.max(1, Math.round(damage));
}

function safeSend(socket, object) {
  try { socket.send(JSON.stringify(object)); } catch { /* disconnected */ }
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.meta = new Map();
    this.nextId = 1;
    this.lastPvpHitAt = new Map();
    this.lastBossHitAt = new Map();
    this.bossParticipants = new Map();
    this.resumePositions = new Map();
    this.boss = null;
    this.bossSequence = 0;
  }

  publicPlayer(meta) {
    return {
      id: meta.id,
      name: meta.name,
      look: meta.look,
      x: Math.round(meta.x),
      y: Math.round(meta.y),
      dir: meta.dir,
      moving: !!meta.moving,
      duel: !!meta.duel,
    };
  }

  snapshot() {
    return [...this.meta.values()]
      .filter((meta) => meta.joined)
      .map((meta) => this.publicPlayer(meta));
  }

  sendTo(id, object) {
    const socket = this.sessions.get(id);
    if (socket) safeSend(socket, object);
  }

  broadcast(object, exceptId = null) {
    const message = JSON.stringify(object);
    for (const [id, socket] of this.sessions) {
      if (id === exceptId) continue;
      try { socket.send(message); } catch { /* disconnected */ }
    }
  }

  publicBoss() {
    if (!this.boss) return null;
    return {
      id: this.boss.id,
      name: "Infernyx, the Ashen Oni",
      active: !!this.boss.active,
      x: this.boss.x,
      y: this.boss.y,
      hp: Math.max(0, this.boss.hp),
      maxHp: this.boss.maxHp,
      phase: this.boss.hp <= this.boss.maxHp * 0.4 ? 2 : 1,
      spawnedAt: this.boss.spawnedAt,
      defeatedAt: this.boss.defeatedAt || 0,
      respawnAt: this.boss.respawnAt || 0,
    };
  }

  ensureBoss(now = Date.now()) {
    if (this.boss?.active) return false;
    if (this.boss?.respawnAt && now < this.boss.respawnAt) return false;
    this.bossSequence += 1;
    this.boss = {
      id: `infernyx-${now.toString(36)}-${this.bossSequence}`,
      active: true,
      x: BOSS_X,
      y: BOSS_Y,
      hp: BOSS_MAX_HP,
      maxHp: BOSS_MAX_HP,
      spawnedAt: now,
      defeatedAt: 0,
      respawnAt: 0,
      nextAttackAt: now + 3600,
      attackSequence: 0,
    };
    this.bossParticipants.clear();
    this.lastBossHitAt.clear();
    this.broadcast({ t: "boss_spawn", boss: this.publicBoss(), serverNow: now });
    return true;
  }

  maybeBossAttack(now = Date.now()) {
    if (!this.boss?.active || now < (this.boss.nextAttackAt || 0)) return false;
    const candidates = [...this.meta.values()]
      .filter((meta) => meta.joined && distance(meta, this.boss) <= BOSS_ATTACK_RANGE)
      .sort((a, b) => distance(a, this.boss) - distance(b, this.boss) || a.id.localeCompare(b.id));
    if (!candidates.length) { this.boss.nextAttackAt = now + 1000; return false; }
    const target = candidates[this.boss.attackSequence % Math.min(candidates.length, 3)];
    const targetDistance = distance(target, this.boss);
    const phase = this.boss.hp <= this.boss.maxHp * .4 ? 2 : 1;
    const kind = targetDistance < 92 ? "melee" : "breath";
    this.boss.attackSequence++;
    this.boss.nextAttackAt = now + (phase === 2 ? 2800 : 4600);
    this.broadcast({
      t: "boss_attack", bossId: this.boss.id, sequence: this.boss.attackSequence,
      kind, phase, target: target.id, targetName: target.name,
      targetX: Math.round(target.x), targetY: Math.round(target.y),
      angle: Math.atan2(target.y - this.boss.y, target.x - this.boss.x), at: now,
    });
    return true;
  }

  rejectPvp(id, reason, target) {
    this.sendTo(id, { t: "pvp_reject", reason, target: target || null });
  }

  rejectBoss(id, reason) {
    this.sendTo(id, { t: "boss_reject", reason, bossId: this.boss?.id || null });
  }

  handlePvpHit(id, message, now) {
    const source = this.meta.get(id);
    const targetId = String(message.target || "");
    const target = this.meta.get(targetId);
    if (!source?.joined || !target?.joined || targetId === id) {
      this.rejectPvp(id, "invalid_target", targetId);
      return;
    }
    if (!source.duel || !target.duel) {
      this.rejectPvp(id, "mutual_duel_required", targetId);
      return;
    }
    if (distance(source, target) > PVP_MAX_RANGE) {
      this.rejectPvp(id, "out_of_range", targetId);
      return;
    }
    const kind = COMBAT_KINDS.has(message.kind) ? message.kind : "basic";
    const damage = validDamage(message.damage, PVP_KIND_MAX[kind]);
    if (!damage) {
      this.rejectPvp(id, "invalid_damage", targetId);
      return;
    }
    const lastHit = this.lastPvpHitAt.get(id) ?? -Infinity;
    if (now - lastHit < PVP_HIT_COOLDOWN) {
      this.rejectPvp(id, "rate_limited", targetId);
      return;
    }
    this.lastPvpHitAt.set(id, now);
    this.broadcast({
      t: "pvp_hit",
      source: id,
      sourceName: source.name,
      target: targetId,
      damage,
      kind,
      at: now,
    });
  }

  handleBossHit(id, message, now) {
    const player = this.meta.get(id);
    if (!player?.joined || !this.boss?.active) {
      this.rejectBoss(id, "inactive");
      return;
    }
    if (message.bossId && message.bossId !== this.boss.id) {
      this.rejectBoss(id, "stale_boss");
      return;
    }
    if (distance(player, this.boss) > BOSS_HIT_RANGE) {
      this.rejectBoss(id, "out_of_range");
      return;
    }
    const damage = validDamage(message.damage, BOSS_MAX_DAMAGE);
    if (!damage) {
      this.rejectBoss(id, "invalid_damage");
      return;
    }
    const lastHit = this.lastBossHitAt.get(id) ?? -Infinity;
    if (now - lastHit < BOSS_HIT_COOLDOWN) {
      this.rejectBoss(id, "rate_limited");
      return;
    }

    this.lastBossHitAt.set(id, now);
    const applied = Math.min(damage, this.boss.hp);
    this.boss.hp -= applied;
    this.bossParticipants.set(id, (this.bossParticipants.get(id) || 0) + applied);
    this.broadcast({
      t: "boss_hit",
      bossId: this.boss.id,
      source: id,
      sourceName: player.name,
      damage: applied,
      hp: this.boss.hp,
      maxHp: this.boss.maxHp,
      phase: this.boss.hp <= this.boss.maxHp * 0.4 ? 2 : 1,
      at: now,
    });

    if (this.boss.hp > 0) { this.maybeBossAttack(now); return; }

    this.boss.active = false;
    this.boss.defeatedAt = now;
    this.boss.respawnAt = now + BOSS_RESPAWN_MS;
    const eligibleIds = [];
    for (const meta of this.meta.values()) {
      if (!meta.joined) continue;
      const contribution = this.bossParticipants.get(meta.id) || 0;
      if (contribution >= BOSS_MIN_CONTRIBUTION && distance(meta, this.boss) <= BOSS_REWARD_RADIUS) {
        eligibleIds.push(meta.id);
      }
    }
    const participants = eligibleIds.length;
    this.broadcast({
      t: "boss_defeated",
      boss: this.publicBoss(),
      defeatedBy: id,
      eligibleIds,
      reward: BOSS_REWARD,
      serverNow: now,
    });
    for (const playerId of eligibleIds) {
      this.sendTo(playerId, {
        t: "boss_reward",
        bossId: this.boss.id,
        reward: BOSS_REWARD,
        contribution: this.bossParticipants.get(playerId) || 0,
        participants,
        respawnAt: this.boss.respawnAt,
      });
    }
  }

  handleMessage(id, socket, message, now = Date.now()) {
    const meta = this.meta.get(id);
    if (!meta || !message || typeof message !== "object") return;

    if (message.t === "join") {
      for (const [token, saved] of this.resumePositions) if (saved.expiresAt < now) this.resumePositions.delete(token);
      const firstJoin = !meta.joined;
      meta.joined = true;
      meta.name = cleanName(message.name);
      meta.look = String(message.look || "{}").slice(0, 4000);
      const resumeToken = String(message.resumeToken || "").slice(0, 80);
      const resume = resumeToken ? this.resumePositions.get(resumeToken) : null;
      const resumed = !!resume && resume.expiresAt >= now;
      if (resumed) {
        meta.x = resume.x; meta.y = resume.y;
        meta.resumeToken = resumeToken;
        if (resume.bossId === this.boss?.id && resume.contribution > 0) this.bossParticipants.set(id, resume.contribution);
        this.resumePositions.delete(resumeToken);
      } else {
        if (resumeToken) this.resumePositions.delete(resumeToken);
        const requestedX = finite(message.x) ? clamp(Number(message.x), 0, WORLD_SIZE) : SPAWN_X;
        const requestedY = finite(message.y) ? clamp(Number(message.y), 0, WORLD_SIZE) : SPAWN_Y;
        if (Math.hypot(requestedX - SPAWN_X, requestedY - SPAWN_Y) <= JOIN_SPAWN_RADIUS) {
          meta.x = requestedX; meta.y = requestedY;
        } else {
          meta.x = SPAWN_X; meta.y = SPAWN_Y;
        }
        meta.resumeToken ||= crypto.randomUUID();
      }
      meta.lastMoveAt = now;
      if (DIRECTIONS.has(message.dir)) meta.dir = message.dir;
      safeSend(socket, { t: "welcome", id, room: "forest", protocol: PROTOCOL_VERSION, resumeToken: meta.resumeToken, x: Math.round(meta.x), y: Math.round(meta.y), resumed });
      safeSend(socket, { t: "players", list: this.snapshot() });
      if (firstJoin) this.broadcast({ t: "join", player: this.publicPlayer(meta) }, id);
      this.ensureBoss(now);
      safeSend(socket, { t: "boss_state", boss: this.publicBoss(), contribution: this.bossParticipants.get(id) || 0, serverNow: now });
      return;
    }

    if (!meta.joined) return;

    if (message.t === "move") {
      const requestedX = finite(message.x) ? clamp(Number(message.x), 0, WORLD_SIZE) : meta.x;
      const requestedY = finite(message.y) ? clamp(Number(message.y), 0, WORLD_SIZE) : meta.y;
      const elapsed = clamp(now - (meta.lastMoveAt || now), 16, 250);
      const allowed = MOVE_PACKET_SLACK + elapsed * MOVE_SPEED_PER_MS;
      const dx = requestedX - meta.x, dy = requestedY - meta.y, moved = Math.hypot(dx, dy);
      if (moved <= allowed || moved <= .001) {
        meta.x = requestedX; meta.y = requestedY;
      } else {
        meta.x = clamp(meta.x + dx / moved * allowed, 0, WORLD_SIZE);
        meta.y = clamp(meta.y + dy / moved * allowed, 0, WORLD_SIZE);
      }
      meta.lastMoveAt = now;
      if (DIRECTIONS.has(message.dir)) meta.dir = message.dir;
      meta.moving = !!message.moving;
      this.broadcast({
        t: "state",
        id,
        x: Math.round(meta.x),
        y: Math.round(meta.y),
        dir: meta.dir,
        moving: meta.moving,
      }, id);
      this.maybeBossAttack(now);
    } else if (message.t === "ping") {
      this.ensureBoss(now);
      this.maybeBossAttack(now);
      safeSend(socket, { t: "pong", serverNow: now });
    } else if (message.t === "chat") {
      const text = cleanChat(message.text);
      if (!text || now - meta.lastChatAt < 400) return;
      meta.lastChatAt = now;
      this.broadcast({ t: "chat", id, name: meta.name, text, at: now });
    } else if (message.t === "duel") {
      if (typeof message.active !== "boolean") return;
      meta.duel = message.active;
      this.broadcast({ t: "duel", id, active: meta.duel, at: now });
    } else if (message.t === "pvp_hit") {
      this.handlePvpHit(id, message, now);
    } else if (message.t === "boss_sync") {
      this.ensureBoss(now);
      safeSend(socket, { t: "boss_state", boss: this.publicBoss(), contribution: this.bossParticipants.get(id) || 0, serverNow: now });
    } else if (message.t === "boss_hit") {
      this.ensureBoss(now);
      this.handleBossHit(id, message, now);
    }
  }

  removePlayer(id) {
    const meta = this.meta.get(id);
    if (meta?.joined && meta.resumeToken) this.resumePositions.set(meta.resumeToken, { x: meta.x, y: meta.y, bossId: this.boss?.id || null, contribution: this.bossParticipants.get(id) || 0, expiresAt: Date.now() + 60000 });
    this.sessions.delete(id);
    this.meta.delete(id);
    this.lastPvpHitAt.delete(id);
    this.lastBossHitAt.delete(id);
    this.bossParticipants.delete(id);
    if (meta?.joined) {
      this.broadcast({ t: "leave", id });
      console.log(`${meta.name} left (${id}). Players: ${this.sessions.size}`);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        protocol: PROTOCOL_VERSION,
        players: this.snapshot().length,
        boss: this.publicBoss(),
      });
    }
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Anasta server — connect via WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = `p${this.nextId++}`;
    this.sessions.set(id, server);
    this.meta.set(id, {
      id,
      joined: false,
      name: "Traveler",
      look: "{}",
      x: SPAWN_X,
      y: SPAWN_Y,
      dir: "down",
      moving: false,
      duel: false,
      lastChatAt: -Infinity,
      lastMoveAt: Date.now(),
      resumeToken: crypto.randomUUID(),
    });

    server.accept();
    server.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      this.handleMessage(id, server, message);
    });
    server.addEventListener("close", () => this.removePlayer(id));
    server.addEventListener("error", () => { /* close event handles cleanup */ });

    return new Response(null, { status: 101, webSocket: client });
  }
}

export default {
  async fetch(request, env) {
    const id = env.ROOM.idFromName("forest");
    return env.ROOM.get(id).fetch(request);
  },
};
