import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ensureDirs } from "../config.ts";
import { openDatabase } from "../store/db.ts";
import { tempConfig } from "../testing.ts";
import { AuditLog } from "./log.ts";

function withLog(fn: (log: AuditLog, db: ReturnType<typeof openDatabase>) => void) {
  const { cfg, cleanup } = tempConfig();
  ensureDirs(cfg);
  const db = openDatabase(cfg.dbPath);
  try {
    fn(new AuditLog(db, randomBytes(32)), db);
  } finally {
    db.close();
    cleanup();
  }
}

test("audit log appends, decrypts and verifies", () => {
  withLog((log) => {
    log.append("task.received", "t1", { request: "hello" });
    log.append("task.completed", "t1", { text: "done" });
    assert.deepEqual(log.verify(), { ok: true, count: 2 });
    const entries = log.list();
    assert.deepEqual(
      entries.map((e) => [e.type, e.data]),
      [
        ["task.received", { request: "hello" }],
        ["task.completed", { text: "done" }],
      ],
    );
  });
});

test("audit entries are encrypted at rest", () => {
  withLog((log, db) => {
    log.append("task.received", "t1", { request: "my secret plans" });
    const row = db.prepare("SELECT data_enc FROM audit").get() as { data_enc: string };
    assert.ok(!row.data_enc.includes("secret"));
  });
});

test("audit log rejects UPDATE and DELETE", () => {
  withLog((log, db) => {
    log.append("task.received", "t1", { request: "x" });
    assert.throws(() => db.exec("UPDATE audit SET type = 'task.completed'"), /append-only/);
    assert.throws(() => db.exec("DELETE FROM audit"), /append-only/);
  });
});

test("audit verify detects edits and removed entries even if triggers are bypassed", () => {
  withLog((log, db) => {
    for (let i = 0; i < 4; i += 1) log.append("model.turn", "t1", { step: i });
    db.exec("DROP TRIGGER audit_no_update; DROP TRIGGER audit_no_delete;");

    db.exec("UPDATE audit SET type = 'task.completed' WHERE seq = 3");
    const edited = log.verify();
    assert.equal(edited.ok, false);
    assert.equal(!edited.ok && edited.brokenAt, 3);

    db.exec("UPDATE audit SET type = 'model.turn' WHERE seq = 3");
    assert.equal(log.verify().ok, true);

    db.exec("DELETE FROM audit WHERE seq = 2");
    const removed = log.verify();
    assert.equal(removed.ok, false);
    assert.equal(!removed.ok && removed.brokenAt, 3);
  });
});
