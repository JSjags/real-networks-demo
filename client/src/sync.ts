import { v4 as uuidv4 } from "uuid";
import type {
  ChangesResponse,
  ClientId,
  MutationPayload,
  Order,
  OutboxEntry,
  PushResult,
} from "../../shared/types";
import {
  getCursor,
  getDb,
  logSync,
  nextSeq,
  setCursor,
} from "./db";

const API = "/api";

export type NetworkMode = "online" | "offline-simulated" | "browser-offline";

type Listener = () => void;

export class SyncEngine {
  private clientId: ClientId;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ws: WebSocket | null = null;
  private wsRetry = 0;
  private flushAttempt = 0;
  private flushing = false;
  private listeners = new Set<Listener>();
  private simulateOffline = false;
  private destroyed = false;

  constructor(clientId: ClientId) {
    this.clientId = clientId;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  setSimulateOffline(value: boolean) {
    this.simulateOffline = value;
    void logSync(
      this.clientId,
      "warn",
      value ? "Simulate offline ON (in-app)" : "Simulate offline OFF"
    );
    this.notify();
    if (!value && this.isOnline()) {
      void this.flush();
      this.connectWs();
    } else if (value) {
      this.ws?.close();
    }
  }

  getSimulateOffline() {
    return this.simulateOffline;
  }

  isOnline(): boolean {
    if (this.simulateOffline) return false;
    return typeof navigator === "undefined" ? true : navigator.onLine;
  }

  getNetworkMode(): NetworkMode {
    if (this.simulateOffline) return "offline-simulated";
    if (typeof navigator !== "undefined" && !navigator.onLine) return "browser-offline";
    return "online";
  }

  start() {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    void this.pull();
    this.connectWs();
    void this.flush();
  }

  stop() {
    this.destroyed = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close();
  }

  private onOnline = () => {
    void logSync(this.clientId, "ok", "Browser reports online — flushing outbox");
    this.flushAttempt = 0;
    void this.flush();
    this.connectWs();
    this.notify();
  };

  private onOffline = () => {
    void logSync(this.clientId, "warn", "Browser reports offline");
    this.notify();
  };

  /**
   * Write locally + enqueue outbox in one Dexie transaction (slide 7).
   */
  async applyLocalEdit(fields: Partial<Pick<Order, "quantity" | "address">>): Promise<OutboxEntry> {
    const db = getDb(this.clientId);
    const seq = await nextSeq(this.clientId);
    const id = uuidv4();
    const now = new Date().toISOString();

    const entry: OutboxEntry = {
      id,
      op: "update_order",
      payload: {
        orderId: "42",
        fields,
        clientId: this.clientId,
        clientUpdatedAt: now,
      },
      seq,
      status: "pending",
      createdAt: now,
      attempts: 0,
    };

    await db.transaction("rw", db.orders, db.outbox, async () => {
      const order = await db.orders.get("42");
      if (!order) throw new Error("Order #42 missing locally");
      const next: Order = {
        ...order,
        ...fields,
        updatedAt: now,
        fieldMeta: {
          quantity: { ...order.fieldMeta.quantity },
          address: { ...order.fieldMeta.address },
        },
      };
      for (const field of ["quantity", "address"] as const) {
        if (fields[field] !== undefined) {
          next.fieldMeta[field] = {
            updatedAt: now,
            updatedBy: this.clientId,
          };
        }
      }
      await db.orders.put(next);
      await db.outbox.put(entry);
    });

    const fieldNames = Object.keys(fields).join(", ");
    await logSync(
      this.clientId,
      "info",
      `Local write → outbox (${fieldNames}) key=${id.slice(0, 8)}…`
    );
    this.notify();

    if (this.isOnline()) {
      void this.flush();
    }
    return entry;
  }

  /** Exponential backoff with full jitter, capped. */
  private nextDelayMs(): number {
    const base = Math.min(1000 * 2 ** this.flushAttempt, 16000);
    const jitter = Math.random() * base * 0.4;
    return Math.round(base * 0.6 + jitter);
  }

  private scheduleRetry() {
    if (this.timer) clearTimeout(this.timer);
    const delay = this.nextDelayMs();
    void logSync(
      this.clientId,
      "warn",
      `Retry scheduled in ${delay}ms (attempt ${this.flushAttempt + 1}, backoff+jitter)`
    );
    this.timer = setTimeout(() => {
      void this.flush();
    }, delay);
  }

  /**
   * Flush outbox: batch pending entries in one request when possible.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.destroyed) return;
    if (!this.isOnline()) {
      await logSync(this.clientId, "info", "Flush skipped — offline");
      return;
    }

    const db = getDb(this.clientId);
    const pending = await db.outbox
      .where("status")
      .anyOf(["pending", "failed", "sending"])
      .sortBy("seq");

    const queue = pending.filter((e) => e.status !== "synced");
    if (queue.length === 0) {
      this.flushAttempt = 0;
      return;
    }

    this.flushing = true;
    try {
      for (const e of queue) {
        await db.outbox.update(e.id, { status: "sending" });
      }
      this.notify();

      // Batching: send several outbox entries in one request
      const body = {
        mutations: queue.map((e) => ({
          idempotencyKey: e.id,
          mutation: e.payload as MutationPayload,
        })),
      };

      await logSync(
        this.clientId,
        "info",
        `Pushing batch of ${queue.length} mutation(s)…`
      );

      const res = await fetch(`${API}/push`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // First key also as header (slide 7); batch carries per-item keys
          "Idempotency-Key": queue[0]!.id,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        throw new Error(`Push failed HTTP ${res.status}`);
      }

      const data = (await res.json()) as {
        results: PushResult[];
        order: Order;
        cursor: string;
        conflictNotes: string[];
      };

      await db.transaction("rw", db.orders, db.outbox, db.meta, async () => {
        for (const e of queue) {
          await db.outbox.update(e.id, { status: "synced", lastError: undefined });
        }
        // Apply server-authoritative order (includes merges / LWW)
        await db.orders.put(data.order);
        if (data.cursor) {
          await setCursor(this.clientId, data.cursor);
        }
      });

      for (const note of data.conflictNotes ?? []) {
        await logSync(this.clientId, "warn", note);
      }
      await logSync(
        this.clientId,
        "ok",
        `Batch synced (${queue.length}). Server cursor ${data.cursor}`
      );

      // Drop synced entries after a short moment so the badge can flash "synced"
      setTimeout(() => {
        void (async () => {
          for (const e of queue) {
            await db.outbox.delete(e.id);
          }
          this.notify();
        })();
      }, 1200);

      this.flushAttempt = 0;
      // Also pull in case other clients wrote
      await this.pull();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const e of queue) {
        await db.outbox.update(e.id, {
          status: "failed",
          lastError: message,
          attempts: e.attempts + 1,
        });
      }
      await logSync(this.clientId, "error", `Flush failed: ${message}`);
      this.flushAttempt += 1;
      this.scheduleRetry();
    } finally {
      this.flushing = false;
      this.notify();
    }
  }

  /** Cursor-based pull: GET /changes?since=<cursor> */
  async pull(): Promise<void> {
    if (!this.isOnline()) return;
    try {
      const since = await getCursor(this.clientId);
      const res = await fetch(`${API}/changes?since=${encodeURIComponent(since)}`);
      if (!res.ok) throw new Error(`Pull HTTP ${res.status}`);
      const data = (await res.json()) as ChangesResponse;
      const db = getDb(this.clientId);

      if (data.changes.length === 0) {
        if (data.cursor && data.cursor !== since) {
          await setCursor(this.clientId, data.cursor);
        }
        return;
      }

      await db.transaction("rw", db.orders, db.meta, async () => {
        // Apply last change's order (full snapshot per event — simple & correct for demo)
        const last = data.changes[data.changes.length - 1]!;
        await db.orders.put(last.order);
        await setCursor(this.clientId, data.cursor);
      });

      await logSync(
        this.clientId,
        "ok",
        `Pulled ${data.changes.length} change(s) since ${since} → ${data.cursor}`
      );
      this.notify();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await logSync(this.clientId, "error", `Pull failed: ${message}`);
    }
  }

  /** Real-time nudge over WebSocket with graceful reconnect + backoff/jitter */
  private connectWs() {
    if (this.destroyed || !this.isOnline()) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => {
      this.wsRetry = 0;
      void logSync(this.clientId, "ok", "WebSocket connected (real-time nudge)");
      this.notify();
    };

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.type === "nudge" || msg.type === "hello") {
          void logSync(
            this.clientId,
            "info",
            msg.type === "nudge"
              ? `Nudge received (cursor ${msg.cursor}) — pulling`
              : `WS hello (cursor ${msg.cursor})`
          );
          void this.pull();
        }
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      this.notify();
      if (this.destroyed || !this.isOnline()) return;
      const base = Math.min(1000 * 2 ** this.wsRetry, 16000);
      const delay = Math.round(base * 0.6 + Math.random() * base * 0.4);
      this.wsRetry += 1;
      void logSync(this.clientId, "warn", `WS closed — reconnect in ${delay}ms`);
      setTimeout(() => this.connectWs(), delay);
    };

    ws.onerror = () => {
      // onclose will fire
    };

    // Heartbeat
    const beat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "ping" }));
      } else {
        clearInterval(beat);
      }
    }, 15000);
  }

  async resetDemo(): Promise<void> {
    if (!this.isOnline()) {
      // Still reset local; server reset needs network
      const { clearLocal } = await import("./db");
      await clearLocal(this.clientId);
      await logSync(this.clientId, "warn", "Local reset only (offline)");
      this.notify();
      return;
    }
    const res = await fetch(`${API}/reset`, { method: "POST" });
    if (!res.ok) throw new Error("Reset failed");
    const data = (await res.json()) as { order: Order; cursor: string };
    const { clearLocal } = await import("./db");
    await clearLocal(this.clientId);
    const db = getDb(this.clientId);
    await db.orders.put(data.order);
    await setCursor(this.clientId, data.cursor);
    await logSync(this.clientId, "ok", "Reset to order #42 starting state");
    this.notify();
    void this.pull();
  }

  wsState(): "open" | "connecting" | "closed" {
    if (!this.ws) return "closed";
    if (this.ws.readyState === WebSocket.OPEN) return "open";
    if (this.ws.readyState === WebSocket.CONNECTING) return "connecting";
    return "closed";
  }
}
