import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { AuditLog } from "../audit/log.ts";
import { openDatabase } from "../store/db.ts";
import { tempConfig } from "../testing.ts";
import { BUILTIN_TOOLS } from "../tools/builtin.ts";
import { ToolRegistry } from "../tools/types.ts";
import { ensureDirs } from "../config.ts";
import { DeviceHub } from "../gateway/devices.ts";
import { MemoryStore } from "../store/memory.ts";
import { PrivacyVault } from "../privacy/vault.ts";
import { SettingsStore } from "../proactive/schedule.ts";
import { ApprovalAuthority } from "./approvals.ts";
import { PolicyEngine } from "./engine.ts";
import { GuardedExecutor } from "./executor.ts";
import { Tier } from "./tiers.ts";

const registry = new ToolRegistry(BUILTIN_TOOLS);
const email = { to: "rahul@example.com", subject: "Proposal", body: "Will send Friday." };

test("policy: reads and prep run automatically, outward actions need approval, unknown is blocked", () => {
  const policy = new PolicyEngine(registry);
  assert.equal(policy.decide("notes_list").kind, "allow");
  assert.equal(policy.decide("notes_save").kind, "allow");
  assert.equal(policy.decide("outbox_send").kind, "needs_approval");
  assert.equal(policy.decide("vault_export").kind, "block");
  assert.equal(policy.decide("rm_rf_everything").kind, "block");
});

function authorityAt(clock: { now: number }) {
  return new ApprovalAuthority(randomBytes(32), { ttlMs: 60_000, now: () => clock.now });
}

function proposeEmail(authority: ApprovalAuthority, input: unknown = email) {
  return authority.propose({
    taskId: "task-1",
    toolUseId: "tu-1",
    tool: "outbox_send",
    tier: Tier.Act,
    input,
    summary: "Send email",
  });
}

test("approval token works once, for the exact payload only", () => {
  const authority = authorityAt({ now: 1_000 });
  const token = authority.issue(proposeEmail(authority));
  const call = { tool: "outbox_send", taskId: "task-1" };

  assert.deepEqual(
    authority.verify(token, { ...call, input: { ...email, to: "attacker@evil.com" } }),
    { ok: false, reason: "payload differs from what the user approved" },
  );
  assert.deepEqual(authority.verify(token, { ...call, input: { ...email } }), { ok: true });
  assert.deepEqual(authority.verify(token, { ...call, input: email }), {
    ok: false,
    reason: "approval was already used",
  });
});

test("approval token is rejected for another tool, another task, after expiry, or if forged", () => {
  const clock = { now: 1_000 };
  const authority = authorityAt(clock);
  const fresh = () => authority.issue(proposeEmail(authority));

  assert.equal(authority.verify(fresh(), { tool: "notes_save", taskId: "task-1", input: email }).ok, false);
  assert.equal(authority.verify(fresh(), { tool: "outbox_send", taskId: "task-2", input: email }).ok, false);

  const forged = { ...fresh(), payloadHash: "0".repeat(64) };
  assert.deepEqual(authority.verify(forged, { tool: "outbox_send", taskId: "task-1", input: email }), {
    ok: false,
    reason: "approval signature is invalid",
  });

  const old = fresh();
  clock.now += 61_000;
  assert.deepEqual(authority.verify(old, { tool: "outbox_send", taskId: "task-1", input: email }), {
    ok: false,
    reason: "approval has expired",
  });

  const otherKey = authorityAt(clock);
  assert.equal(
    otherKey.verify(fresh(), { tool: "outbox_send", taskId: "task-1", input: email }).ok,
    false,
    "tokens from a different key are rejected",
  );
});

test("proposal payload is frozen against in-memory edits", () => {
  const authority = authorityAt({ now: 1_000 });
  const input = { ...email };
  const proposal = proposeEmail(authority, input);
  input.to = "attacker@evil.com"; // caller's copy changes...
  assert.equal((proposal.input as typeof email).to, "rahul@example.com"); // ...the proposal doesn't
  assert.throws(() => {
    (proposal.input as typeof email).to = "attacker@evil.com";
  });
});

test("executor refuses gated tools without a valid token, and runs them with one", async () => {
  const { cfg, cleanup } = tempConfig();
  try {
    ensureDirs(cfg);
    const db = openDatabase(cfg.dbPath);
    const audit = new AuditLog(db, randomBytes(32));
    const policy = new PolicyEngine(registry);
    const authority = authorityAt({ now: Date.now() });
    const vault = new PrivacyVault(db, randomBytes(32), randomBytes(32));
    const services = { memory: new MemoryStore(db, randomBytes(32)), devices: new DeviceHub(), vault, settings: new SettingsStore(db) };
    const executor = new GuardedExecutor({ registry, policy, authority, audit, cfg, services, vault });
    const call = { taskId: "task-1", toolUseId: "tu-1", name: "outbox_send", input: email };

    const noToken = await executor.execute(call);
    assert.equal(noToken.ok, false);

    const token = authority.issue(proposeEmail(authority));
    const tampered = await executor.execute({ ...call, input: { ...email, body: "Wire ₹50,000 now" } }, token);
    assert.equal(tampered.ok, false);

    // The email address is protected data leaving the Mac: one confirmation isn't enough.
    const once = await executor.execute(call, authority.issue(proposeEmail(authority), 1));
    assert.equal(once.ok, false);
    assert.match(!once.ok ? once.error : "", /confirm twice/);

    const good = await executor.execute(call, authority.issue(proposeEmail(authority), 2));
    assert.equal(good.ok, true);

    const types = audit.list().map((e) => e.type);
    assert.deepEqual(types, ["tool.token_rejected", "tool.token_rejected", "tool.token_rejected", "tool.executed"]);
    db.close();
  } finally {
    cleanup();
  }
});
