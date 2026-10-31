/** Shared types for the order #42 offline-first demo. */

export type ClientId = "ada" | "chidi";

export interface Order {
  id: string;
  quantity: string;
  address: string;
  updatedAt: string;
  /** Per-field last writer metadata for conflict display */
  fieldMeta: {
    quantity: FieldMeta;
    address: FieldMeta;
  };
}

export interface FieldMeta {
  updatedAt: string;
  updatedBy: ClientId | "server";
  /** Set when a same-field conflict was resolved (last-write-wins) */
  conflictNote?: string;
}

export interface MutationPayload {
  orderId: string;
  fields: Partial<Pick<Order, "quantity" | "address">>;
  clientId: ClientId;
  clientUpdatedAt: string;
}

export interface OutboxEntry {
  /** Client-generated UUID — also sent as Idempotency-Key */
  id: string;
  op: "update_order";
  payload: MutationPayload;
  seq: number;
  status: "pending" | "sending" | "synced" | "failed";
  createdAt: string;
  lastError?: string;
  attempts: number;
}

export interface ChangeEvent {
  cursor: string;
  type: "order_updated" | "order_reset";
  order: Order;
  appliedAt: string;
  /** Which fields changed in this event */
  changedFields: Array<"quantity" | "address">;
  /** Conflict notes produced while applying this mutation */
  conflictNotes?: string[];
  sourceClientId?: ClientId;
  idempotencyKey?: string;
}

export interface PushResult {
  ok: true;
  duplicate: boolean;
  order: Order;
  cursor: string;
  conflictNotes: string[];
}

export interface ChangesResponse {
  changes: ChangeEvent[];
  cursor: string;
}

/** Seed timestamps must be in the past so live client writes always win LWW. */
export const ORDER_BASELINE_AT = "2020-01-01T00:00:00.000Z";

export const INITIAL_ORDER: Order = {
  id: "42",
  quantity: "1 bag",
  address: "Ama St.",
  updatedAt: ORDER_BASELINE_AT,
  fieldMeta: {
    quantity: {
      updatedAt: ORDER_BASELINE_AT,
      updatedBy: "server",
    },
    address: {
      updatedAt: ORDER_BASELINE_AT,
      updatedBy: "server",
    },
  },
};

export const CLIENT_LABELS: Record<ClientId, string> = {
  ada: "Ada (phone)",
  chidi: "Chidi (web)",
};
