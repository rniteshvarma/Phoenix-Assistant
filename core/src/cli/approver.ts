import type { Interface as ReadlineInterface } from "node:readline";
import type { ApprovalDecision, Approver } from "../agent/loop.ts";
import type { ActionProposal } from "../policy/approvals.ts";
import { TIER_LABEL } from "../policy/tiers.ts";
import { KIND_LABEL, type Kind } from "../privacy/detect.ts";
import type { Tool } from "../tools/types.ts";
import { c } from "./style.ts";

/**
 * Buffers input lines as they arrive. readline emits piped lines immediately, so
 * prompting with rl.question() would lose answers typed (or piped) ahead of time.
 */
export class LineQueue {
  #lines: string[] = [];
  #waiters: Array<(line: string | null) => void> = [];
  #closed = false;

  constructor(rl: ReadlineInterface) {
    rl.on("line", (line) => {
      const waiter = this.#waiters.shift();
      if (waiter) waiter(line);
      else this.#lines.push(line);
    });
    rl.on("close", () => {
      this.#closed = true;
      for (const waiter of this.#waiters.splice(0)) waiter(null);
    });
  }

  /** Next line, or null when input has ended or the signal fired. */
  next(signal?: AbortSignal): Promise<string | null> {
    const buffered = this.#lines.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.#closed || signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (line: string | null) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(line);
      };
      const onAbort = () => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        resolve(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiters.push(waiter);
    });
  }
}

/**
 * Phase 0 approval card in the terminal. Phase 3 replaces this with an iPhone/Mac
 * card confirmed by Face ID; the contract (approve one exact payload) stays the same.
 */
export class TerminalApprover implements Approver {
  #input: LineQueue;

  constructor(input: LineQueue) {
    this.#input = input;
  }

  async review(proposal: ActionProposal, _tool: Tool, signal?: AbortSignal): Promise<ApprovalDecision> {
    const line = c.amber("─".repeat(64));
    const kinds = proposal.protectedKinds.map((k) => KIND_LABEL[k as Kind] ?? k);

    if (proposal.stage === 2) {
      process.stdout.write(
        [
          "",
          `  ${c.red("━".repeat(64))}`,
          `  ${c.red("◆ ARE YOU SURE?")}   ${c.dim("second confirmation")}`,
          `  ${c.red("━".repeat(64))}`,
          `  This sends your ${c.bold(kinds.join(", "))} off this Mac:`,
          `  ${c.bold(proposal.summary)}`,
          `  ${c.red("━".repeat(64))}`,
          "",
        ].join("\n"),
      );
      for (;;) {
        const answer = await this.#ask(`  ${c.red("[y]")}es, I'm sure   ${c.amber("[n]")}o › `, signal);
        if (answer === null) return { decision: "reject" };
        const choice = answer.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
        if (choice === "y" || choice === "yes") return { decision: "approve" };
        if (choice === "n" || choice === "no") return { decision: "reject" };
      }
    }

    const payload = JSON.stringify(proposal.display, null, 2)
      .split("\n")
      .map((l) => `  ${c.dim("│")} ${l}`)
      .join("\n");

    process.stdout.write(
      [
        "",
        `  ${line}`,
        `  ${c.amber("◆ NEEDS YOUR OK")}   ${c.dim(TIER_LABEL[proposal.tier])}`,
        `  ${line}`,
        `  ${c.bold(proposal.summary)}`,
        ...(kinds.length > 0 ? [`  ${c.red("🔒 Contains protected data:")} ${kinds.join(", ")} ${c.dim("(you'll be asked twice)")}`] : []),
        "",
        payload,
        "",
        `  ${c.dim(`tool ${proposal.tool} · payload ${proposal.payloadHash.slice(0, 12)}…`)}`,
        `  ${line}`,
        "",
      ].join("\n"),
    );

    for (;;) {
      const answer = await this.#ask(
        `  ${c.amber("[a]")}pprove  ${c.amber("[r]")}eject  ${c.amber("[c]")}hange… › `,
        signal,
      );
      if (answer === null) return { decision: "reject" };
      const choice = answer.trim().toLowerCase().replace(/^\[(.*)\]$/, "$1");
      if (choice === "a" || choice === "approve") return { decision: "approve" };
      if (choice === "r" || choice === "reject") return { decision: "reject" };
      if (choice === "c" || choice === "change") {
        const feedback = await this.#ask("  What should Phoenix change? › ", signal);
        if (feedback === null) return { decision: "reject" };
        return { decision: "reject", feedback: feedback.trim() || undefined };
      }
    }
  }

  /** Echoes the answer when input isn't a terminal, so transcripts show what was chosen. */
  async #ask(prompt: string, signal?: AbortSignal): Promise<string | null> {
    process.stdout.write(prompt);
    const answer = await this.#input.next(signal);
    if (!process.stdin.isTTY) process.stdout.write(`${answer ?? "(no input)"}\n`);
    return answer;
  }
}
