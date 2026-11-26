import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, undefined members dropped.
 * Two payloads that mean the same thing always hash the same, so an approval
 * can be bound to exactly what the user saw.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Cannot canonicalize a non-finite number");
    }
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
      throw new TypeError(`Cannot canonicalize a ${typeof value}`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const members = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`);
  return `{${members.join(",")}}`;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hashPayload(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Freeze an object graph so a proposal's payload cannot be mutated in memory. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
