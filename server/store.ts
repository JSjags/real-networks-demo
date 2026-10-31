import { INITIAL_ORDER, type ChangeEvent, type MutationPayload, type Order, type PushResult } from "../shared/types.js";
import { mergeMutation } from "./merge.js";

interface IdempotencyRecord {
  key: string;
  result: PushResult;
  createdAt: string;
}

/**
 * In-memory store (demo-friendly). Reset recreates the starting order #42.
 * Cursor is a monotonic integer encoded as `c_<n>`.
 */
export class OrderStore {
  private order: Order = structuredClone(INITIAL_ORDER);
  private changes: ChangeEvent[] = [];
  private cursorCounter = 0;
  private idempotency = new Map<string, IdempotencyRecord>();
  private listeners = new Set<(event: ChangeEvent) => void>();

  getOrder(): Order {
    return structuredClone(this.order);
  }

  getCursor(): string {
    return `c_${this.cursorCounter}`;
  }

  onChange(listener: (event: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChangeEvent) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors
      }
    }
  }

  /**
   * Apply a mutation with idempotency. Same Idempotency-Key → same result, no duplicate.
   */
  push(idempotencyKey: string, mutation: MutationPayload): PushResult {
    const existing = this.idempotency.get(idempotencyKey);
    if (existing) {
      return { ...existing.result, duplicate: true };
    }

    const { order, changedFields, conflictNotes } = mergeMutation(this.order, mutation);

    if (changedFields.length === 0) {
      // No-op or fully rejected older write: ack so client can clear outbox
      const result: PushResult = {
        ok: true,
        duplicate: false,
        order: structuredClone(this.order),
        cursor: this.getCursor(),
        conflictNotes,
      };
      this.idempotency.set(idempotencyKey, {
        key: idempotencyKey,
        result: { ...result, duplicate: false },
        createdAt: new Date().toISOString(),
      });
      return result;
    }

    this.order = order;
    this.cursorCounter += 1;
    const cursor = this.getCursor();
    const event: ChangeEvent = {
      cursor,
      type: "order_updated",
      order: structuredClone(order),
      appliedAt: new Date().toISOString(),
      changedFields,
      conflictNotes: conflictNotes.length ? conflictNotes : undefined,
      sourceClientId: mutation.clientId,
      idempotencyKey,
    };
    this.changes.push(event);

    const result: PushResult = {
      ok: true,
      duplicate: false,
      order: structuredClone(order),
      cursor,
      conflictNotes,
    };

    this.idempotency.set(idempotencyKey, {
      key: idempotencyKey,
      result: { ...result, duplicate: false },
      createdAt: new Date().toISOString(),
    });

    this.emit(event);
    return result;
  }

  /**
   * Cursor-based pull: GET /changes?since=c_N → events after that cursor.
   */
  getChangesSince(since: string | null): { changes: ChangeEvent[]; cursor: string } {
    let startIndex = 0;
    if (since && since.startsWith("c_")) {
      const n = Number.parseInt(since.slice(2), 10);
      if (!Number.isNaN(n)) {
        startIndex = this.changes.findIndex((c) => {
          const cn = Number.parseInt(c.cursor.slice(2), 10);
          return cn > n;
        });
        if (startIndex === -1) {
          return { changes: [], cursor: this.getCursor() };
        }
      }
    }
    const slice = this.changes.slice(startIndex).map((c) => structuredClone(c));
    return { changes: slice, cursor: this.getCursor() };
  }

  reset(): Order {
    this.order = structuredClone(INITIAL_ORDER);
    this.changes = [];
    this.cursorCounter = 0;
    this.idempotency.clear();
    const event: ChangeEvent = {
      cursor: this.getCursor(),
      type: "order_reset",
      order: structuredClone(this.order),
      appliedAt: new Date().toISOString(),
      changedFields: ["quantity", "address"],
    };
    this.emit(event);
    return this.getOrder();
  }

  /** Test helper */
  getIdempotencyCount(): number {
    return this.idempotency.size;
  }
}
