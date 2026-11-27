import { execFileSync } from "node:child_process";
import os from "node:os";

/** API keys Phoenix can keep in the macOS Keychain (login keychain, this user only). */
export const SECRETS = {
  anthropic: { env: "ANTHROPIC_API_KEY", service: "anthropic-api-key", label: "Anthropic API key (Phoenix)" },
  elevenlabs: { env: "ELEVENLABS_API_KEY", service: "elevenlabs-api-key", label: "ElevenLabs API key (Phoenix)" },
} as const;

export type SecretName = keyof typeof SECRETS;

export interface FoundSecret {
  value: string;
  source: "environment" | "keychain";
}

/**
 * Read a secret: an environment variable wins (handy for a one-off override),
 * otherwise the Keychain item `service`.
 */
export function findSecret(envName: string, service: string, env = process.env): FoundSecret | undefined {
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return { value: fromEnv, source: "environment" };
  if (process.platform !== "darwin") return undefined;
  try {
    const value = execFileSync(
      "security",
      ["find-generic-password", "-a", os.userInfo().username, "-s", service, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 },
    ).trim();
    return value ? { value, source: "keychain" } : undefined;
  } catch {
    return undefined;
  }
}

export function loadSecret(envName: string, service: string, env = process.env): string | undefined {
  return findSecret(envName, service, env)?.value;
}

/**
 * Save (or replace) a key in the Keychain. macOS's own `security` tool prompts for the
 * value with typing hidden, so the key never passes through Phoenix, the shell history
 * or the process list.
 */
export function storeSecretInteractively(name: SecretName): void {
  const s = SECRETS[name];
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-a", os.userInfo().username, "-s", s.service, "-l", s.label, "-w"],
    { stdio: "inherit" },
  );
}

export function removeSecret(name: SecretName): boolean {
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-a", os.userInfo().username, "-s", SECRETS[name].service],
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

/** Safe-to-show description of a key: first characters and length only. */
export function describeKey(value: string): string {
  return `${value.slice(0, 10)}… (${value.length} characters)`;
}

/**
 * Save (or replace) a key from the Control Center. The value goes to macOS's `security` tool
 * on its standard input (interactive mode), never on a command line, so it doesn't show in
 * the process list or any log.
 */
export function storeSecret(name: SecretName, value: string): void {
  const s = SECRETS[name];
  const v = value.trim();
  if (!/^[A-Za-z0-9_\-.:]{8,400}$/.test(v)) {
    throw new Error("that doesn't look like an API key (letters, digits, - _ . only; no spaces)");
  }
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "");
  execFileSync("security", ["-i"], {
    input: `add-generic-password -U -a "${user}" -s "${s.service}" -l "${s.label}" -w "${v}"\n`,
    stdio: ["pipe", "ignore", "pipe"],
    timeout: 10_000,
  });
}
