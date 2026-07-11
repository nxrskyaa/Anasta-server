# Anasta Chronicle — Realm Server

Production multiplayer backend for **Anasta Chronicle**, implemented as a
Cloudflare Worker with one Durable Object room. The browser client talks to it
through a plain JSON WebSocket protocol.

Live endpoint: `wss://anasta-server.anasta-nxrskyaa.workers.dev`

## Current capabilities

- Shared open-world presence, movement, appearance and reconnect resume.
- Sanitized global realm chat.
- Mutual opt-in Duel Mode with server-side consent, distance, cadence and
  damage-cap validation.
- One server-owned Infernyx HP pool and synchronized boss attack targeting.
- Equal co-op rewards for active contributors who remain in the arena.
- Position speed bounds, guarded initial spawn and short-lived reconnect tokens.

`worker.mjs` is the production source of truth. `src/index.js` and
`deno_server.ts` are retained only as legacy presence relays and do not expose
protocol v2 combat.

## Local development

Use Node.js 22 or newer for the current Wrangler release.

```bash
npm install
npm start
```

`npm start` launches `wrangler dev`, including the Durable Object binding from
`wrangler.toml`.

Run the protocol simulation:

```bash
npm run test:protocol
```

The test covers chat cleaning, mutual duel consent, PvP validation, shared boss
damage, contributor eligibility, equal rewards and boss respawn.

## Deploy

Authenticate Wrangler for the intended Cloudflare account, then run:

```bash
npm run deploy
```

Health endpoint:

```text
https://anasta-server.anasta-nxrskyaa.workers.dev/health
```

## Protocol v2

Client to server:

- `join { name, look, x, y, resumeToken? }`
- `move { x, y, dir, moving }`
- `chat { text }`
- `duel { active }`
- `pvp_hit { target, damage, kind }`
- `boss_sync {}`
- `boss_hit { bossId, damage }`
- `ping {}`

Server to client:

- `welcome`, `players`, `join`, `state`, `leave`, `pong`
- `chat`, `duel`, `pvp_hit`, `pvp_reject`
- `boss_spawn`, `boss_state`, `boss_hit`, `boss_attack`
- `boss_defeated`, `boss_reward`, `boss_reject`

## Security boundary

The server validates consent, range, movement speed, hit cadence and capped
damage. Character stats and health are still client-owned. Before rewards become
tradable or onchain, move character progression, loadouts, health and loot
settlement to authoritative storage and signed accounts.
