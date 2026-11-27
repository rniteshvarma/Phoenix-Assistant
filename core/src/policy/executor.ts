import type { AuditLog } from "../audit/log.ts";
import type { PhoenixConfig } from "../config.ts";
import { sha256Hex } from "../security/canonical.ts";
import type { ToolRegistry, ToolServices, ToolSession } from "../tools/types.ts";
import type { ApprovalAuthority, ApprovalToken } from "./approvals.ts";
import type { PrivacyVault } from "../privacy/vault.ts";
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
  #vault: PrivacyVault;

  constructor(deps: {
    registry: ToolRegistry;
    policy: PolicyEngine;
    authority: ApprovalAuthority;
    audit: AuditLog;
    cfg: PhoenixConfig;
    services: ToolServices;
    vault: PrivacyVault;
  }) {
    this.#registry = deps.registry;
    this.#policy = deps.policy;
    this.#authority = deps.authority;
    this.#audit = deps.audit;
    this.#cfg = deps.cfg;
    this.#services = deps.services;
    this.#vault = deps.vault;
  }

  /**
   * Run one tool call. Inputs arrive with protected values as placeholders; they are filled in
   * here, on this Mac, just before the tool runs, and the output is protected again before it
   * goes back to the model. Protected values may only leave the Mac with a twice-confirmed approval.
   */
  async execute(call: ToolCall, token?: ApprovalToken, session?: ToolSession): Promise<ExecResult> {
    const vault = this.#vault;
    const fail = (error: string): ExecResult => ({ ok: false, error: vault.protect(error).text });

    const decision = this.#policy.decide(call.name);
    if (decision.kind === "block") {
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: decision.reason });
      return fail(`Blocked by Phoenix policy: ${decision.reason}.`);
    }
    const tool = this.#registry.get(call.name)!;
    const protectedKinds = tool.leavesDevice ? vault.kindsIn(call.input) : [];
    const needsTwo = protectedKinds.length > 0;

    if (decision.kind === "needs_approval" || needsTwo) {
      const verdict = token
        ? this.#authority.verify(
            token,
            { tool: call.name, taskId: call.taskId, input: call.input },
            { minConfirmations: needsTwo ? 2 : 1 },
          )
        : ({ ok: false, reason: needsTwo ? "protected data needs the user to confirm twice" : "no approval token" } as const);
      if (!verdict.ok) {
        this.#audit.append("tool.token_rejected", call.taskId, {
          tool: call.name,
          toolUseId: call.toolUseId,
          reason: verdict.reason,
          protectedKinds,
        });
        return fail(`Not executed: ${verdict.reason}.`);
      }
    }

    const parsed = tool.parse(vault.revealDeep(call.input));
    if (!parsed.ok) {
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: "invalid input" });
      return fail(`Invalid input for ${call.name}:\n${parsed.error}`);
    }

    try {
      const output = await tool.run(parsed.value, {
        ...this.#services,
        cfg: this.#cfg,
        taskId: call.taskId,
        session,
      });
      const safe = vault.protect(output).text;
      // Learn how the user writes from messages they approved (stored as placeholders, on this Mac).
      const approved = decision.kind === "needs_approval" || needsTwo;
      const sample = approved ? tool.styleSample?.(parsed.value) : null;
      if (sample && sample.text.trim()) {
        try {
          this.#services.memory.addStyleSample(vault.protect(sample.subject).text, vault.protect(sample.text.slice(0, 600)).text);
        } catch {
          // memory full: not worth failing the action over
        }
      }
      this.#audit.append("tool.executed", call.taskId, {
        tool: call.name,
        toolUseId: call.toolUseId,
        tier: tool.tier,
        approved: decision.kind === "needs_approval" || needsTwo,
        protectedKindsSent: protectedKinds,
        outputSha256: sha256Hex(safe),
      });
      return { ok: true, output: safe };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.#audit.append("tool.failed", call.taskId, { tool: call.name, reason: vault.protect(message).text });
      return fail(`${call.name} failed: ${message}`);
    }
  }
}
