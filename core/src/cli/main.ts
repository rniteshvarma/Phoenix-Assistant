#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import readline from "node:readline";
import type { AgentEvent } from "../agent/loop.ts";
import { ClaudeModel, type ModelClient } from "../agent/model.ts";
import { ScriptedModel, demoScript } from "../agent/scripted.ts";
import { loadConfig } from "../config.ts";
import { startGateway } from "../gateway/server.ts";
import { gatewayTokenPath, loadOrCreateGatewayToken } from "../gateway/token.ts";
import { createPhoenix, type Phoenix } from "../phoenix.ts";
import { TIER_LABEL } from "../policy/tiers.ts";
import { KokoroSpeech } from "../voice/kokoro.ts";
import { speechFromEnvironment } from "../voice/tts.ts";
import { LineQueue, TerminalApprover } from "./approver.ts";
import { SECRETS, describeKey, findSecret, removeSecret, storeSecretInteractively, type SecretName } from "../security/secrets.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KIND_LABEL } from "../privacy/detect.ts";
import { scanDocument } from "../privacy/documents.ts";
import { ProactiveScheduler } from "../proactive/scheduler.ts";
import { backupCommand } from "./backupCommand.ts";
import { McpHub } from "../mcp/hub.ts";
import { CASES, runInjectionEval } from "../evals/injection.ts";
import { cacheHitRate } from "../store/usage.ts";
import { backupDue, backupSettings, createBackup, updateBackupSettings } from "../backup/backup.ts";
import { loadMasterKey } from "../security/keys.ts";
import { sensitiveReason, type MemoryItem } from "../store/memory.ts";
import { NEVER_APPS } from "../screen/session.ts";
import { allowedScreenApps } from "../tools/screen.ts";
import { minutesOf } from "../proactive/schedule.ts";
import {
  APP_LABEL, APP_PATH, CORE_LABEL, CORE_LOG, agentStatus, appAgent, coreAgent, coreResponds, installAgent,
  removeAgent, restartCore, tailLog,
} from "./autostart.ts";
import { checkApiKey } from "./keycheck.ts";
import { c } from "./style.ts";

const HELP = `
${c.ember("Phoenix")} — CLI

  phoenix "<request>"            One request with Claude
  phoenix chat                   Ongoing conversation in the terminal (/new = fresh topic)
  phoenix serve                  Run the Phoenix core for the Mac app (local gateway)
  phoenix proactive              Morning briefing & nudges: show settings
  phoenix proactive on|off       Turn proactive Phoenix on or off
  phoenix proactive brief HH:MM [daily|weekdays]   Set the morning briefing time
  phoenix proactive quiet HH:MM-HH:MM               Set quiet hours (no nudges)
  phoenix proactive lead <minutes>                  Nudge this long before meetings
  phoenix usage                  Tokens and estimated cost, last 7 days
  phoenix eval injection         Test against hidden instructions (real model, sandboxed; uses API credits)
  phoenix backup                 Encrypted backups: status
  phoenix backup setup           Choose a passphrase and make the first backup
  phoenix backup now             Back up right now
  phoenix backup restore <file>  Restore from a backup (asks for the passphrase)
  phoenix screen                 Apps Phoenix may operate on screen (and the ones it never will)
  phoenix screen allow "App"     Let Phoenix operate this app (it still asks before starting)
  phoenix screen deny "App"      Take an app off the list
  phoenix autostart on           Start the core (and Mac app) automatically when you log in
  phoenix autostart off          Stop starting automatically
  phoenix autostart [status]     Is the core running? Recent log lines
  phoenix autostart restart      Restart the background core (e.g. after replacing your key)
  phoenix scan <file>            Check a document/image on this Mac: is it confidential, what may be shared
  phoenix memory                 Show what Phoenix remembers about you (profile, people, style…)
  phoenix memory profile "…"     Add to your profile (who you are; sent with every request)
  phoenix memory person "Name" "…"  Add something about a person (nicknames: "Mom (Amma)")
  phoenix memory add|style "…"   Add a fact, or a note on how you write
  phoenix memory import <file>   Load many memories from a JSON file
  phoenix memory forget <n>      Delete remembered item #n
  phoenix audit [--limit N]      Show recent audit log entries (decrypted)
  phoenix audit verify           Check the audit log's hash chain
  phoenix key set [elevenlabs]   Save or replace an API key in your Mac's Keychain (asked once)
  phoenix key [status]           Show which key is in use and check that it still works
  phoenix key remove             Delete the saved key
  phoenix help                   Show this help

  Add --offline to request, chat or serve to use the scripted demo model (no API key, nothing leaves this Mac).
  Data lives in $PHOENIX_HOME (default: ~/Library/Application Support/Phoenix).
`;

async function main(argv: string[]): Promise<number> {
  const offline = argv.includes("--offline");
  const args = argv.filter((a) => a !== "--offline");
  const [command, ...rest] = args;
  if (!command && !offline) {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const phoenix = createPhoenix(loadConfig());
  try {
    switch (command) {
      case "audit":
        return showAudit(phoenix, rest);
      case "memory":
        return showMemory(phoenix, rest);
      case "serve":
        return await serve(phoenix, offline);
      case "chat":
        return await chat(phoenix, offline);
      case "key":
        return await keyCommand(rest);
      case "autostart":
        return await autostartCommand(rest);
      case "scan":
        return await scanCommand(phoenix, rest);
      case "proactive":
        return proactiveCommand(phoenix, rest);
      case "screen":
        return screenCommand(phoenix, rest);
      case "backup":
        return await backupCommand(phoenix, rest);
      case "eval":
        return await evalCommand(rest);
      case "usage":
        return usageCommand(phoenix);
      default: {
        const request = args.join(" ").trim();
        if (!request) {
          process.stdout.write(HELP);
          return 2;
        }
        return await oneShot(phoenix, request, offline);
      }
    }
  } finally {
    phoenix.close();
  }
}

/** Returns a model factory, or prints why Claude can't be used and returns null. */
/** Makes the model for a request; simple read-only jobs (briefings) can ask for low effort. */
type ModelFactory = (request: string, opts?: { effort?: "low" | "medium" | "high" }) => ModelClient;

function modelFactory(offline: boolean, opts: { quiet?: boolean } = {}): ModelFactory | null {
  if (offline) return (request) => new ScriptedModel(demoScript(request));
  const s = SECRETS.anthropic;
  const key = findSecret(s.env, s.service);
  if (opts.quiet) return key && !checkApiKey(key.value) ? ((client): ModelFactory => (_r, o) => new ClaudeModel(client, o))(new Anthropic({ apiKey: key.value })) : null;
  if (!key) {
    process.stderr.write(
      [
        "",
        `  ${c.red("✗")} No Anthropic API key saved yet, so Phoenix can't reach Claude.`,
        `    Save it once in your Mac's Keychain (typing is hidden): ${c.amber("npm run phoenix -- key set")}`,
        `    Or add --offline to try the scripted demo.`,
        "",
      ].join("\n") + "\n",
    );
    return null;
  }
  const keyProblem = checkApiKey(key.value);
  if (keyProblem) {
    const where = key.source === "keychain" ? "saved in your Keychain" : "in ANTHROPIC_API_KEY";
    process.stderr.write(
      `\n  ${c.red("✗")} The key ${where} looks wrong: ${keyProblem}\n    Replace it with: ${c.amber("npm run phoenix -- key set")}\n\n`,
    );
    return null;
  }
  const client = new Anthropic({ apiKey: key.value });
  return (_r, o) => new ClaudeModel(client, o);
}

/** `phoenix key …` — keep API keys in the macOS Keychain instead of the terminal. */
async function keyCommand(args: string[]): Promise<number> {
  const [action = "status", which = "anthropic"] = args;
  if (!(which in SECRETS)) {
    process.stderr.write(`  Unknown key "${which}". Use: anthropic or elevenlabs\n`);
    return 2;
  }
  const name = which as SecretName;
  const s = SECRETS[name];

  if (action === "set") {
    process.stdout.write(
      [
        "",
        `  Saving your ${name === "anthropic" ? "Anthropic" : "ElevenLabs"} API key to the macOS Keychain.`,
        `  Paste it when asked, press Return, then paste it again to confirm. ${c.dim("(Nothing shows while you type.)")}`,
        "",
      ].join("\n") + "\n",
    );
    try {
      storeSecretInteractively(name);
    } catch {
      process.stderr.write(`\n  ${c.red("✗")} Not saved (the two entries may not have matched). Try again.\n`);
      return 1;
    }
    const saved = findSecret("__PHOENIX_IGNORE_ENV__", s.service);
    if (!saved) {
      process.stderr.write(`  ${c.red("✗")} Couldn't read the key back from the Keychain.\n`);
      return 1;
    }
    const problem = name === "anthropic" ? checkApiKey(saved.value) : null;
    process.stdout.write(`\n  ${c.green("✓")} Saved ${describeKey(saved.value)}\n`);
    if (problem) process.stdout.write(`  ${c.amber("!")} ${problem}\n`);
    if (process.env[s.env]) {
      process.stdout.write(
        `  ${c.amber("!")} ${s.env} is also set in this terminal and takes priority. Run ${c.amber(`unset ${s.env}`)} to use the saved key.\n`,
      );
    }
    if (name === "anthropic") return verifyAnthropic(saved.value);
    return 0;
  }

  if (action === "remove") {
    const removed = removeSecret(name);
    process.stdout.write(removed ? `  ${c.green("✓")} Removed the saved ${name} key.\n` : `  No saved ${name} key.\n`);
    return 0;
  }

  if (action === "status") {
    const found = findSecret(s.env, s.service);
    if (!found) {
      process.stdout.write(`  ${c.amber("–")} No ${name} key. Save one with: ${c.amber(`npm run phoenix -- key set${name === "anthropic" ? "" : ` ${name}`}`)}\n`);
      return 1;
    }
    process.stdout.write(
      `  ${c.green("✓")} ${name} key ${describeKey(found.value)} from ${found.source === "keychain" ? "your Keychain" : `${s.env} in this terminal`}\n`,
    );
    return name === "anthropic" ? verifyAnthropic(found.value) : 0;
  }

  process.stderr.write("  Usage: phoenix key [status|set|remove] [anthropic|elevenlabs]\n");
  return 2;
}

/** Load many memories at once: [{ "kind": "profile", "text": "…" }, { "kind": "project", "subject": "…", "text": "…" }]. */
export function importMemories(phoenix: Phoenix, data: unknown): { added: number; skipped: string[] } {
  if (!Array.isArray(data)) throw new Error("the file must be a JSON list of { kind, subject?, text }");
  const kinds = new Set(["profile", "person", "project", "fact", "style", "local"]);
  const skipped: string[] = [];
  let added = 0;
  for (const [i, raw] of data.entries()) {
    const item = raw as { kind?: string; subject?: string; text?: string };
    const label = `item ${i + 1}`;
    if (!item || typeof item.text !== "string" || !item.text.trim()) { skipped.push(`${label}: no text`); continue; }
    const kind = item.kind ?? "fact";
    if (!kinds.has(kind)) { skipped.push(`${label}: unknown kind "${kind}"`); continue; }
    const reason = sensitiveReason(item.text);
    if (reason) { skipped.push(`${label}: ${reason}`); continue; }
    try {
      const before = phoenix.memory.list().length;
      phoenix.memory.add(item.text.trim(), { kind: kind as MemoryItem["kind"], subject: item.subject });
      if (phoenix.memory.list().length > before) added += 1;
      else skipped.push(`${label}: already remembered`);
    } catch (err) {
      skipped.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { added, skipped };
}

/** `phoenix usage`: tokens and estimated cost per day and route, from Phoenix's own counts. */
function usageCommand(phoenix: Phoenix): number {
  const rows = phoenix.usage.recent(7);
  const out = (s: string) => process.stdout.write(s);
  if (rows.length === 0) {
    out(`\n  ${c.dim("No usage recorded yet (counting started with this version).")}\n\n`);
    return 0;
  }
  const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
  const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
  out(`\n  ${c.ember("Usage, last 7 days")} ${c.dim("(estimated at list prices; your Anthropic bill is the source of truth)")}\n\n`);
  out(`  ${c.dim("day         route      calls   input  cached   written  output     cost")}\n`);
  for (const r of rows) {
    out(`  ${r.day}  ${r.route.padEnd(9)} ${String(r.calls).padStart(5)} ${k(r.input).padStart(7)} ${k(r.cacheRead).padStart(7)} ${k(r.cacheWrite).padStart(9)} ${k(r.output).padStart(7)} ${usd(r.cost).padStart(8)}\n`);
  }
  const total = rows.reduce((s, r) => s + r.cost, 0);
  out(`\n  ${c.bold(`Total ${usd(total)}`)} · ${Math.round(cacheHitRate(rows) * 100)}% of input read from cache\n\n`);
  return 0;
}

/** `phoenix eval injection [--only id,id]`: run the prompt-injection suite against the real model. */
async function evalCommand(args: string[]): Promise<number> {
  if (args[0] !== "injection") {
    process.stderr.write("  Usage: phoenix eval injection [--only case-id,case-id]\n");
    return 2;
  }
  const make = modelFactory(false);
  if (!make) return 2;
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? new Set((args[onlyIdx + 1] ?? "").split(",")) : null;
  const cases = only ? CASES.filter((c) => only.has(c.id)) : CASES;
  process.stdout.write(`\n  Running ${cases.length} injection cases against Claude in a throwaway sandbox (your data isn't used)…\n\n`);
  const results = await runInjectionEval(() => make("eval"), {
    cases,
    log: (line) => process.stdout.write(`  ${line.startsWith("PASS") ? c.green(line) : c.red(line)}\n`),
  });
  const passed = results.filter((r) => r.pass).length;
  const warned = results.filter((r) => r.pass && r.warned).length;
  process.stdout.write(`\n  ${passed}/${results.length} passed · ${warned} also warned you about the hidden instructions\n`);
  for (const r of results.filter((x) => !x.pass)) {
    process.stdout.write(`\n  ${c.red(r.id)} (${r.source}, ${r.technique})\n`);
    if (r.error) process.stdout.write(`    error: ${r.error}\n`);
    for (const p of r.proposed) process.stdout.write(`    proposed: ${p}\n`);
    for (const p of r.planted) process.stdout.write(`    planted: ${p}\n`);
    if (r.leakedCanary) process.stdout.write("    reply contained the attacker's canary\n");
  }
  const dir = path.join(os.homedir(), "Library", "Application Support", "Phoenix", "evals");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `injection-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, JSON.stringify(results, null, 2), { mode: 0o600 });
  process.stdout.write(`\n  Full results: ${file}\n\n`);
  return passed === results.length ? 0 : 1;
}

/** `phoenix screen [allow|deny] "App"` — the apps screen control may operate. */
function screenCommand(phoenix: Phoenix, args: string[]): number {
  const [action, ...rest] = args;
  const name = rest.join(" ").trim();
  let apps = allowedScreenApps(phoenix.settings);
  if (action === "allow" || action === "deny") {
    if (!name) {
      process.stderr.write(`  Usage: phoenix screen ${action} "App name"\n`);
      return 2;
    }
    if (action === "allow" && NEVER_APPS.test(name)) {
      process.stderr.write(`  ${c.red("✗")} Phoenix never operates ${name}: banking, payment, password and system apps stay off limits.\n`);
      return 2;
    }
    apps = apps.filter((a) => a.toLowerCase() !== name.toLowerCase());
    if (action === "allow") apps.push(name);
    phoenix.settings.set("screen.apps", apps);
  } else if (action !== undefined && action !== "list") {
    process.stderr.write('  Usage: phoenix screen [allow|deny] "App name"\n');
    return 2;
  }
  process.stdout.write(
    [
      "",
      `  ${c.dim("Phoenix may operate these apps on screen (it asks you before every session):")}`,
      ...apps.map((a) => `    • ${a}`),
      "",
      `  ${c.dim("Never, whatever you allow: banking, UPI/payment, trading, password managers, Terminal, System Settings.")}`,
      `  ${c.dim("Private details are blanked out of screenshots on this Mac; touching the mouse or keyboard stops it.")}`,
      "",
    ].join("\n") + "\n",
  );
  return 0;
}

/** `phoenix proactive …` — settings for the morning briefing and nudges (read by the background core). */
function proactiveCommand(phoenix: Phoenix, args: string[]): number {
  const [action, ...rest] = args;
  try {
    switch (action) {
      case undefined:
      case "status":
        break;
      case "on":
      case "off":
        phoenix.settings.updateProactive({ enabled: action === "on", pausedUntil: 0 });
        break;
      case "brief": {
        minutesOf(rest[0] ?? "");
        const days = rest[1] === "weekdays" ? "weekdays" : "daily";
        phoenix.settings.updateProactive({ briefTime: rest[0]!, briefDays: days });
        break;
      }
      case "quiet": {
        const [start, end] = (rest[0] ?? "").split("-");
        minutesOf(start ?? "");
        minutesOf(end ?? "");
        phoenix.settings.updateProactive({ quietStart: start!, quietEnd: end! });
        break;
      }
      case "lead": {
        const n = Number(rest[0]);
        if (!Number.isInteger(n) || n < 1 || n > 120) throw new Error("lead must be 1–120 minutes");
        phoenix.settings.updateProactive({ meetingLead: n });
        break;
      }
      default:
        process.stderr.write("  Usage: phoenix proactive [on|off|brief HH:MM [daily|weekdays]|quiet HH:MM-HH:MM|lead N]\n");
        return 2;
    }
  } catch (err) {
    process.stderr.write(`  ${c.red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }
  const s = phoenix.settings.proactive();
  const paused = s.pausedUntil > Date.now() ? ` (paused until ${new Date(s.pausedUntil).toLocaleTimeString()})` : "";
  process.stdout.write(
    [
      "",
      `  ${s.enabled ? c.green("✓ Proactive Phoenix is on") : c.amber("– Proactive Phoenix is off")}${paused}`,
      `  ${c.dim("Morning briefing")}  ${s.briefTime} ${s.briefDays === "weekdays" ? "on weekdays" : "every day"}`,
      `  ${c.dim("Meeting nudges")}    ${s.meetingLead} minutes before`,
      `  ${c.dim("Quiet hours")}       ${s.quietStart}–${s.quietEnd} ${c.dim("(no briefing or nudges)")}`,
      `  ${c.dim("Daily limit")}       ${s.maxPerDay} messages`,
      "",
    ].join("\n") + "\n",
  );
  return 0;
}

/** `phoenix scan <file>` — show how Phoenix would treat a document, all on this Mac. */
async function scanCommand(phoenix: Phoenix, args: string[]): Promise<number> {
  const file = args.join(" ").trim();
  if (!file) {
    process.stderr.write("  Usage: phoenix scan <file>\n");
    return 2;
  }
  try {
    const scan = await scanDocument(path.resolve(file.replace(/^~(?=\/)/, os.homedir())), phoenix.vault);
    const kinds = scan.kinds.map((k) => KIND_LABEL[k]).join(", ") || "none";
    process.stdout.write(
      [
        "",
        `  ${c.ember(scan.file)} ${c.dim(`· ${scan.pages} page(s) · text read ${scan.method === "ocr" ? "with on-device OCR" : scan.method === "text" ? "from the file" : "both ways"}`)}`,
        scan.confidential
          ? `  ${c.red("🔒 CONFIDENTIAL")} ${scan.docType ?? "(contains protected details)"} — stays on this Mac`
          : `  ${c.green("✓")} Not confidential — shared with Claude only after the Privacy Shield`,
        `  ${c.dim("Protected details found:")} ${kinds}`,
        "",
        `  ${c.dim("What Phoenix would pass on:")}`,
        ...scan.shareable.slice(0, 900).split("\n").map((l) => `  ${c.dim("│")} ${l}`),
        scan.shareable.length > 900 ? `  ${c.dim("│ …")}` : "",
        "",
      ].join("\n") + "\n",
    );
    return 0;
  } catch (err) {
    process.stderr.write(`  ${c.red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

/** `phoenix autostart …` — run the core in the background from login, via LaunchAgents. */
async function autostartCommand(args: string[]): Promise<number> {
  const action = args[0] ?? "status";
  if (process.platform !== "darwin") {
    process.stderr.write("  Autostart uses macOS LaunchAgents and only works on a Mac.\n");
    return 2;
  }

  if (action === "on") {
    installAgent(coreAgent());
    const appBuilt = fs.existsSync(APP_PATH);
    if (appBuilt) installAgent(appAgent());
    process.stdout.write(
      [
        "",
        `  ${c.green("✓")} Phoenix core will start automatically when you log in, and restart if it stops.`,
        appBuilt
          ? `  ${c.green("✓")} The Phoenix Mac app will open at login too.`
          : `  ${c.amber("!")} Mac app not built yet, so it won't open at login. Build it, then run this again: ${c.amber("apps/mac/build.sh")}`,
        `  ${c.dim("Log:")} ${CORE_LOG}`,
        "",
      ].join("\n") + "\n",
    );
    const key = findSecret("__PHOENIX_IGNORE_ENV__", SECRETS.anthropic.service);
    if (!key) {
      process.stdout.write(
        `  ${c.amber("!")} No Anthropic key in your Keychain yet. The background core needs it (it can't see terminal exports).\n` +
          `    Save it once: ${c.amber("npm run phoenix -- key set")}  ${c.dim("(the core retries every 30 s and starts once it's saved)")}\n\n`,
      );
    }
    return 0;
  }

  if (action === "off") {
    const core = removeAgent(CORE_LABEL);
    const app = removeAgent(APP_LABEL);
    process.stdout.write(
      core || app
        ? `  ${c.green("✓")} Autostart is off. The background core has stopped; run ${c.amber("npm run phoenix -- serve")} to start it by hand.\n`
        : "  Autostart wasn't on.\n",
    );
    return 0;
  }

  if (action === "restart") {
    const ok = restartCore();
    process.stdout.write(ok ? `  ${c.green("✓")} Restarted the background core.\n` : `  ${c.red("✗")} Autostart isn't on. Run: npm run phoenix -- autostart on\n`);
    return ok ? 0 : 1;
  }

  if (action === "status") {
    const core = agentStatus(CORE_LABEL);
    const app = agentStatus(APP_LABEL);
    const responding = await coreResponds();
    const key = findSecret("__PHOENIX_IGNORE_ENV__", SECRETS.anthropic.service);
    const yes = (b: boolean, good: string, bad: string) => (b ? `${c.green("✓")} ${good}` : `${c.amber("–")} ${bad}`);
    process.stdout.write(
      [
        "",
        `  ${yes(core.installed, "Autostart is on", "Autostart is off")}`,
        `  ${yes(core.running, `Background core running${core.pid ? ` (pid ${core.pid})` : ""}`, `Background core not running${core.lastExit ? ` (last exit: ${core.lastExit})` : ""}`)}`,
        `  ${yes(responding, "Gateway answering on this Mac", "Nothing answering on the gateway port")}`,
        `  ${yes(!!key, "Anthropic key saved in Keychain", "No Anthropic key in Keychain (run: npm run phoenix -- key set)")}`,
        `  ${yes(app.installed, "Mac app opens at login", "Mac app doesn't open at login")}`,
        "",
      ].join("\n") + "\n",
    );
    const log = tailLog(CORE_LOG);
    if (log.length > 0) {
      process.stdout.write(`  ${c.dim(`Last lines of ${CORE_LOG}:`)}\n${log.map((l) => `  ${c.dim("│")} ${l}`).join("\n")}\n\n`);
    }
    return core.running && responding ? 0 : 1;
  }

  process.stderr.write("  Usage: phoenix autostart [on|off|status|restart]\n");
  return 2;
}

/** Free check that the key works (lists models; uses no tokens). */
async function verifyAnthropic(apiKey: string): Promise<number> {
  try {
    await new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
    process.stdout.write(`  ${c.green("✓")} Anthropic accepted the key.\n`);
    return 0;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      process.stdout.write(
        `  ${c.red("✗")} Anthropic rejected this key (expired, revoked or mistyped). Replace it: ${c.amber("npm run phoenix -- key set")}\n`,
      );
      return 1;
    }
    process.stdout.write(`  ${c.amber("!")} Couldn't check the key right now: ${describeError(err)}\n`);
    return 0;
  }
}

function terminalInput() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  return { rl, input: new LineQueue(rl) };
}

async function oneShot(phoenix: Phoenix, request: string, offline: boolean): Promise<number> {
  const makeModel = modelFactory(offline);
  if (!makeModel) return 2;
  const { rl, input } = terminalInput();
  const controller = new AbortController();
  const stop = () => stopTask(controller);
  rl.on("SIGINT", stop);
  process.on("SIGINT", stop);

  process.stdout.write(`\n  ${c.dim("YOU")}\n  ${c.italic(request)}\n`);
  if (offline) process.stdout.write(`  ${c.dim("(offline demo: scripted model, no data leaves this Mac)")}\n`);

  try {
    const outcome = await phoenix.ask(request, {
      model: makeModel(request),
      approver: new TerminalApprover(input),
      onEvent: render,
      signal: controller.signal,
    });
    process.stdout.write(`\n  ${c.dim(`task ${outcome.taskId} · ${outcome.status}`)}\n\n`);
    return outcome.status === "completed" ? 0 : 1;
  } catch (err) {
    process.stderr.write(`\n  ${c.red(describeError(err))}\n\n`);
    return 1;
  } finally {
    process.off("SIGINT", stop);
    rl.close();
  }
}

async function chat(phoenix: Phoenix, offline: boolean): Promise<number> {
  const makeModel = modelFactory(offline);
  if (!makeModel) return 2;
  const { rl, input } = terminalInput();
  let sessionId: string | undefined;
  let current: AbortController | null = null;
  const onSigint = () => {
    if (current) stopTask(current);
    else rl.close();
  };
  rl.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  process.stdout.write(
    `\n  ${c.ember("Phoenix")} ${c.dim(`chat${offline ? " (offline demo)" : ""} · /new starts a fresh topic · /exit or Ctrl-C quits`)}\n`,
  );
  try {
    for (;;) {
      process.stdout.write(`\n  ${c.dim("YOU ›")} `);
      const line = await input.next();
      if (line === null) break;
      const text = line.trim();
      if (!process.stdin.isTTY) process.stdout.write(`${text}\n`);
      if (!text) continue;
      if (text === "/exit" || text === "/quit") break;
      if (text === "/new") {
        sessionId = undefined;
        process.stdout.write(`  ${c.dim("Started a fresh topic.")}\n`);
        continue;
      }
      current = new AbortController();
      try {
        const result = await phoenix.ask(text, {
          model: makeModel(text),
          approver: new TerminalApprover(input),
          sessionId,
          onEvent: render,
          signal: current.signal,
        });
        sessionId = result.sessionId;
      } catch (err) {
        process.stderr.write(`\n  ${c.red(describeError(err))}\n`);
      } finally {
        current = null;
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
  }
  process.stdout.write("\n");
  return 0;
}

async function serve(phoenix: Phoenix, offline: boolean): Promise<number> {
  // The key can be added or replaced from the Control Center while the core runs.
  let factory = modelFactory(offline, { quiet: !offline });
  if (!factory && !offline) process.stdout.write(`  ${c.amber("!")} No Anthropic key yet: add it in Phoenix Control Center › API Keys.\n`);
  const makeModel = (request: string, o?: { effort?: "low" | "medium" | "high" }): ModelClient => {
    factory ??= modelFactory(offline, { quiet: true });
    if (!factory) throw new Error("No Anthropic API key saved yet. Add it in Phoenix Control Center › API Keys.");
    return factory(request, o);
  };
  const token = loadOrCreateGatewayToken(phoenix.cfg);
  const port = Number(process.env.PHOENIX_PORT ?? 7788);
  const speech = speechFromEnvironment(process.env, phoenix.cfg.home);
  const connectors = new McpHub({
    registry: phoenix.registry,
    settings: phoenix.settings,
    log: (line) => process.stdout.write(`  ${c.dim(new Date().toLocaleTimeString())} ${line}\n`),
  });
  const proactive = new ProactiveScheduler(phoenix, {
    // Briefings only read and summarise: low effort is plenty and costs less.
    makeModel: () => makeModel("briefing", { effort: "low" }),
    log: (line) => process.stdout.write(`  ${c.dim(new Date().toLocaleTimeString())} ${line}\n`),
  });
  if (speech instanceof KokoroSpeech) {
    speech.warmUp().catch((err) => process.stdout.write(`  ${c.red("voice")} couldn't load the local voice: ${err}\n`));
  }
  let gateway;
  try {
    gateway = await startGateway(phoenix, {
    port,
    token,
    offline,
    speech,
    proactive,
    modelFactory: makeModel,
    admin: {
      mcp: connectors,
      keysChanged: () => {
        factory = modelFactory(offline, { quiet: true });
        process.stdout.write(`  ${c.dim(new Date().toLocaleTimeString())} API key updated from the Control Center\n`);
      },
    },
    log: (line) => process.stdout.write(`  ${c.dim(new Date().toLocaleTimeString())} ${line}\n`),
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      process.stderr.write(
        `\n  ${c.red("✗")} Port ${port} is already in use: another Phoenix core is probably running.\n` +
          `    Check with: ${c.amber("npm run phoenix -- autostart status")}\n\n`,
      );
      return 1;
    }
    throw err;
  }
  process.stdout.write(
    [
      "",
      `  ${c.ember("Phoenix core is running")} ${c.dim(offline ? "(offline demo model)" : "(Claude)")}`,
      `  ${c.dim("gateway")}  ws://127.0.0.1:${gateway.port}  ${c.dim("(this Mac only)")}`,
      `  ${c.dim("token")}    ${gatewayTokenPath(phoenix.cfg)}`,
      `  ${c.dim("voice")}    ${
        !speech
          ? `Apple voice in the Mac app ${c.dim(process.env.PHOENIX_TTS === "elevenlabs" ? "(no ElevenLabs key found)" : "")}`
          : speech.kind === "cloud"
            ? `${speech.label} ${c.dim("(reply text is sent to ElevenLabs)")}`
            : `${speech.label} ${c.dim("(free, private: nothing leaves this Mac)")}`
      }`,
      `  ${c.dim("Open the Phoenix Mac app, or press Ctrl-C here to stop.")}`,
      "",
    ].join("\n"),
  );
  proactive.start();
  void connectors.startAll();
  // Nightly encrypted backup: checked every 30 minutes, runs once a day.
  const backupTimer = setInterval(() => {
    const s = backupSettings(phoenix.settings);
    if (!backupDue(s)) return;
    try {
      const file = createBackup(phoenix.cfg, phoenix.settings, loadMasterKey(phoenix.cfg));
      process.stdout.write(`  ${c.dim(new Date().toLocaleTimeString())} backup saved: ${file}\n`);
    } catch (err) {
      updateBackupSettings(phoenix.settings, { lastError: err instanceof Error ? err.message : String(err) });
    }
  }, 30 * 60_000);
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  proactive.stop();
  await connectors.stopAll();
  clearInterval(backupTimer);
  process.stdout.write(`\n  ${c.dim("Stopping…")}\n`);
  await gateway.close();
  return 0;
}

function stopTask(controller: AbortController): void {
  if (!controller.signal.aborted) {
    process.stdout.write(`\n  ${c.red("■ Stopping Phoenix…")}\n`);
    controller.abort();
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

function showMemory(phoenix: Phoenix, args: string[]): number {
  const [action, ...rest] = args;
  if (action === "forget") {
    const id = Number(rest[0]);
    if (!Number.isInteger(id) || id <= 0) {
      process.stderr.write("  Usage: phoenix memory forget <number>\n");
      return 2;
    }
    const removed = phoenix.memory.remove(id);
    process.stdout.write(removed ? `  ${c.green("✓")} Forgot #${id}\n` : `  No memory #${id}\n`);
    return removed ? 0 : 1;
  }
  if (action === "add" || action === "profile" || action === "person" || action === "style") {
    // phoenix memory add "text" | profile "text" | person "Name" "text" | style "text"
    const subject = action === "person" ? rest[0] : undefined;
    const text = (action === "person" ? rest.slice(1) : rest).join(" ").trim();
    if (!text || (action === "person" && !subject)) {
      process.stderr.write('  Usage: phoenix memory add|profile|style "text"   or   phoenix memory person "Name" "text"\n');
      return 2;
    }
    const reason = sensitiveReason(text);
    if (reason) {
      process.stderr.write(`  ${c.red("✗")} Not saved: ${reason}. Phoenix never keeps secrets in memory.\n`);
      return 2;
    }
    const kind = action === "add" ? "fact" : action;
    const item = phoenix.memory.add(text, { kind, subject });
    process.stdout.write(`  ${c.green("✓")} Remembered #${item.id} (${kind}${subject ? `: ${subject}` : ""})\n`);
    return 0;
  }
  if (action === "import") {
    if (!rest[0]) {
      process.stderr.write("  Usage: phoenix memory import <file.json>\n");
      return 2;
    }
    try {
      const report = importMemories(phoenix, JSON.parse(fs.readFileSync(rest[0], "utf8")));
      process.stdout.write(
        `  ${c.green("✓")} Imported ${report.added} memories${report.skipped.length ? `, skipped ${report.skipped.length}` : ""}\n` +
          report.skipped.map((s) => `    ${c.amber("–")} ${s}\n`).join(""),
      );
      return 0;
    } catch (err) {
      process.stderr.write(`  ${c.red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
      return 2;
    }
  }
  if (action !== undefined && action !== "all") {
    process.stderr.write("  Usage: phoenix memory [all|add|profile|person|style|import|forget]\n");
    return 2;
  }

  const items = phoenix.memory.list();
  const lasting = items.filter((m) => m.kind !== "episode");
  if (items.length === 0) {
    process.stdout.write(`  ${c.dim("Phoenix doesn't remember anything about you yet.")}\n`);
    return 0;
  }
  const line = (m: MemoryItem) =>
    `    ${c.amber(`#${m.id}`.padEnd(6))}${m.text} ${c.dim(new Date(m.createdAt).toLocaleDateString("en-GB"))}\n`;
  const out = (s: string) => process.stdout.write(s);
  out(`\n  ${c.ember("What Phoenix remembers about you")} ${c.dim("(encrypted on this Mac)")}\n`);
  const sections: Array<[string, MemoryItem[], string]> = [
    ["Profile", lasting.filter((m) => m.kind === "profile"), "sent with every request (cached)"],
    ["Facts & preferences", lasting.filter((m) => m.kind === "fact"), "sent only when relevant"],
    ["How you write", lasting.filter((m) => m.kind === "style"), "used when drafting for you"],
  ];
  for (const [title, list, note] of sections) {
    if (!list.length) continue;
    out(`\n  ${c.bold(title)} ${c.dim(`— ${note}`)}\n`);
    list.forEach((m) => out(line(m)));
  }
  const local = lasting.filter((m) => m.kind === "local");
  if (local.length) {
    out(`\n  ${c.bold("Kept on this Mac only")} ${c.dim("— never sent to Claude (for the on-device model later)")}\n`);
    local.forEach((m) => out(`    ${c.amber(`#${m.id}`.padEnd(6))}${m.subject ? `${c.ember(m.subject)}: ` : ""}${m.text}\n`));
  }
  for (const kind of ["person", "project"] as const) {
    const bySubject = new Map<string, MemoryItem[]>();
    for (const m of lasting.filter((x) => x.kind === kind)) bySubject.set(m.subject!, [...(bySubject.get(m.subject!) ?? []), m]);
    if (!bySubject.size) continue;
    out(`\n  ${c.bold(kind === "person" ? "People" : "Projects")} ${c.dim("— sent when you mention them")}\n`);
    for (const [subject, list] of bySubject) {
      out(`    ${c.ember(subject)}\n`);
      list.forEach((m) => out(`  ${line(m)}`));
    }
  }
  const episodes = items.filter((m) => m.kind === "episode");
  if (episodes.length) {
    const show = action === "all" ? episodes : episodes.slice(-5);
    out(`\n  ${c.bold("Recent requests")} ${c.dim(`— ${episodes.length} kept, found again when relevant${action === "all" ? "" : " (phoenix memory all shows every one)"}`)}\n`);
    show.forEach((m) => out(line(m)));
  }
  out(`\n  ${c.dim("Add: phoenix memory profile \"I work at Varsun as …\"  ·  person \"Ankit\" \"colleague, …\"  ·  forget <n>")}\n\n`);
  return 0;
}

function showAudit(phoenix: Phoenix, args: string[]): number {
  if (args[0] === "verify") {
    const report = phoenix.audit.verify();
    if (report.ok) {
      process.stdout.write(`  ${c.green("✓")} Audit log intact (${report.count} entries)\n`);
      return 0;
    }
    process.stdout.write(`  ${c.red("✗")} Audit log BROKEN at entry #${report.brokenAt}: ${report.reason}\n`);
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
    return "Anthropic rejected the API key (expired or revoked). Replace it with: npm run phoenix -- key set";
  }
  if (err instanceof Anthropic.RateLimitError) return "Claude API rate limit hit; try again shortly.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${describeError(err)}\n`);
    process.exit(1);
  },
);
