import Anthropic from "@anthropic-ai/sdk";
import type { AuditLog } from "../audit/log.ts";
import type { ActionProposal, ApprovalAuthority } from "../policy/approvals.ts";
import type { PolicyEngine } from "../policy/engine.ts";
import type { GuardedExecutor } from "../policy/executor.ts";
import { Tier } from "../policy/tiers.ts";
import type { TaskStore } from "../store/tasks.ts";
import type { Tool, ToolRegistry, ToolSession } from "../tools/types.ts";
import { StreamRevealer, type PrivacyVault } from "../privacy/vault.ts";
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
  | { type: "assistant.delta"; text: string }
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
  /** Privacy Shield: protected values are placeholders everywhere except on the user's screen. */
  vault: PrivacyVault;
}

export interface TaskOutcome {
  taskId: string;
  status: "completed" | "failed" | "cancelled";
  text: string;
  /** Full conversation after this task (prior history + this exchange), always valid to resend. */
  messages: Anthropic.Beta.BetaMessageParam[];
}

export interface RunOptions {
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Earlier turns of the same conversation. Never modified; only appended to. */
  history?: Anthropic.Beta.BetaMessageParam[];
  /** Per-turn <context> block placed before the request in the user's message. */
  context?: string;
  /** Only read-only tools may run (automatic briefings never change anything). */
  readOnly?: boolean;
}

type ToolUse = Anthropic.Beta.BetaToolUseBlockParam;

export async function runTask(
  deps: AgentDeps,
  request: string,
  opts: RunOptions = {},
): Promise<TaskOutcome> {
  // `request` and `context` arrive already protected (placeholders instead of sensitive values).
  // Everything shown to the user on this Mac is revealed; everything sent to the model is not.
  const vault = deps.vault;
  const show = opts.onEvent ?? (() => {});
  const emit = (e: AgentEvent): void => show(revealEvent(vault, e));
  const taskId = deps.tasks.create(request);
  deps.audit.append("task.received", taskId, { request, model: deps.model.name });
  emit({ type: "task.started", taskId });

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    ...(opts.history ?? []),
    { role: "user", content: opts.context ? `${opts.context}\n\n${request}` : request },
  ];

  const finish = (status: TaskOutcome["status"], text: string): TaskOutcome => {
    closeOpenToolCalls(messages);
    deps.tasks.finish(taskId, status, text);
    deps.audit.append(`task.${status}`, taskId, { text });
    emit({ type: "task.finished", status, text });
    return { taskId, status, text: vault.reveal(text), messages };
  };

  const tools = deps.registry.apiTools();
  const revealer = new StreamRevealer((t) => vault.reveal(t));
  const onText = (delta: string) => {
    const ready = revealer.push(delta);
    if (ready) show({ type: "assistant.delta", text: ready });
  };
  let lastText = "";

  try {
    for (let step = 0; step < deps.maxSteps; step += 1) {
      if (opts.signal?.aborted) return finish("cancelled", "Stopped by the user.");

      const turn = await deps.model.next({ system: SYSTEM_PROMPT, messages, tools, onText });
      const tail = revealer.flush();
      if (tail) show({ type: "assistant.delta", text: tail });
      const texts = turn.content.filter((b) => b.type === "text").map((b) => b.text);
      const toolUses = turn.content.filter((b): b is ToolUse => b.type === "tool_use");
      deps.audit.append("model.turn", taskId, {
        step,
        stopReason: turn.stopReason,
        text: texts.join("\n"),
        toolCalls: toolUses.map((t) => t.name),
        serverTools: turn.content
          .filter((b) => b.type === "server_tool_use")
          .map((b) => (b as { name: string }).name),
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
        const tier = deps.registry.get(use.name)?.tier;
        if (opts.readOnly && tier !== undefined && tier > Tier.Read) {
          results.push({ type: "tool_result", tool_use_id: use.id, is_error: true,
            content: "Not allowed here: this is a read-only briefing. Don't change anything." });
          continue;
        }
        results.push(await handleToolUse(deps, taskId, use, emit, opts.signal));
      }
      messages.push({ role: "user", content: results });
      deps.tasks.saveTranscript(taskId, messages);
    }
    return finish("failed", `Stopped after ${deps.maxSteps} steps (safety limit).`);
  } catch (err) {
    if (opts.signal?.aborted) return finish("cancelled", "Stopped by the user.");
    return finish("failed", vault.protect(explainFailure(err)).text);
  }
}

/** A failure message the user can act on (shown in the terminal and the Summon Bar). */
function explainFailure(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return "Anthropic rejected the API key (it may have expired or been revoked). Replace it with: npm run phoenix -- key set, then restart Phoenix.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude's rate limit was hit. Try again in a minute.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * If the conversation ends on an assistant turn with tool calls that never got results
 * (task stopped mid-way), append "not executed" results so the history stays valid
 * for the next request. This only ever appends.
 */
function closeOpenToolCalls(messages: Anthropic.Beta.BetaMessageParam[]): void {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || typeof last.content === "string" || !last.content) return;
  const open = last.content.filter((b): b is ToolUse => b.type === "tool_use");
  if (open.length === 0) return;
  messages.push({
    role: "user",
    content: open.map((t) => ({
      type: "tool_result" as const,
      tool_use_id: t.id,
      content: "Not executed: the task was stopped.",
      is_error: true,
    })),
  });
}

async function handleToolUse(
  deps: AgentDeps,
  taskId: string,
  use: ToolUse,
  emit: (e: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const vault = deps.vault;
  const result = (content: string, isError = false): Anthropic.Beta.BetaToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: use.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });
  // The model only ever sees placeholders, but protect its input anyway in case it produced a
  // sensitive value on its own. This protected form is the payload that gets approved and run.
  const input = vault.protectDeep(use.input);
  const call = { taskId, toolUseId: use.id, name: use.name, input };

  // Long tools (screen control) can ask the user part-way through, through the same approval path.
  const session: ToolSession = {
    signal,
    screenModel: deps.model.screen ? () => deps.model.screen!() : undefined,
    confirm: async (summary, kinds = []) => {
      const step = deps.authority.propose({
        taskId, toolUseId: use.id, tool: use.name, tier: Tier.Act,
        input: { step: vault.protect(summary).text }, summary: vault.reveal(summary), protectedKinds: kinds,
      });
      deps.audit.append("approval.proposed", taskId, {
        proposalId: step.id, tool: use.name, summary: vault.protect(summary).text, payloadHash: step.payloadHash, protectedKinds: kinds,
      });
      deps.tasks.setStatus(taskId, "awaiting_approval");
      try {
        for (const p of kinds.length ? [step, deps.authority.confirmAgain(step)] : [step]) {
          const d = await deps.approver.review(p, deps.registry.get(use.name)!, signal);
          if (d.decision === "reject") {
            deps.audit.append("approval.rejected", taskId, { proposalId: step.id, stage: p.stage, feedback: d.feedback ?? null });
            emit({ type: "approval.decided", tool: use.name, decision: "reject" });
            return false;
          }
        }
      } finally {
        deps.tasks.setStatus(taskId, "running");
      }
      deps.audit.append("approval.granted", taskId, { proposalId: step.id, confirmations: kinds.length ? 2 : 1 });
      emit({ type: "approval.decided", tool: use.name, decision: "approve" });
      return true;
    },
  };

  const decision = deps.policy.decide(use.name);
  deps.audit.append("policy.decision", taskId, { tool: use.name, toolUseId: use.id, decision });

  if (decision.kind === "block") {
    emit({ type: "tool.blocked", tool: use.name, reason: decision.reason });
    return result(`Blocked by Phoenix policy: ${decision.reason}. Do not retry; tell the user.`, true);
  }

  const tool = deps.registry.get(use.name)!;
  const parsed = tool.parse(vault.revealDeep(input));
  if (!parsed.ok) return result(vault.protect(`Invalid input for ${use.name}:\n${parsed.error}`).text, true);
  const summary = tool.describe(parsed.value); // real values: shown only on this Mac
  // Protected data about to leave the Mac → the user must approve, then confirm again.
  const protectedKinds = tool.leavesDevice ? vault.kindsIn(input) : [];
  const confirmTwice = protectedKinds.length > 0;

  if (decision.kind === "allow" && !confirmTwice) {
    emit({ type: "tool.running", tool: use.name, tier: tool.tier, summary });
    return toResult(await deps.executor.execute(call, undefined, session));
  }

  // Needs approval: freeze the exact payload, show it, and only run what was approved.
  const proposal = deps.authority.propose({
    taskId,
    toolUseId: use.id,
    tool: use.name,
    tier: tool.tier,
    input,
    summary,
    display: parsed.value,
    protectedKinds,
  });
  deps.audit.append("approval.proposed", taskId, {
    proposalId: proposal.id,
    tool: proposal.tool,
    summary: vault.protect(summary).text,
    payloadHash: proposal.payloadHash,
    input: proposal.input,
    protectedKinds,
  });

  const declined = (stage: 1 | 2, feedback?: string) => {
    deps.audit.append("approval.rejected", taskId, { proposalId: proposal.id, stage, feedback: feedback ?? null });
    emit({ type: "approval.decided", tool: use.name, decision: "reject" });
    const note = feedback
      ? ` The user's feedback: ${JSON.stringify(vault.protect(feedback).text)}`
      : stage === 2
        ? " They chose not to share the protected details. Don't retry unless they ask."
        : " No feedback given; ask the user what they would like instead.";
    return result(`The user declined this action, so it was not executed.${note}`);
  };

  deps.tasks.setStatus(taskId, "awaiting_approval");
  const first = await deps.approver.review(proposal, tool, signal);
  if (first.decision === "reject") {
    deps.tasks.setStatus(taskId, "running");
    return declined(1, first.feedback);
  }
  if (confirmTwice) {
    deps.audit.append("approval.granted", taskId, { proposalId: proposal.id, stage: 1 });
    const second = await deps.approver.review(deps.authority.confirmAgain(proposal), tool, signal);
    if (second.decision === "reject") {
      deps.tasks.setStatus(taskId, "running");
      return declined(2, second.feedback);
    }
  }
  deps.tasks.setStatus(taskId, "running");

  const token = deps.authority.issue(proposal, confirmTwice ? 2 : 1);
  deps.audit.append("approval.granted", taskId, {
    proposalId: proposal.id,
    payloadHash: proposal.payloadHash,
    confirmations: token.confirmations,
    expiresAt: token.expiresAt,
  });
  emit({ type: "approval.decided", tool: use.name, decision: "approve" });
  emit({ type: "tool.running", tool: use.name, tier: tool.tier, summary });
  return toResult(await deps.executor.execute({ ...call, input: proposal.input }, token, session));

  function toResult(exec: Awaited<ReturnType<GuardedExecutor["execute"]>>) {
    if (!exec.ok) {
      emit({ type: "tool.result", tool: use.name, ok: false, text: exec.error });
      return result(exec.error, true);
    }
    emit({ type: "tool.result", tool: use.name, ok: true, text: exec.output });
    return result(tool.untrustedOutput ? wrapUntrusted(use.name, exec.output) : exec.output);
  }
}

/** Fill protected values back in for display on this Mac. */
function revealEvent(vault: PrivacyVault, e: AgentEvent): AgentEvent {
  switch (e.type) {
    case "assistant.delta":
    case "assistant.text":
    case "tool.result":
      return { ...e, text: vault.reveal(e.text) };
    case "task.finished":
      return { ...e, text: vault.reveal(e.text) };
    case "tool.running":
      return { ...e, summary: vault.reveal(e.summary) };
    case "tool.blocked":
      return { ...e, reason: vault.reveal(e.reason) };
    default:
      return e;
  }
}
