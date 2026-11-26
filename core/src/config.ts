import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Models used by Phoenix. The planner does the real work; the router arrives in Phase 1. */
export const MODELS = {
  planner: "claude-opus-5-5",
  router: "claude-haiku-5-5",
} as const;

export interface PhoenixConfig {
  /** Root of all local Phoenix data. Directory is created with mode 0700. */
  home: string;
  dbPath: string;
  notesDir: string;
  /** Phase 0: "sent" messages are written here instead of being delivered. */
  outboxDir: string;
  /** Where the master key lives: macOS Keychain (default on macOS) or a 0600 file. */
  keyBackend: "keychain" | "file";
  /** Hard cap on model turns per task (runaway-agent protection). */
  maxSteps: number;
  /** How long an approval token stays valid. */
  approvalTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PhoenixConfig {
  const home =
    env.PHOENIX_HOME ?? path.join(os.homedir(), "Library", "Application Support", "Phoenix");
  const keyBackend =
    env.PHOENIX_KEY_BACKEND === "file" || process.platform !== "darwin" ? "file" : "keychain";
  return {
    home,
    dbPath: path.join(home, "phoenix.db"),
    notesDir: path.join(home, "notes"),
    outboxDir: path.join(home, "outbox"),
    keyBackend,
    maxSteps: Number(env.PHOENIX_MAX_STEPS ?? 12),
    approvalTtlMs: 10 * 60 * 1000,
  };
}

export function ensureDirs(cfg: PhoenixConfig): void {
  for (const dir of [cfg.home, cfg.notesDir, cfg.outboxDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}
