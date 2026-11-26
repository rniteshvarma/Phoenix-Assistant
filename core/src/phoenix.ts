import { runTask, type AgentEvent, type Approver, type TaskOutcome } from "./agent/loop.ts";
import type { ModelClient } from "./agent/model.ts";
import { AuditLog } from "./audit/log.ts";
import { ensureDirs, type PhoenixConfig } from "./config.ts";
import { ApprovalAuthority } from "./policy/approvals.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { GuardedExecutor } from "./policy/executor.ts";
import { loadKeys } from "./security/keys.ts";
import { openDatabase } from "./store/db.ts";
import { TaskStore } from "./store/tasks.ts";
import { BUILTIN_TOOLS } from "./tools/builtin.ts";
import { ToolRegistry, type Tool } from "./tools/types.ts";

/** Composition root: wires storage, security, policy and the agent together. */
export function createPhoenix(cfg: PhoenixConfig, opts: { tools?: Tool[] } = {}) {
  ensureDirs(cfg);
  const keys = loadKeys(cfg);
  const db = openDatabase(cfg.dbPath);
  const audit = new AuditLog(db, keys.dataKey);
  const tasks = new TaskStore(db, keys.dataKey);
  const registry = new ToolRegistry(opts.tools ?? BUILTIN_TOOLS);
  const policy = new PolicyEngine(registry);
  const authority = new ApprovalAuthority(keys.hmacKey, { ttlMs: cfg.approvalTtlMs });
  const executor = new GuardedExecutor({ registry, policy, authority, audit, cfg });

  return {
    cfg,
    audit,
    tasks,
    registry,
    policy,
    authority,
    executor,
    run(
      request: string,
      deps: { model: ModelClient; approver: Approver },
      runOpts: { onEvent?: (e: AgentEvent) => void; signal?: AbortSignal } = {},
    ): Promise<TaskOutcome> {
      return runTask(
        { ...deps, registry, policy, authority, executor, audit, tasks, maxSteps: cfg.maxSteps },
        request,
        runOpts,
      );
    },
    close() {
      db.close();
    },
  };
}

export type Phoenix = ReturnType<typeof createPhoenix>;
