import { renderContext } from "./agent/context.ts";
import { runTask, type AgentEvent, type Approver, type TaskOutcome } from "./agent/loop.ts";
import type { ModelClient } from "./agent/model.ts";
import { AuditLog } from "./audit/log.ts";
import { ensureDirs, type PhoenixConfig } from "./config.ts";
import { DeviceHub } from "./gateway/devices.ts";
import { ApprovalAuthority } from "./policy/approvals.ts";
import { PrivacyVault } from "./privacy/vault.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { GuardedExecutor } from "./policy/executor.ts";
import { loadKeys } from "./security/keys.ts";
import { openDatabase } from "./store/db.ts";
import { MemoryStore } from "./store/memory.ts";
import { SessionStore } from "./store/sessions.ts";
import { TaskStore } from "./store/tasks.ts";
import { BUILTIN_TOOLS } from "./tools/builtin.ts";
import { ToolRegistry, type Tool } from "./tools/types.ts";

export interface AskOptions {
  model: ModelClient;
  approver: Approver;
  /** Continue this conversation if it's still fresh; omit to start a new one. */
  sessionId?: string;
  channel?: "voice" | "text";
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Override the clock (tests). */
  now?: Date;
}

export interface AskResult extends TaskOutcome {
  sessionId: string;
}

/** Composition root: wires storage, security, policy, memory, devices and the agent together. */
export function createPhoenix(cfg: PhoenixConfig, opts: { tools?: Tool[] } = {}) {
  ensureDirs(cfg);
  const keys = loadKeys(cfg);
  const db = openDatabase(cfg.dbPath);
  const audit = new AuditLog(db, keys.dataKey);
  const tasks = new TaskStore(db, keys.dataKey);
  const sessions = new SessionStore(db, keys.dataKey);
  const memory = new MemoryStore(db, keys.dataKey);
  const devices = new DeviceHub();
  const vault = new PrivacyVault(db, keys.dataKey, keys.privacyKey);
  const registry = new ToolRegistry(opts.tools ?? BUILTIN_TOOLS);
  const policy = new PolicyEngine(registry);
  const authority = new ApprovalAuthority(keys.hmacKey, { ttlMs: cfg.approvalTtlMs });
  const executor = new GuardedExecutor({
    registry,
    policy,
    authority,
    audit,
    cfg,
    services: { memory, devices },
    vault,
  });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    cfg,
    audit,
    tasks,
    sessions,
    memory,
    devices,
    vault,
    registry,
    policy,
    authority,
    executor,

    /** Handle one user request, continuing a conversation when `sessionId` is given. */
    async ask(request: string, o: AskOptions): Promise<AskResult> {
      const session = sessions.resumeOrCreate(o.sessionId);
      // Privacy Shield: sensitive values become placeholders before anything reaches the model.
      const context = renderContext({
        now: o.now ?? new Date(),
        timeZone,
        memories: memory.list(),
        channel: o.channel ?? "text",
      });
      const safeRequest = vault.protect(request).text;
      const safeContext = vault.protect(context).text;
      const outcome = await runTask(
        { model: o.model, approver: o.approver, registry, policy, authority, executor, audit, tasks, vault, maxSteps: cfg.maxSteps },
        safeRequest,
        { onEvent: o.onEvent, signal: o.signal, history: session.messages, context: safeContext },
      );
      sessions.save(session.id, outcome.messages, session.turns + 1);
      return { ...outcome, sessionId: session.id };
    },

    close() {
      db.close();
    },
  };
}

export type Phoenix = ReturnType<typeof createPhoenix>;
