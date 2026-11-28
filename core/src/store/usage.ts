import type Anthropic from "@anthropic-ai/sdk";
import type { DatabaseSync } from "node:sqlite";

/**
 * Token usage and estimated cost, per day and per route (chat, briefing, screen…), kept locally.
 * Counts only, never content. Prices are list prices in USD per million tokens; the bill from
 * Anthropic is the source of truth.
 */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** USD per million tokens (input, output, cache read, 5-minute cache write). */
export const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

export function usageFrom(u: Anthropic.Beta.BetaUsage | undefined | null): Usage | undefined {
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export function costUSD(model: string, u: Usage): number {
  const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1e6;
}

export interface UsageRow extends Usage {
  day: string;
  route: string;
  model: string;
  calls: number;
  cost: number;
}

export class UsageStore {
  #db: DatabaseSync;
  #now: () => Date;

  constructor(db: DatabaseSync, now: () => Date = () => new Date()) {
    this.#db = db;
    this.#now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS usage_daily (
      day TEXT NOT NULL, route TEXT NOT NULL, model TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, route, model))`);
  }

  record(route: string, model: string, u: Usage): void {
    const d = this.#now();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    this.#db
      .prepare(`INSERT INTO usage_daily (day, route, model, calls, input, output, cache_read, cache_write) VALUES (?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(day, route, model) DO UPDATE SET calls = calls + 1, input = input + excluded.input, output = output + excluded.output,
        cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write`)
      .run(day, route, model, u.input, u.output, u.cacheRead, u.cacheWrite);
  }

  /** Rows for the last `days` days, newest first. */
  recent(days = 7): UsageRow[] {
    const since = new Date(this.#now().getTime() - (days - 1) * 86_400_000);
    const from = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, "0")}-${String(since.getDate()).padStart(2, "0")}`;
    const rows = this.#db
      .prepare("SELECT * FROM usage_daily WHERE day >= ? ORDER BY day DESC, route")
      .all(from) as Array<{ day: string; route: string; model: string; calls: number; input: number; output: number; cache_read: number; cache_write: number }>;
    return rows.map((r) => {
      const u = { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write };
      return { day: r.day, route: r.route, model: r.model, calls: r.calls, ...u, cost: costUSD(r.model, u) };
    });
  }
}

/** Share of input served from the cache (higher is cheaper). */
export function cacheHitRate(rows: readonly Usage[]): number {
  const read = rows.reduce((s, r) => s + r.cacheRead, 0);
  const all = rows.reduce((s, r) => s + r.cacheRead + r.cacheWrite + r.input, 0);
  return all ? read / all : 0;
}
