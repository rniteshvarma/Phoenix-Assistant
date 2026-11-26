import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Hex } from "../security/canonical.ts";
import { open, seal } from "../security/crypto.ts";
import { transaction } from "../store/db.ts";

export type AuditType =
  | "task.received"
  | "model.turn"
  | "policy.decision"
  | "approval.proposed"
  | "approval.granted"
  | "approval.rejected"
  | "tool.executed"
  | "tool.failed"
  | "tool.token_rejected"
  | "task.completed"
  | "task.failed"
  | "task.cancelled";

export interface AuditEntry {
  seq: number;
  ts: number;
  taskId: string | null;
  type: string;
  data: unknown;
  hash: string;
}

export type VerifyReport =
  | { ok: true; count: number }
  | { ok: false; count: number; brokenAt: number; reason: string };

interface Row {
  seq: number;
  ts: number;
  task_id: string | null;
  type: string;
  data_enc: string;
  prev_hash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function entryHash(r: Omit<Row, "hash">): string {
  return sha256Hex(canonicalJson([r.seq, r.ts, r.task_id, r.type, r.data_enc, r.prev_hash]));
}

/**
 * Append-only, hash-chained, encrypted log of everything Phoenix plans and does.
 * Each entry's hash covers the previous one, so editing or removing any entry
 * breaks verification from that point on. SQL triggers also reject UPDATE/DELETE.
 */
export class AuditLog {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(db: DatabaseSync, dataKey: Buffer) {
    this.#db = db;
    this.#key = dataKey;
  }

  append(type: AuditType, taskId: string | null, data: Record<string, unknown>): string {
    return transaction(this.#db, () => {
      const last = this.#db
        .prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1")
        .get() as { seq: number; hash: string } | undefined;
      const row = {
        seq: (last?.seq ?? 0) + 1,
        ts: Date.now(),
        task_id: taskId,
        type,
        data_enc: seal(this.#key, JSON.stringify(data)),
        prev_hash: last?.hash ?? GENESIS,
      };
      const hash = entryHash(row);
      this.#db
        .prepare(
          "INSERT INTO audit (seq, ts, task_id, type, data_enc, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(row.seq, row.ts, row.task_id, row.type, row.data_enc, row.prev_hash, hash);
      return hash;
    });
  }

  verify(): VerifyReport {
    const rows = this.#db.prepare("SELECT * FROM audit ORDER BY seq ASC").all() as unknown as Row[];
    let prev = GENESIS;
    let expectedSeq = 1;
    for (const row of rows) {
      if (row.seq !== expectedSeq) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: `missing entry #${expectedSeq}` };
      }
      if (row.prev_hash !== prev) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: "chain link broken" };
      }
      if (entryHash(row) !== row.hash) {
        return { ok: false, count: rows.length, brokenAt: row.seq, reason: "entry was modified" };
      }
      prev = row.hash;
      expectedSeq += 1;
    }
    return { ok: true, count: rows.length };
  }

  list(opts: { limit?: number; taskId?: string } = {}): AuditEntry[] {
    const limit = opts.limit ?? 50;
    const rows = (
      opts.taskId
        ? this.#db
            .prepare("SELECT * FROM audit WHERE task_id = ? ORDER BY seq DESC LIMIT ?")
            .all(opts.taskId, limit)
        : this.#db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit)
    ) as unknown as Row[];
    return rows.reverse().map((r) => ({
      seq: r.seq,
      ts: r.ts,
      taskId: r.task_id,
      type: r.type,
      data: this.#decrypt(r.data_enc),
      hash: r.hash,
    }));
  }

  #decrypt(sealed: string): unknown {
    try {
      return JSON.parse(open(this.#key, sealed));
    } catch {
      return "<unreadable: wrong key or tampered>";
    }
  }
}
