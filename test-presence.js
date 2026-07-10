// Integration test: two clients join the forest room; client A moves; verify
// client B receives A's updated position via state sync. Exits non-zero on fail.
import { Client } from "colyseus.js";

const URL = "ws://localhost:2567";

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const ca = new Client(URL);
  const cb = new Client(URL);

  const roomA = await ca.joinOrCreate("forest", { name: "Alice", look: '{"shirt":"#f00"}', x: 100, y: 100 });
  const roomB = await cb.joinOrCreate("forest", { name: "Bob", look: '{"shirt":"#00f"}', x: 500, y: 500 });

  await sleep(400);

  // Bob's view of the world: how many players does he see?
  let seenByB = roomB.state.players.size;
  console.log("Bob sees players:", seenByB);

  // Find Alice's sessionId from Bob's perspective (the one that isn't Bob)
  let aliceId = null;
  roomB.state.players.forEach((p, id) => { if (p.name === "Alice") aliceId = id; });
  console.log("Bob found Alice entry:", aliceId, aliceId ? roomB.state.players.get(aliceId).x : "n/a");

  // Alice moves
  roomA.send("move", { x: 222, y: 333, dir: "right", moving: true });
  await sleep(400);

  const alicePosFromB = aliceId ? roomB.state.players.get(aliceId) : null;
  const movedOK = alicePosFromB && Math.round(alicePosFromB.x) === 222 && Math.round(alicePosFromB.y) === 333 && alicePosFromB.dir === "right";
  console.log("Alice pos as seen by Bob after move:", alicePosFromB ? `${alicePosFromB.x},${alicePosFromB.y} ${alicePosFromB.dir}` : "MISSING");

  // Now Alice leaves; Bob should see one fewer
  await roomA.leave();
  await sleep(500);
  const afterLeave = roomB.state.players.size;
  console.log("Bob sees players after Alice leaves:", afterLeave);

  await roomB.leave();

  const pass = seenByB === 2 && aliceId && movedOK && afterLeave === 1;
  console.log(pass ? "TEST PASS ✅" : "TEST FAIL ❌");
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error("ERR", e); process.exit(2); });
