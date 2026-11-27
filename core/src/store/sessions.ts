import type Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

export type History = Anthropic.Beta.BetaMessageParam[];

export interface Session {
  id: string;
  messages: History;
  turns: number;
}

/** A conversation goes quiet after this long; the next request starts a fresh one. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** Long conversations also roll over, to bound cost and context size. */
export const SESSION_MAX_TURNS = 40;

/**
 * Encrypted conversation history. History is only ever appended to (never edited),
 * which keeps prompt caching effective and the model's reasoning chain valid.
 */
export class SessionStore {
  #db: DatabaseSync;
  #key: Buffer;
  #now: () => number;

  constructor(db: DatabaseSync, dataKey: Buffer, now: () => number = Date.now) {
    this.#db = db;
    this.#key = dataKey;
    this.#now = now;
  }

  /** Resume `id` if it's still fresh; otherwise start a new session. */
  resumeOrCreate(id?: string): Session {
    if (id) {
      const row = this.#db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as
        | { id: string; messages_enc: string; turns: number; updated_at: number }
        | undefined;
      if (row && this.#now() - row.updated_at < SESSION_IDLE_MS && row.turns < SESSION_MAX_TURNS) {
        return { id: row.id, messages: JSON.parse(open(this.#key, row.messages_enc)), turns: row.turns };
      }
    }
    const session = { id: randomUUID(), messages: [], turns: 0 };
    const now = this.#now();
    this.#db
      .prepare("INSERT INTO sessions (id, messages_enc, turns, created_at, updated_at) VALUES (?, ?, 0, ?, ?)")
      .run(session.id, seal(this.#key, "[]"), now, now);
    return session;
  }

  save(id: string, messages: History, turns: number): void {
    this.#db
      .prepare("UPDATE sessions SET messages_enc = ?, turns = ?, updated_at = ? WHERE id = ?")
      .run(seal(this.#key, JSON.stringify(messages)), turns, this.#now(), id);
  }
}
