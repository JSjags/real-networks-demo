import type { ClientId, FieldMeta, Order, MutationPayload } from "../shared/types.js";

export interface MergeResult {
  order: Order;
  changedFields: Array<"quantity" | "address">;
  conflictNotes: string[];
}

/**
 * Field-level merge with last-write-wins per field.
 *
 * - Different fields from different clients → both kept.
 * - Same field edited by both → later clientUpdatedAt wins; a conflict note is recorded.
 */
export function mergeMutation(
  current: Order,
  mutation: MutationPayload
): MergeResult {
  const next: Order = {
    ...current,
    fieldMeta: {
      quantity: { ...current.fieldMeta.quantity },
      address: { ...current.fieldMeta.address },
    },
  };
  const changedFields: Array<"quantity" | "address"> = [];
  const conflictNotes: string[] = [];
  const now = mutation.clientUpdatedAt;

  for (const field of ["quantity", "address"] as const) {
    const incoming = mutation.fields[field];
    if (incoming === undefined) continue;

    const meta = current.fieldMeta[field];
    if (current[field] === incoming) {
      continue;
    }

    const previousWriter = meta.updatedBy;

    // Last-write-wins: compare timestamps. If incoming is older, keep current.
    if (Date.parse(now) < Date.parse(meta.updatedAt)) {
      conflictNotes.push(
        `Kept ${label(previousWriter)}'s ${field} ("${current[field]}") — newer than ${label(mutation.clientId)}'s "${incoming}" (last-write-wins).`
      );
      continue;
    }

    next[field] = incoming;
    const newMeta: FieldMeta = {
      updatedAt: now,
      updatedBy: mutation.clientId,
    };

    // Same-field conflict when another client already wrote this field
    if (previousWriter !== "server" && previousWriter !== mutation.clientId) {
      const note = `Conflict on ${field}: ${label(mutation.clientId)} overwrote ${label(previousWriter)} ("${current[field]}" → "${incoming}") — last-write-wins per field.`;
      newMeta.conflictNote = note;
      conflictNotes.push(note);
    }

    next.fieldMeta[field] = newMeta;
    changedFields.push(field);
  }

  if (changedFields.length > 0) {
    next.updatedAt = now;
  }

  return { order: next, changedFields, conflictNotes };
}

function label(id: ClientId | "server"): string {
  if (id === "ada") return "Ada";
  if (id === "chidi") return "Chidi";
  return "server";
}

/**
 * Detect whether applying this mutation touches a field that another client
 * already changed since the baseline (used by tests / UI helpers).
 */
export function wouldConflict(
  current: Order,
  mutation: MutationPayload
): boolean {
  for (const field of ["quantity", "address"] as const) {
    if (mutation.fields[field] === undefined) continue;
    const meta = current.fieldMeta[field];
    if (
      meta.updatedBy !== "server" &&
      meta.updatedBy !== mutation.clientId &&
      current[field] !== mutation.fields[field]
    ) {
      return true;
    }
  }
  return false;
}
