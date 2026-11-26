import type Anthropic from "@anthropic-ai/sdk";
import type { AuditLog } from "../audit/log.ts";
import type { ActionProposal, ApprovalAuthority } from "../policy/approvals.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { GuardedExecutor } from "../policy/executor.ts";
import type { Tier } from "../policy/tiers.ts";
import type { TaskStore } from "../store/tasks.ts";
import type { Tool, ToolRegistry } from "../tools/types.ts";
import type { ModelClient } from "./model.ts";
import { SYSTEM_PROMPT, wrapUntrusted } from "./prompts.ts";

export type ApprovalDecision =
  | { decision: "approve" }
  | { decision: "reject"; feedback?: string };

/** A human in the loop: terminal today, iPhone/Mac approval cards with Face ID later. */
export interface Approver {
  review(proposal: ActionProposal, tool: Tool, signal?: AbortSignal): Promise<ApprovalDecision>;
}

export type AgentEvent =
  | { type: "task.started"; taskId: string }
  | { type: "assistant.text"; text: string }
  | { type: "tool.running"; tool: string; tier: Tier; summary: string }
  | { type: "tool.result"; tool: string; ok: boolean; text: string }
  | { type: "tool.blocked"; tool: string; reason: string }
  | { type: "approval.decided"; tool: string; decision: "approve" | "reject" }
  | { type: "task.finished"; status: "completed" | "failed" | "cancelled"; text: string };

export interface AgentDeps {
  model: ModelClient;
  registry: ToolRegistry;
  policy: PolicyEngine;
  authority: ApprovalAuthority;
  executor: GuardedExecutor;
  audit: AuditLog;
  tasks: TaskStore;
  approver: Approver;
  maxSteps: number;
}

export interface TaskOutcome {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
}

type ToolUse = Anthropic.Beta.BetaToolUseBlockParam;

export async function runTask(
  deps: AgentDeps,
  request: string,
  opts: { onEvent?: (e: AgentEvent) => void; signal?: AbortSignal } = {},
): Promise<TaskOutcome> {
  const emit = opts.onEvent ?? (() => {});
  const taskId = deps.tasks.create(request);
  deps.audit.append("task.received", taskId, { request, model: deps.model.name });
  emit({ type: "task.started", taskId });

  const finish = (status: TaskOutcome["status"], text: string): TaskOutcome => {
    deps.tasks.finish(taskId, status, text);
    deps.audit.append(`task.${status}`, taskId, { text });
    emit({ type: "task.finished", status, text });
    return { taskId, status, text };
  };

  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: request }];
  const tools = deps.registry.apiTools();
  let lastText = "";

  try {
    for (let step = 0; step < deps.maxSteps; step += 1) {
      if (opts.signal?.aborted) return finish("cancelled", "Stopped by the user.");

      const turn = await deps.model.next({ system: SYSTEM_PROMPT, messages, tools });
      const texts = turn.content.filter((b) => b.type === "text").map((b) => b.text);
      const toolUses = turn.content.filter((b): b is ToolUse => b.type === "tool_use");
      deps.audit.append("model.turn", taskId, {
        step,
        stopReason: turn.stopReason,
        text: texts.join("\n"),
        toolCalls: toolUses.map((t) => t.name),
      });

      if (turn.refusal) return finish("failed", turn.refusal);
      messages.push({ role: "assistant", content: turn.content });
      for (const text of texts) {
        lastText = text;
        emit({ type: "assistant.text", text });
      }

      if (turn.stopReason === "pause_turn") continue;
      if (toolUses.length === 0) return finish("completed", lastText);
      if (turn.stopReason === "max_tokens") {
        return finish("failed", "The model ran out of room mid tool call; nothing was executed.");
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const use of toolUses) {
        results.push(await handleToolUse(deps, taskId, use, emit, opts.signal));
      }
      messages.push({ role: "user", content: results });
      deps.tasks.saveTranscript(taskId, messages);
    }
    return finish("failed", `Stopped after ${deps.maxSteps} steps (safety limit).`);
  } catch (err) {
    if (opts.signal?.aborted) return finish("cancelled", "Stopped by the user.");
    const message = err instanceof Error ? err.message : String(err);
    return finish("failed", `Error: ${message}`);
  }
}

async function handleToolUse(
  deps: AgentDeps,
  taskId: string,
  use: ToolUse,
  emit: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const result = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  const call = { taskId, toolUseId: use.id, name: use.name, input: use.input };

  const decision = deps.policy.decide(use.name);
  deps.audit.append("policy.decision", taskId, { tool: use.name, toolUseId: use.id, decision });

  if (decision.kind === "block") {
    emit({ type: "tool.blocked", tool: use.name, reason: decision.reason });
    return result(`Blocked by Phoenix policy: ${decision.reason}. Do not retry; tell the user.`, true);
  }

  const tool = deps.registry.get(use.name)!;
  const parsed = tool.parse(use.input);
  if (!parsed.ok) return result(`Invalid input for ${use.name}:\n${parsed.error}`, true);

  if (decision.kind === "allow") {
    emit({ type: "tool.running", tool: use.name, tier: tool.tier, summary: tool.describe(parsed.value) });
    return toResult(await deps.executor.execute({ ...call, input: parsed.value }));
  }

  // Needs approval: freeze the exact payload, show it, and only run what was approved.
  const proposal = deps.authority.propose({
    taskId,
    toolUseId: use.id,
    tool: use.name,
    tier: tool.tier,
    input: parsed.value,
    summary: tool.describe(parsed.value),
  });
  deps.audit.append("approval.proposed", taskId, {
    proposalId: proposal.id,
    tool: proposal.tool,
    summary: proposal.summary,
    payloadHash: proposal.payloadHash,
    input: proposal.input,
  });
  deps.tasks.setStatus(taskId, "awaiting_approval");
  const verdict = await deps.approver.review(proposal, tool, signal);
  deps.tasks.setStatus(taskId, "running");

  if (verdict.decision === "reject") {
    deps.audit.append("approval.rejected", taskId, {
      proposalId: proposal.id,
      feedback: verdict.feedback ?? null,
    });
    emit({ type: "approval.decided", tool: use.name, decision: "reject" });
    const feedback = verdict.feedback
      ? ` The user's feedback: ${JSON.stringify(verdict.feedback)}`
      : " No feedback given; ask the user what they would like instead.";
    return result(`The user declined this action, so it was not executed.${feedback}`);
  }

  const token = deps.authority.issue(proposal);
  deps.audit.append("approval.granted", taskId, {
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    expiresAt: token.expiresAt,
  });
  emit({ type: "approval.decided", tool: use.name, decision: "approve" });
  emit({ type: "tool.running", tool: use.name, tier: tool.tier, summary: proposal.summary });
  return toResult(await deps.executor.execute({ ...call, input: proposal.input }, token));

  function toResult(exec: Awaited<ReturnType<GuardedExecutor["execute"]>>) {
    if (!exec.ok) {
      emit({ type: "tool.result", tool: use.name, ok: false, text: exec.error });
      return result(exec.error, true);
    }
    emit({ type: "tool.result", tool: use.name, ok: true, text: exec.output });
    return result(tool.untrustedOutput ? wrapUntrusted(use.name, exec.output) : exec.output);
  }
}
