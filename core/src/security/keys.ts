import { execFileSync } from "node:child_process";
import { hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PhoenixConfig } from "../config.ts";

const KEYCHAIN_SERVICE = "dev.phoenix.master-key";
const KEYCHAIN_ACCOUNT = "phoenix";

export interface PhoenixKeys {
  /** Signs approval tokens. */
  hmacKey: Buffer;
  /** Encrypts data at rest (audit entries, task transcripts). */
  dataKey: Buffer;
  /** Fingerprints protected values in the Privacy Shield vault. */
  privacyKey: Buffer;
}

/**
 * Load (or create on first run) the 256-bit master key and derive purpose-specific
 * keys from it. The master key never leaves the Keychain except into this process's
 * memory, and it is never placed in model context or logs.
 */
export function loadKeys(cfg: PhoenixConfig): PhoenixKeys {
  const master = cfg.keyBackend === "keychain" ? keychainMasterKey() : fileMasterKey(cfg);
  return {
    hmacKey: derive(master, "phoenix/approval-hmac/v1"),
    dataKey: derive(master, "phoenix/data-at-rest/v1"),
    privacyKey: derive(master, "phoenix/privacy-fingerprint/v1"),
  };
}

function derive(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), info, 32));
}

function keychainMasterKey(): Buffer {
  try {
    const hex = execFileSync(
      "security",
      ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    if (/^[0-9a-f]{64}$/.test(hex)) return Buffer.from(hex, "hex");
    throw new Error("Phoenix master key in Keychain is malformed");
  } catch (err) {
    if (err instanceof Error && err.message.includes("malformed")) throw err;
    // Not found: create it. (The value is briefly visible to `ps` during this one-time
    // call; the native Mac app will replace this with the Keychain API in Phase 1.)
    const master = randomBytes(32);
    execFileSync(
      "security",
      [
        "add-generic-password",
        "-a", KEYCHAIN_ACCOUNT,
        "-s", KEYCHAIN_SERVICE,
        "-l", "Phoenix master key",
        "-w", master.toString("hex"),
      ],
      { stdio: "ignore" },
    );
    return master;
  }
}

function fileMasterKey(cfg: PhoenixConfig): Buffer {
  const file = path.join(cfg.home, "master.key");
  if (fs.existsSync(file)) {
    const hex = fs.readFileSync(file, "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Malformed key file: ${file}`);
    return Buffer.from(hex, "hex");
  }
  const master = randomBytes(32);
  fs.writeFileSync(file, master.toString("hex"), { mode: 0o600, flag: "wx" });
  return master;
}
