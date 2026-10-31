import { describe, expect, it } from "vitest";
import { OrderStore } from "../server/store";

describe("idempotency keys (Idempotency-Key dedupe)", () => {
  it("applies a mutation once and returns the same result on retry", () => {
    const store = new OrderStore();
    const key = "11111111-2222-4333-8444-555555555555";

    const first = store.push(key, {
      orderId: "42",
      clientId: "ada",
      fields: { quantity: "3 bags" },
      clientUpdatedAt: "2026-10-31T17:10:00.000Z",
    });

    expect(first.duplicate).toBe(false);
    expect(first.order.quantity).toBe("3 bags");
    expect(store.getIdempotencyCount()).toBe(1);

    const second = store.push(key, {
      orderId: "42",
      clientId: "ada",
      fields: { quantity: "3 bags" },
      clientUpdatedAt: "2026-10-31T17:10:00.000Z",
    });

    expect(second.duplicate).toBe(true);
    expect(second.order.quantity).toBe("3 bags");
    expect(second.cursor).toBe(first.cursor);
    expect(store.getIdempotencyCount()).toBe(1);

    // Only one change event should exist
    const changes = store.getChangesSince("c_0");
    expect(changes.changes).toHaveLength(1);
  });

  it("treats different keys as separate writes", () => {
    const store = new OrderStore();

    store.push("key-a", {
      orderId: "42",
      clientId: "ada",
      fields: { quantity: "3 bags" },
      clientUpdatedAt: "2026-10-31T17:11:00.000Z",
    });

    store.push("key-b", {
      orderId: "42",
      clientId: "chidi",
      fields: { address: "Aba Road" },
      clientUpdatedAt: "2026-10-31T17:11:05.000Z",
    });

    const order = store.getOrder();
    expect(order.quantity).toBe("3 bags");
    expect(order.address).toBe("Aba Road");
    expect(store.getIdempotencyCount()).toBe(2);
    expect(store.getChangesSince(null).changes).toHaveLength(2);
  });

  it("reset clears idempotency records and restores baseline", () => {
    const store = new OrderStore();
    store.push("k1", {
      orderId: "42",
      clientId: "ada",
      fields: { quantity: "9 bags" },
      clientUpdatedAt: "2026-10-31T17:12:00.000Z",
    });
    const order = store.reset();
    expect(order.quantity).toBe("1 bag");
    expect(order.address).toBe("Ama St.");
    expect(store.getIdempotencyCount()).toBe(0);
    expect(store.getCursor()).toBe("c_0");
  });
});
