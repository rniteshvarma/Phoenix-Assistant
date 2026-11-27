import type { ToolRegistry } from "../tools/types.ts";
import { requiresApproval, type Tier } from "./tiers.ts";

export type Decision =
  | { kind: "allow"; tier: Tier }
  | { kind: "needs_approval"; tier: Tier; reason: string }
  | { kind: "block"; reason: string };

/**
 * Tools the agent may never run, whatever it is told. Changing these needs the
 * user acting directly in Settings (later phases), never the model.
 */
export const ALWAYS_BLOCKED = new Set([
  "vault_export",
  "audit_disable",
  "policy_change",
  "settings_security_change",
]);

/**
 * Deterministic gate in front of every tool call. It is plain code on purpose:
 * no prompt, email or web page can talk it out of a decision.
 */
export class PolicyEngine {
  #registry: ToolRegistry;
  #isOff: (tool: string) => boolean;

  /** `isOff`: tools whose connector the user switched off in the Control Center. */
  constructor(registry: ToolRegistry, isOff: (tool: string) => boolean = () => false) {
    this.#registry = registry;
    this.#isOff = isOff;
  }

  decide(toolName: string): Decision {
    if (ALWAYS_BLOCKED.has(toolName)) {
      return { kind: "block", reason: `"${toolName}" can never be run by Phoenix` };
    }
    if (this.#isOff(toolName)) {
      return { kind: "block", reason: `"${toolName}" is switched off in the Control Center` };
    }
    const tool = this.#registry.get(toolName);
    if (!tool) {
      return { kind: "block", reason: `"${toolName}" is not an allowed tool` };
    }
    if (requiresApproval(tool.tier)) {
      return { kind: "needs_approval", tier: tool.tier, reason: "outward-facing or irreversible" };
    }
    return { kind: "allow", tier: tool.tier };
  }
}
