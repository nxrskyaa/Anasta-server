// Anasta presence server entry. Boots a Colyseus server over WebSocket,
// exposes the "forest" room, and a tiny HTTP health check for the host.
import http from "http";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ForestRoom } from "./ForestRoom.js";

const PORT = process.env.PORT || 2567;

const app = express();
app.use(cors());
app.get("/", (_req, res) => res.send("Anasta presence server OK"));
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("forest", ForestRoom);

gameServer.listen(PORT).then(() => {
  console.log(`Anasta server listening on :${PORT}`);
}).catch((e) => {
  console.error("Failed to start:", e);
  process.exit(1);
});
