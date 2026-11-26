import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

export type TaskStatus =
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  request: string;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Durable task state, so long-running work survives restarts (resume arrives in Phase 1). */
export class TaskStore {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(db: DatabaseSync, dataKey: Buffer) {
    this.#db = db;
    this.#key = dataKey;
  }

  create(request: string): string {
    const id = randomUUID();
    const now = Date.now();
    this.#db
      .prepare(
        "INSERT INTO tasks (id, status, request_enc, created_at, updated_at) VALUES (?, 'running', ?, ?, ?)",
      )
      .run(id, seal(this.#key, request), now, now);
    return id;
  }

  setStatus(id: string, status: TaskStatus): void {
    this.#db
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }

  saveTranscript(id: string, transcript: unknown): void {
    this.#db
      .prepare("UPDATE tasks SET transcript_enc = ?, updated_at = ? WHERE id = ?")
      .run(seal(this.#key, JSON.stringify(transcript)), Date.now(), id);
  }

  finish(id: string, status: Exclude<TaskStatus, "running" | "awaiting_approval">, result: string): void {
    this.#db
      .prepare("UPDATE tasks SET status = ?, result_enc = ?, updated_at = ? WHERE id = ?")
      .run(status, seal(this.#key, result), Date.now(), id);
  }

  get(id: string): TaskRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | {
          id: string;
          status: TaskStatus;
          request_enc: string;
          result_enc: string | null;
          created_at: number;
          updated_at: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      status: row.status,
      request: open(this.#key, row.request_enc),
      result: row.result_enc ? open(this.#key, row.result_enc) : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
