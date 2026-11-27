import type { AuditLog } from "../audit/log.ts";
import type { PhoenixConfig } from "../config.ts";
import { sha256Hex } from "../security/canonical.ts";
import type { ToolRegistry, ToolServices } from "../tools/types.ts";
import type { ApprovalAuthority, ApprovalToken } from "./approvals.ts";
import type { PolicyEngine } from "./engine.ts";

export interface ToolCall {
  taskId: string;
  toolUseId: string;
  name: string;
  input: unknown;
}

export type ExecResult = { ok: true; output: string } | { ok: false; error: string };

/**
 * The only path to running a tool. It re-checks policy and, for gated tools,
 * verifies the approval token against the exact payload being executed.
 */
export class GuardedExecutor {
  #registry: ToolRegistry;
  #policy: PolicyEngine;
  #authority: ApprovalAuthority;
  #audit: AuditLog;
  #cfg: PhoenixConfig;
  #services: ToolServices;

  constructor(deps: {
    registry: ToolRegistry;
    policy: PolicyEngine;
    authority: ApprovalAuthority;
    audit: AuditLog;
    cfg: PhoenixConfig;
    services: ToolServices;
  }) {
    this.#registry = deps.registry;
    this.#policy = deps.policy;
    this.#authority = deps.authority;
    this.#audit = deps.audit;
    this.#cfg = deps.cfg;
    this.#services = deps.services;
  }

  async execute(call: ToolCall, token?: ApprovalToken): Promise<ExecResult> {
    const decision = this.#policy.decide(call.name);
    if (decision.kind === "block") {
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: decision.reason });
      return { ok: false, error: `Blocked by Phoenix policy: ${decision.reason}.` };
    }

    if (decision.kind === "needs_approval") {
      const verdict = token
        ? this.#authority.verify(token, { tool: call.name, taskId: call.taskId, input: call.input })
        : ({ ok: false, reason: "no approval token" } as const);
      if (!verdict.ok) {
        this.#audit.append("tool.token_rejected", call.taskId, {
          tool: call.name,
          toolUseId: call.toolUseId,
          reason: verdict.reason,
        });
        return { ok: false, error: `Not executed: ${verdict.reason}.` };
      }
    }

    const tool = this.#registry.get(call.name)!;
    const parsed = tool.parse(call.input);
    if (!parsed.ok) {
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: "invalid input" });
      return { ok: false, error: `Invalid input for ${call.name}:\n${parsed.error}` };
    }

    try {
      const output = await tool.run(parsed.value, {
        ...this.#services,
        cfg: this.#cfg,
        taskId: call.taskId,
      });
      this.#audit.append("tool.executed", call.taskId, {
        tool: call.name,
        toolUseId: call.toolUseId,
        tier: tool.tier,
        approved: decision.kind === "needs_approval",
        outputSha256: sha256Hex(output),
      });
      return { ok: true, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: message });
      return { ok: false, error: `${call.name} failed: ${message}` };
    }
  }
}
