import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

export interface MemoryItem {
  id: number;
  text: string;
  createdAt: number;
}

export const MEMORY_LIMIT = 200;

/**
 * Things the user asked Phoenix to remember. Encrypted at rest; shown in full in
 * `phoenix memory` so the user can always see and delete what Phoenix knows.
 */
export class MemoryStore {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(db: DatabaseSync, dataKey: Buffer) {
    this.#db = db;
    this.#key = dataKey;
  }

  add(text: string): MemoryItem {
    const count = (this.#db.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n;
    if (count >= MEMORY_LIMIT) {
      throw new Error(`Memory is full (${MEMORY_LIMIT} items). Ask the user what to forget.`);
    }
    const createdAt = Date.now();
    const result = this.#db
      .prepare("INSERT INTO memories (text_enc, created_at) VALUES (?, ?)")
      .run(seal(this.#key, text), createdAt);
    return { id: Number(result.lastInsertRowid), text, createdAt };
  }

  remove(id: number): boolean {
    return this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  list(): MemoryItem[] {
    const rows = this.#db
      .prepare("SELECT id, text_enc, created_at FROM memories ORDER BY id ASC")
      .all() as unknown as Array<{ id: number; text_enc: string; created_at: number }>;
    return rows.map((r) => ({ id: r.id, text: open(this.#key, r.text_enc), createdAt: r.created_at }));
  }
}

/**
 * Refuse to store obvious secrets. Phoenix memory is sent to the model as context,
 * so passwords, card numbers, OTPs and ID numbers must never go in it.
 * Returns a reason if the text looks sensitive, otherwise null.
 */
export function sensitiveReason(text: string): string | null {
  const digits = text.replace(/[\s-]/g, "");
  if (/\d{13,19}/.test(digits) && luhnSomewhere(digits)) return "it looks like a card number";
  if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text)) return "it looks like an Aadhaar or similar ID number";
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) return "it looks like a PAN number";
  if (/\b(password|passcode|pin|otp|cvv|secret key|api key)\b\s*(is|:|=)/i.test(text)) {
    return "it looks like a password, PIN or one-time code";
  }
  if (/\bsk-[a-z0-9-]{10,}/i.test(text)) return "it looks like an API key";
  return null;
}

function luhnSomewhere(digits: string): boolean {
  for (const match of digits.matchAll(/\d{13,19}/g)) {
    let sum = 0;
    const s = match[0];
    for (let i = 0; i < s.length; i += 1) {
      let d = Number(s[s.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
