#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline";
import type { AgentEvent } from "../agent/loop.ts";
import { ClaudeModel, type ModelClient } from "../agent/model.ts";
import { ScriptedModel, demoScript } from "../agent/scripted.ts";
import { loadConfig } from "../config.ts";
import { createPhoenix, type Phoenix } from "../phoenix.ts";
import { TIER_LABEL } from "../policy/tiers.ts";
import { LineQueue, TerminalApprover } from "./approver.ts";
import { checkApiKey } from "./keycheck.ts";
import { c } from "./style.ts";

const HELP = `
${c.ember("Phoenix")} — Phase 0 CLI

  phoenix "<request>"            Run a task with Claude (needs ANTHROPIC_API_KEY)
  phoenix --offline "<request>"  Run the scripted offline demo (no API key needed)
  phoenix audit [--limit N]      Show recent audit log entries (decrypted)
  phoenix audit verify           Check the audit log's hash chain
  phoenix help                   Show this help

Data lives in $PHOENIX_HOME (default: ~/Library/Application Support/Phoenix).
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const phoenix = createPhoenix(loadConfig());
  try {
    if (command === "audit") return showAudit(phoenix, rest);
    const offline = argv.includes("--offline");
    const request = argv.filter((a) => a !== "--offline").join(" ").trim();
    if (!request) {
      process.stdout.write(HELP);
      return 2;
    }
    return await runRequest(phoenix, request, offline);
  } finally {
    phoenix.close();
  }
}

async function runRequest(phoenix: Phoenix, request: string, offline: boolean): Promise<number> {
  const keyProblem = offline ? null : checkApiKey(process.env.ANTHROPIC_API_KEY);
  if (keyProblem) {
    process.stderr.write(`\n  ${c.red("✗")} ${keyProblem}\n\n`);
    return 2;
  }
  const model: ModelClient = offline ? new ScriptedModel(demoScript(request)) : new ClaudeModel();
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const input = new LineQueue(rl);
  const controller = new AbortController();
  const stop = () => {
    if (!controller.signal.aborted) {
      process.stdout.write(`\n  ${c.red("■ Stopping Phoenix…")}\n`);
      controller.abort();
    }
  };
  rl.on("SIGINT", stop);
  process.on("SIGINT", stop);

  process.stdout.write(`\n  ${c.dim("YOU")}\n  ${c.italic(request)}\n`);
  if (offline) process.stdout.write(`  ${c.dim("(offline demo: scripted model, no data leaves this Mac)")}\n`);

  try {
    const outcome = await phoenix.run(
      request,
      { model, approver: new TerminalApprover(input) },
      { onEvent: render, signal: controller.signal },
    );
    if (outcome.status === "failed" && !offline && !process.env.ANTHROPIC_API_KEY) {
      process.stdout.write(
        `\n  ${c.amber("Tip:")} no ANTHROPIC_API_KEY is set. Export one, or try: phoenix --offline "${request}"\n`,
      );
    }
    process.stdout.write(`\n  ${c.dim(`task ${outcome.taskId} · ${outcome.status}`)}\n\n`);
    return outcome.status === "completed" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\n  ${c.red(describeError(err))}\n\n`);
    return 1;
  } finally {
    rl.close();
  }
}

function render(e: AgentEvent): void {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  switch (e.type) {
    case "assistant.text":
      out(`\n  ${c.ember("PHOENIX")}\n  ${e.text.split("\n").join("\n  ")}`);
      break;
    case "tool.running":
      out(`  ${c.dim("⟳")} ${e.summary} ${c.dim(`· ${TIER_LABEL[e.tier]}`)}`);
      break;
    case "tool.result":
      out(e.ok ? `  ${c.green("✓")} ${c.dim(firstLine(e.text))}` : `  ${c.red("✗")} ${firstLine(e.text)}`);
      break;
    case "tool.blocked":
      out(`  ${c.red("⛔ blocked")} ${e.tool}: ${e.reason}`);
      break;
    case "approval.decided":
      out(e.decision === "approve" ? `  ${c.green("✓ approved")}` : `  ${c.amber("✗ not approved")}`);
      break;
    case "task.finished":
      if (e.status !== "completed") out(`\n  ${c.red(e.status.toUpperCase())} ${e.text}`);
      break;
  }
}

function showAudit(phoenix: Phoenix, args: string[]): number {
  if (args[0] === "verify") {
    const report = phoenix.audit.verify();
    if (report.ok) {
      process.stdout.write(`  ${c.green("✓")} Audit log intact (${report.count} entries)\n`);
      return 0;
    }
    process.stdout.write(
      `  ${c.red("✗")} Audit log BROKEN at entry #${report.brokenAt}: ${report.reason}\n`,
    );
    return 1;
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 50 : 50;
  for (const e of phoenix.audit.list({ limit })) {
    const time = new Date(e.ts).toLocaleTimeString();
    process.stdout.write(
      `  ${c.dim(`#${e.seq} ${time}`)} ${c.amber(e.type.padEnd(20))} ${c.dim(e.taskId?.slice(0, 8) ?? "-")} ${JSON.stringify(e.data)}\n`,
    );
  }
  return 0;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return "Claude API key missing or invalid. Set ANTHROPIC_API_KEY, or try --offline.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit; try again shortly.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  if (err instanceof Error && /api key|apiKey|authentication/i.test(err.message)) {
    return "No Claude credentials found. Set ANTHROPIC_API_KEY, or try --offline.";
  }
  return err instanceof Error ? err.message : String(err);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${describeError(err)}\n`);
    process.exit(1);
  },
);
