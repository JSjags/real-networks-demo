import { describe, expect, it } from "vitest";
import { mergeMutation, wouldConflict } from "../server/merge";
import { INITIAL_ORDER, type MutationPayload, type Order } from "../shared/types";

function mut(
  clientId: MutationPayload["clientId"],
  fields: MutationPayload["fields"],
  at: string
): MutationPayload {
  return {
    orderId: "42",
    clientId,
    fields,
    clientUpdatedAt: at,
  };
}

describe("field-level merge (Ada & Chidi, order #42)", () => {
  it("keeps both edits when they touch different fields", () => {
    let order: Order = structuredClone(INITIAL_ORDER);

    const ada = mergeMutation(
      order,
      mut("ada", { quantity: "3 bags" }, "2026-10-31T17:01:00.000Z")
    );
    order = ada.order;
    expect(ada.changedFields).toEqual(["quantity"]);
    expect(ada.conflictNotes).toEqual([]);
    expect(order.quantity).toBe("3 bags");
    expect(order.address).toBe("Ama St.");

    const chidi = mergeMutation(
      order,
      mut("chidi", { address: "Aba Road" }, "2026-10-31T17:01:05.000Z")
    );
    order = chidi.order;
    expect(chidi.changedFields).toEqual(["address"]);
    expect(chidi.conflictNotes).toEqual([]);
    expect(order.quantity).toBe("3 bags");
    expect(order.address).toBe("Aba Road");
    expect(order.fieldMeta.quantity.updatedBy).toBe("ada");
    expect(order.fieldMeta.address.updatedBy).toBe("chidi");
  });

  it("resolves same-field conflict with last-write-wins and a note", () => {
    let order: Order = structuredClone(INITIAL_ORDER);

    order = mergeMutation(
      order,
      mut("ada", { quantity: "3 bags" }, "2026-10-31T17:02:00.000Z")
    ).order;

    const conflict = mergeMutation(
      order,
      mut("chidi", { quantity: "5 bags" }, "2026-10-31T17:02:30.000Z")
    );

    expect(wouldConflict(order, mut("chidi", { quantity: "5 bags" }, "2026-10-31T17:02:30.000Z"))).toBe(
      true
    );
    expect(conflict.order.quantity).toBe("5 bags");
    expect(conflict.conflictNotes.length).toBeGreaterThan(0);
    expect(conflict.conflictNotes[0]).toMatch(/last-write-wins/i);
    expect(conflict.conflictNotes[0]).toMatch(/Chidi/);
    expect(conflict.order.fieldMeta.quantity.conflictNote).toBeTruthy();
  });

  it("keeps the newer value when an older write arrives late", () => {
    let order: Order = structuredClone(INITIAL_ORDER);

    order = mergeMutation(
      order,
      mut("chidi", { address: "Aba Road" }, "2026-10-31T17:05:00.000Z")
    ).order;

    const late = mergeMutation(
      order,
      mut("ada", { address: "Old Lane" }, "2026-10-31T17:04:00.000Z")
    );

    expect(late.order.address).toBe("Aba Road");
    expect(late.conflictNotes[0]).toMatch(/Kept Chidi/i);
  });
});
