import Dexie, { type Table } from "dexie";
import type { ClientId, Order, OutboxEntry } from "../../shared/types";
import { INITIAL_ORDER } from "../../shared/types";

export interface MetaRow {
  key: string;
  value: string;
}

export interface SyncLogRow {
  id?: number;
  at: string;
  level: "info" | "warn" | "error" | "ok";
  message: string;
}

export class OrderDatabase extends Dexie {
  orders!: Table<Order, string>;
  outbox!: Table<OutboxEntry, string>;
  meta!: Table<MetaRow, string>;
  syncLog!: Table<SyncLogRow, number>;

  constructor(clientId: ClientId) {
    super(`order42_${clientId}`);
    this.version(1).stores({
      orders: "id",
      outbox: "id, seq, status",
      meta: "key",
      syncLog: "++id, at",
    });
  }
}

let db: OrderDatabase | null = null;
let activeClient: ClientId | null = null;

export function getDb(clientId: ClientId): OrderDatabase {
  if (db && activeClient === clientId) return db;
  if (db) db.close();
  db = new OrderDatabase(clientId);
  activeClient = clientId;
  return db;
}

export async function ensureSeed(clientId: ClientId): Promise<Order> {
  const database = getDb(clientId);
  const existing = await database.orders.get("42");
  if (existing) return existing;
  const order = structuredClone(INITIAL_ORDER);
  await database.orders.put(order);
  await database.meta.put({ key: "cursor", value: "c_0" });
  await database.meta.put({ key: "clientId", value: clientId });
  return order;
}

export async function getCursor(clientId: ClientId): Promise<string> {
  const row = await getDb(clientId).meta.get("cursor");
  return row?.value ?? "c_0";
}

export async function setCursor(clientId: ClientId, cursor: string): Promise<void> {
  await getDb(clientId).meta.put({ key: "cursor", value: cursor });
}

export async function logSync(
  clientId: ClientId,
  level: SyncLogRow["level"],
  message: string
): Promise<void> {
  const database = getDb(clientId);
  await database.syncLog.add({
    at: new Date().toISOString(),
    level,
    message,
  });
  const count = await database.syncLog.count();
  if (count > 80) {
    const old = await database.syncLog.orderBy("id").limit(count - 80).toArray();
    await database.syncLog.bulkDelete(old.map((r) => r.id!).filter(Boolean));
  }
}

export async function clearLocal(clientId: ClientId): Promise<void> {
  const database = getDb(clientId);
  await database.transaction("rw", database.orders, database.outbox, database.meta, database.syncLog, async () => {
    await database.orders.clear();
    await database.outbox.clear();
    await database.meta.clear();
    await database.syncLog.clear();
    await database.orders.put(structuredClone(INITIAL_ORDER));
    await database.meta.put({ key: "cursor", value: "c_0" });
    await database.meta.put({ key: "clientId", value: clientId });
  });
}

export async function nextSeq(clientId: ClientId): Promise<number> {
  const last = await getDb(clientId).outbox.orderBy("seq").last();
  return (last?.seq ?? 0) + 1;
}
