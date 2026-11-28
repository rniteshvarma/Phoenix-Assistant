import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPhoenix } from "../phoenix.ts";
import { loadMasterKey, writeMasterKey } from "../security/keys.ts";
import { tempConfig } from "../testing.ts";
import { applyBackup, backupDue, backupSettings, createBackup, openBackup, setupBackupKey, updateBackupSettings } from "./backup.ts";

test("backup round trip: everything comes back on a fresh Mac with the passphrase, and only with it", () => {
  const { cfg, cleanup } = tempConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-backups-"));
  const fresh = tempConfig();
  try {
    const phoenix = createPhoenix(cfg);
    phoenix.memory.add("Lives in Hyderabad", { kind: "profile" });
    phoenix.skills.save({ name: "My usual order", description: "Reorder", steps: "1. Open the app" });
    fs.writeFileSync(path.join(cfg.notesDir, "idea.md"), "Phoenix idea");
    updateBackupSettings(phoenix.settings, { dir, keep: 2 });
    assert.throws(() => setupBackupKey(phoenix.settings, "short"), /12 characters/);
    assert.throws(() => createBackup(cfg, phoenix.settings, loadMasterKey(cfg)), /passphrase first/);
    setupBackupKey(phoenix.settings, "correct horse battery staple");
    const file = createBackup(cfg, phoenix.settings, loadMasterKey(cfg), Date.parse("2026-11-28T01:00:00Z"));
    const master = loadMasterKey(cfg);
    phoenix.close();

    const raw = fs.readFileSync(file);
    assert.ok(!raw.includes("Hyderabad") && !raw.includes(master.toString("hex")), "nothing readable in the file");
    assert.throws(() => openBackup(file, "wrong passphrase!!"), /wrong passphrase/);
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 5]! ^= 0xff;
    fs.writeFileSync(`${file}.bad`, tampered);
    assert.throws(() => openBackup(`${file}.bad`, "correct horse battery staple"), /damaged/);
    fs.rmSync(`${file}.bad`);

    // Restore onto a brand-new Phoenix home (a different master key there).
    const b = openBackup(file, "correct horse battery staple");
    createPhoenix(fresh.cfg).close();
    const aside = applyBackup(fresh.cfg, b, (m) => writeMasterKey(fresh.cfg, m));
    assert.ok(fs.existsSync(aside), "the previous database is kept");
    const restored = createPhoenix(fresh.cfg);
    assert.deepEqual(restored.memory.list("profile").map((m) => m.text), ["Lives in Hyderabad"]);
    assert.equal(restored.skills.list()[0]!.name, "My usual order");
    assert.equal(fs.readFileSync(path.join(fresh.cfg.notesDir, "idea.md"), "utf8"), "Phoenix idea");
    restored.close();
  } finally {
    cleanup();
    fresh.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("backups: only the newest are kept, and nightly runs once a day", () => {
  const { cfg, cleanup } = tempConfig();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-backups-"));
  try {
    const phoenix = createPhoenix(cfg);
    updateBackupSettings(phoenix.settings, { dir, keep: 2 });
    setupBackupKey(phoenix.settings, "another long passphrase");
    const t0 = Date.parse("2026-11-20T02:00:00Z");
    for (let d = 0; d < 4; d += 1) createBackup(cfg, phoenix.settings, loadMasterKey(cfg), t0 + d * 86_400_000);
    assert.equal(fs.readdirSync(dir).filter((f) => f.endsWith(".phx")).length, 2);
    const s = backupSettings(phoenix.settings);
    assert.equal(backupDue(s, s.lastBackup! + 3600_000), false);
    assert.equal(backupDue(s, s.lastBackup! + 25 * 3600_000), true);
    assert.equal(backupDue({ ...s, nightly: false }, s.lastBackup! + 25 * 3600_000), false);
    phoenix.close();
  } finally {
    cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
