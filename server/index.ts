import cors from "cors";
import express from "express";
import { createServer } from "node:http";
import os from "node:os";
import { WebSocketServer, type WebSocket } from "ws";
import qrcode from "qrcode-terminal";
import type { MutationPayload } from "../shared/types.js";
import { OrderStore } from "./store.js";

const API_PORT = Number(process.env.API_PORT ?? 8787);
const store = new OrderStore();

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, orderId: "42", cursor: store.getCursor() });
});

app.get("/order/:id", (req, res) => {
  const order = store.getOrder();
  if (req.params.id !== order.id) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({ order, cursor: store.getCursor() });
});

/** Cursor-based pull: GET /changes?since=c_41 */
app.get("/changes", (req, res) => {
  const since = typeof req.query.since === "string" ? req.query.since : null;
  const result = store.getChangesSince(since);
  res.json(result);
});

/**
 * Push one or more outbox mutations.
 * Idempotency-Key header (or per-item key) dedupes retries.
 * Accepts a single mutation or { mutations: [...] } for batching.
 */
app.post("/push", (req, res) => {
  const headerKey = req.header("Idempotency-Key");
  const body = req.body;

  const items: Array<{ key: string; mutation: MutationPayload }> = [];

  if (Array.isArray(body?.mutations)) {
    for (const item of body.mutations) {
      const key = item.idempotencyKey ?? headerKey;
      if (!key || !item.mutation) {
        res.status(400).json({ error: "Each batch item needs idempotencyKey and mutation" });
        return;
      }
      items.push({ key, mutation: item.mutation });
    }
  } else if (body?.mutation) {
    if (!headerKey && !body.idempotencyKey) {
      res.status(400).json({ error: "Idempotency-Key header required" });
      return;
    }
    items.push({
      key: (body.idempotencyKey as string) ?? headerKey!,
      mutation: body.mutation as MutationPayload,
    });
  } else {
    // Flat body = mutation fields
    if (!headerKey) {
      res.status(400).json({ error: "Idempotency-Key header required" });
      return;
    }
    items.push({ key: headerKey, mutation: body as MutationPayload });
  }

  const results = items.map(({ key, mutation }) => store.push(key, mutation));
  const last = results[results.length - 1]!;
  res.json({
    results,
    order: last.order,
    cursor: last.cursor,
    conflictNotes: results.flatMap((r) => r.conflictNotes),
  });
});

/** One-click reset to starting state of order #42 */
app.post("/reset", (_req, res) => {
  const order = store.reset();
  res.json({ order, cursor: store.getCursor() });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

const sockets = new Set<WebSocket>();

wss.on("connection", (ws) => {
  sockets.add(ws);
  ws.send(
    JSON.stringify({
      type: "hello",
      cursor: store.getCursor(),
      order: store.getOrder(),
    })
  );

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (msg?.type === "ping") {
        ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => sockets.delete(ws));
});

/** Real-time nudge: something changed — go pull. */
store.onChange((event) => {
  const payload = JSON.stringify({
    type: "nudge",
    cursor: event.cursor,
    changeType: event.type,
  });
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) {
      ws.send(payload);
    }
  }
});

function lanAddresses(): string[] {
  const nets = os.networkInterfaces();
  const addrs: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const net of list) {
      if (net.family === "IPv4" && !net.internal) {
        addrs.push(net.address);
      }
    }
  }
  return addrs;
}

server.listen(API_PORT, "0.0.0.0", () => {
  const lans = lanAddresses();
  console.log("");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Order #42 sync server                                   ║");
  console.log("╠══════════════════════════════════════════════════════════╣");
  console.log(`║  API + WebSocket  http://127.0.0.1:${API_PORT}                 ║`);
  console.log(`║  Health           http://127.0.0.1:${API_PORT}/health          ║`);
  console.log("║  Vite UI (client) http://127.0.0.1:5173                  ║");
  for (const ip of lans) {
    console.log(`║  Phone (same Wi-Fi) http://${ip}:5173`.padEnd(61) + "║");
  }
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("");
  if (lans[0]) {
    const url = `http://${lans[0]}:5173`;
    console.log(`Scan this QR on a phone (same Wi-Fi) → ${url}`);
    qrcode.generate(url, { small: true });
  } else {
    console.log("No LAN IPv4 found — phone access needs a local network address.");
  }
  console.log("Tip: Chrome DevTools → Network → Offline for the web tab.");
  console.log("     Phone: open the LAN URL, then airplane mode for Ada.");
  console.log("");
});
