import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Start Phoenix automatically when you log in, using per-user macOS LaunchAgents:
 *  - dev.phoenix.core: the core (`phoenix serve`), restarted if it ever stops unexpectedly
 *  - dev.phoenix.app:  opens the Phoenix Mac app
 * No secrets are written to these files: the core reads its API key from the Keychain.
 */

export const CORE_LABEL = "dev.phoenix.core";
export const APP_LABEL = "dev.phoenix.app";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const LAUNCH_AGENTS = path.join(os.homedir(), "Library", "LaunchAgents");
export const LOG_DIR = path.join(os.homedir(), "Library", "Logs", "Phoenix");
export const CORE_LOG = path.join(LOG_DIR, "core.log");
export const APP_PATH = path.join(REPO_ROOT, "apps", "mac", "build", "Phoenix.app");

export interface AgentSpec {
  label: string;
  programArguments: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
  logPath?: string;
  /** Restart if it exits with an error (not after a clean exit). */
  restartOnFailure?: boolean;
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Render a LaunchAgent property list. Pure, so it can be tested. */
export function renderPlist(spec: AgentSpec): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${xml(spec.label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...spec.programArguments.map((a) => `    <string>${xml(a)}</string>`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>ProcessType</key><string>Interactive</string>",
  ];
  if (spec.workingDirectory) lines.push(`  <key>WorkingDirectory</key><string>${xml(spec.workingDirectory)}</string>`);
  if (spec.environment && Object.keys(spec.environment).length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [k, v] of Object.entries(spec.environment)) {
      lines.push(`    <key>${xml(k)}</key><string>${xml(v)}</string>`);
    }
    lines.push("  </dict>");
  }
  if (spec.restartOnFailure) {
    lines.push(
      "  <key>KeepAlive</key>",
      "  <dict><key>SuccessfulExit</key><false/></dict>",
      "  <key>ThrottleInterval</key><integer>30</integer>",
    );
  }
  if (spec.logPath) {
    lines.push(
      `  <key>StandardOutPath</key><string>${xml(spec.logPath)}</string>`,
      `  <key>StandardErrorPath</key><string>${xml(spec.logPath)}</string>`,
    );
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

/**
 * The Node binary to launch at login. Prefer a stable link (Homebrew's /opt/homebrew/bin/node)
 * over a versioned path like …/Cellar/node/25.9.0/bin/node that breaks on upgrade.
 */
export function stableNodePath(execPath = process.execPath): string {
  for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
    try {
      if (fs.realpathSync(candidate) === fs.realpathSync(execPath)) return candidate;
    } catch {
      // not installed there
    }
  }
  return execPath;
}

export function coreAgent(env: NodeJS.ProcessEnv = process.env): AgentSpec {
  const nodeBin = stableNodePath();
  const environment: Record<string, string> = {
    NO_COLOR: "1",
    PATH: [path.dirname(nodeBin), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  };
  // Carry over voice choices if you set them (never API keys: those come from the Keychain).
  for (const name of ["PHOENIX_VOICE", "PHOENIX_TTS", "PHOENIX_VOICE_ID", "PHOENIX_TTS_MODEL", "PHOENIX_PORT", "PHOENIX_HOME"]) {
    if (env[name]) environment[name] = env[name]!;
  }
  return {
    label: CORE_LABEL,
    programArguments: [nodeBin, path.join(REPO_ROOT, "core", "src", "cli", "main.ts"), "serve"],
    workingDirectory: REPO_ROOT,
    environment,
    logPath: CORE_LOG,
    restartOnFailure: true,
  };
}

export function appAgent(): AgentSpec {
  return { label: APP_LABEL, programArguments: ["/usr/bin/open", "-a", APP_PATH] };
}

const plistPath = (label: string) => path.join(LAUNCH_AGENTS, `${label}.plist`);
const domain = () => `gui/${os.userInfo().uid}`;

function launchctl(args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/** Write and load an agent (replacing any previous version). */
export function installAgent(spec: AgentSpec): void {
  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  if (spec.logPath) fs.mkdirSync(path.dirname(spec.logPath), { recursive: true });
  const file = plistPath(spec.label);
  launchctl(["bootout", `${domain()}/${spec.label}`]);
  fs.writeFileSync(file, renderPlist(spec), { mode: 0o644 });
  const result = launchctl(["bootstrap", domain(), file]);
  if (!result.ok && !/already|service is already loaded/i.test(result.out)) {
    throw new Error(`launchctl couldn't load ${spec.label}: ${result.out.trim()}`);
  }
}

export function removeAgent(label: string): boolean {
  launchctl(["bootout", `${domain()}/${label}`]);
  const file = plistPath(label);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

export interface AgentStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  lastExit?: string;
}

export function agentStatus(label: string): AgentStatus {
  const installed = fs.existsSync(plistPath(label));
  const { ok, out } = launchctl(["print", `${domain()}/${label}`]);
  if (!ok) return { installed, running: false };
  const pid = /\bpid = (\d+)/.exec(out)?.[1];
  const lastExit = /last exit code = (.+)/.exec(out)?.[1]?.trim();
  return { installed, running: /state = running/.test(out), pid: pid ? Number(pid) : undefined, lastExit };
}

export function restartCore(): boolean {
  return launchctl(["kickstart", "-k", `${domain()}/${CORE_LABEL}`]).ok;
}

export function tailLog(file: string, lines = 6): string[] {
  try {
    return fs.readFileSync(file, "utf8").trimEnd().split("\n").slice(-lines);
  } catch {
    return [];
  }
}

export async function coreResponds(port = Number(process.env.PHOENIX_PORT ?? 7788)): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}
