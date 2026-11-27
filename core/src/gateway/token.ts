import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PhoenixConfig } from "../config.ts";

/**
 * Shared secret for local apps connecting to the gateway. Stored 0600 in the Phoenix
 * home folder, which only this user can read; the Mac app reads the same file.
 */
export function gatewayTokenPath(cfg: PhoenixConfig): string {
  return path.join(cfg.home, "gateway.token");
}

export function loadOrCreateGatewayToken(cfg: PhoenixConfig): string {
  const file = gatewayTokenPath(cfg);
  if (fs.existsSync(file)) {
    const token = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(token)) return token;
  }
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(file, token, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return token;
}

export function tokenMatches(expected: string, header: string | undefined): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
