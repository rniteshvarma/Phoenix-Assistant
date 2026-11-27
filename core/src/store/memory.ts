import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

/**
 * What Phoenix knows about the user, encrypted at rest on this Mac.
 *
 *  profile  — who the user is (always sent, cached; kept short)
 *  person   — someone in the user's life; `subject` is their name (and nicknames)
 *  project  — something ongoing (a trip, a work project); `subject` is its name
 *  fact     — any other lasting preference or detail
 *  style    — how the user writes and speaks (notes, plus samples of approved messages)
 *  episode  — a one-line record of a past request and what came of it (kept rolling)
 *  local    — kept on this Mac only and never sent to any cloud model (e.g. work-confidential
 *             customer details); for the on-device model later. Only the user can add these.
 *
 * Only the profile goes with every request; everything else is looked up and only the
 * relevant few items are sent (see memory/recall.ts).
 */
export const MEMORY_KINDS = ["profile", "person", "project", "fact", "style", "episode", "local"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface MemoryItem {
  id: number;
  kind: MemoryKind;
  /** Person or project name, e.g. "Ankit" or "Mom (Amma)"; for style samples, who it was sent to. */
  subject?: string;
  text: string;
  createdAt: number;
}

/** Lasting memories (not counting episodes and style samples, which roll over). */
export const MEMORY_LIMIT = 1000;
export const EPISODE_LIMIT = 300;
export const STYLE_SAMPLES_PER_SUBJECT = 6;
export const STYLE_SAMPLE_PREFIX = "Sample of the user's writing: ";

export class MemoryStore {
  #db: DatabaseSync;
  #key: Buffer;
  #cache: MemoryItem[] | null = null;
  #version = -1;

  constructor(db: DatabaseSync, dataKey: Buffer) {
    this.#db = db;
    this.#key = dataKey;
  }

  add(text: string, opts: { kind?: MemoryKind; subject?: string } = {}): MemoryItem {
    const kind = opts.kind ?? "fact";
    const subject = opts.subject?.trim() || undefined;
    if ((kind === "person" || kind === "project") && !subject) throw new Error(`a ${kind} memory needs a subject (the name)`);
    const same = this.list().find((m) => m.kind === kind && m.text.toLowerCase() === text.toLowerCase() && m.subject === subject);
    if (same) return same; // already known
    if (kind !== "episode" && !isStyleSample(text)) {
      const lasting = this.list().filter((m) => m.kind !== "episode" && !isStyleSample(m.text)).length;
      if (lasting >= MEMORY_LIMIT) throw new Error(`Memory is full (${MEMORY_LIMIT} items). Ask the user what to forget.`);
    }
    const createdAt = Date.now();
    const result = this.#db
      .prepare("INSERT INTO memories (text_enc, created_at, kind, subject_enc) VALUES (?, ?, ?, ?)")
      .run(seal(this.#key, text), createdAt, kind, subject ? seal(this.#key, subject) : null);
    this.#cache = null;
    return { id: Number(result.lastInsertRowid), kind, subject, text, createdAt };
  }

  /** Replace a memory's text (and, if given, its subject); keeps its kind. */
  update(id: number, text: string, subject?: string | null): boolean {
    this.#cache = null;
    if (subject === undefined) {
      return this.#db.prepare("UPDATE memories SET text_enc = ? WHERE id = ?").run(seal(this.#key, text), id).changes > 0;
    }
    return this.#db
      .prepare("UPDATE memories SET text_enc = ?, subject_enc = ? WHERE id = ?")
      .run(seal(this.#key, text), subject ? seal(this.#key, subject) : null, id).changes > 0;
  }

  remove(id: number): boolean {
    this.#cache = null;
    return this.#db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
  }

  get(id: number): MemoryItem | undefined {
    return this.list().find((m) => m.id === id);
  }

  list(kind?: MemoryKind): MemoryItem[] {
    // Another process (e.g. `phoenix memory add` in Terminal) may have changed the database.
    const version = (this.#db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    if (version !== this.#version) this.#cache = null;
    this.#version = version;
    if (!this.#cache) {
      const rows = this.#db
        .prepare("SELECT id, text_enc, created_at, kind, subject_enc FROM memories ORDER BY id ASC")
        .all() as unknown as Array<{ id: number; text_enc: string; created_at: number; kind: string; subject_enc: string | null }>;
      this.#cache = rows.map((r) => ({
        id: r.id,
        kind: (MEMORY_KINDS as readonly string[]).includes(r.kind) ? (r.kind as MemoryKind) : "fact",
        subject: r.subject_enc ? open(this.#key, r.subject_enc) : undefined,
        text: open(this.#key, r.text_enc),
        createdAt: r.created_at,
      }));
    }
    return kind ? this.#cache.filter((m) => m.kind === kind) : [...this.#cache];
  }

  /** Remember what a request was and how it ended; the oldest roll off. */
  addEpisode(text: string): MemoryItem {
    const item = this.add(text, { kind: "episode" });
    const episodes = this.list("episode");
    for (const old of episodes.slice(0, Math.max(0, episodes.length - EPISODE_LIMIT))) this.remove(old.id);
    return item;
  }

  /** Keep a few recent messages the user approved, per recipient, to learn their writing style. */
  addStyleSample(subject: string, text: string): MemoryItem {
    const item = this.add(`${STYLE_SAMPLE_PREFIX}${text}`, { kind: "style", subject });
    const samples = this.list("style").filter((m) => m.subject === subject && isStyleSample(m.text));
    for (const old of samples.slice(0, Math.max(0, samples.length - STYLE_SAMPLES_PER_SUBJECT))) this.remove(old.id);
    return item;
  }
}

export function isStyleSample(text: string): boolean {
  return text.startsWith(STYLE_SAMPLE_PREFIX);
}

/** Bring a database from the first memory version (text only) up to date. Idempotent. */
export function migrateMemories(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  if (!cols.includes("kind")) db.exec("ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'fact'");
  if (!cols.includes("subject_enc")) db.exec("ALTER TABLE memories ADD COLUMN subject_enc TEXT");
}

/**
 * Refuse to store obvious secrets. Phoenix memory is sent to the model as context,
 * so passwords, card numbers, OTPs and ID numbers must never go in it.
 * Returns a reason if the text looks sensitive, otherwise null.
 */
export function sensitiveReason(text: string): string | null {
  const digits = text.replace(/[\s-]/g, "");
  if (/\d{13,19}/.test(digits) && luhnSomewhere(digits)) return "it looks like a card number";
  if (/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(text)) return "it looks like an Aadhaar or similar ID number";
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(text)) return "it looks like a PAN number";
  if (/\b(password|passcode|pin|otp|cvv|secret key|api key)\b\s*(is|:|=)/i.test(text)) {
    return "it looks like a password, PIN or one-time code";
  }
  if (/\bsk-[a-z0-9-]{10,}/i.test(text)) return "it looks like an API key";
  return null;
}

function luhnSomewhere(digits: string): boolean {
  for (const match of digits.matchAll(/\d{13,19}/g)) {
    let sum = 0;
    const s = match[0];
    for (let i = 0; i < s.length; i += 1) {
      let d = Number(s[s.length - 1 - i]);
      if (i % 2 === 1) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}
