import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";
import { KIND_LABEL, PLACEHOLDER, detect, type Kind } from "./detect.ts";

/**
 * The Privacy Shield's vault. Sensitive values found in text are swapped for placeholders
 * like [[PAN_1]] before anything is sent to a cloud service; the real values stay here,
 * encrypted, on this Mac. The same value always gets the same placeholder, so the model
 * can still refer to "the same email address" across a conversation.
 */
export class PrivacyVault {
  #db: DatabaseSync;
  #encKey: Buffer;
  #macKey: Buffer;
  #byToken = new Map<string, string>();

  constructor(db: DatabaseSync, encKey: Buffer, macKey: Buffer) {
    this.#db = db;
    this.#encKey = encKey;
    this.#macKey = macKey;
  }

  /** Replace every sensitive value in `text` with its placeholder. */
  protect(text: string): { text: string; kinds: Kind[] } {
    const findings = detect(text);
    if (findings.length === 0) return { text, kinds: [] };
    let out = "";
    let last = 0;
    const kinds = new Set<Kind>();
    for (const f of findings) {
      out += text.slice(last, f.start) + this.#tokenFor(f.kind, f.value);
      last = f.end;
      kinds.add(f.kind);
    }
    return { text: out + text.slice(last), kinds: [...kinds] };
  }

  /** Put the real values back. Only ever used for things that stay on this Mac. */
  reveal(text: string): string {
    return text.replace(PLACEHOLDER, (whole) => this.#valueFor(whole) ?? whole);
  }

  protectDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.protect(s).text);
  }

  revealDeep<T>(value: T): T {
    return mapStrings(value, (s) => this.reveal(s));
  }

  /** Kinds of protected data carried by a value: its placeholders and anything not yet protected. */
  kindsIn(value: unknown): Kind[] {
    const kinds = new Set<Kind>();
    mapStrings(value, (s) => {
      for (const m of s.matchAll(PLACEHOLDER)) {
        if (this.#valueFor(m[0]) !== undefined) kinds.add(m[1] as Kind);
      }
      for (const f of detect(s)) kinds.add(f.kind);
      return s;
    });
    return [...kinds];
  }

  /** Text safe to hand to a cloud voice: placeholders become a spoken phrase. */
  speakable(text: string): string {
    return this.protect(text).text.replace(PLACEHOLDER, (_w, kind: string) =>
      `your ${KIND_LABEL[kind as Kind] ?? "protected detail"}`,
    );
  }

  #fingerprint(kind: Kind, value: string): string {
    const normal = kind === "EMAIL" || kind === "UPI" ? value.toLowerCase() : value.replace(/[\s-]/g, "").toUpperCase();
    return createHmac("sha256", this.#macKey).update(`${kind}:${normal}`).digest("hex");
  }

  #tokenFor(kind: Kind, value: string): string {
    const fp = this.#fingerprint(kind, value);
    const row = this.#db.prepare("SELECT token FROM protected_values WHERE fingerprint = ?").get(fp) as
      | { token: string }
      | undefined;
    if (row) return row.token;
    const n = (this.#db.prepare("SELECT COUNT(*) AS n FROM protected_values WHERE kind = ?").get(kind) as { n: number }).n + 1;
    const token = `[[${kind}_${n}]]`;
    this.#db
      .prepare("INSERT INTO protected_values (token, kind, fingerprint, value_enc, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(token, kind, fp, seal(this.#encKey, value), Date.now());
    this.#byToken.set(token, value);
    return token;
  }

  #valueFor(token: string): string | undefined {
    const cached = this.#byToken.get(token);
    if (cached !== undefined) return cached;
    const row = this.#db.prepare("SELECT value_enc FROM protected_values WHERE token = ?").get(token) as
      | { value_enc: string }
      | undefined;
    if (!row) return undefined;
    const value = open(this.#encKey, row.value_enc);
    this.#byToken.set(token, value);
    return value;
  }
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  }
  return value;
}

/**
 * Reveals placeholders in streamed text for local display/voice, holding back a partial
 * placeholder (e.g. "[[EMA") until the rest of it arrives.
 */
export class StreamRevealer {
  #pending = "";
  #reveal: (s: string) => string;

  constructor(reveal: (s: string) => string) {
    this.#reveal = reveal;
  }

  push(delta: string): string {
    this.#pending += delta;
    const open = this.#pending.lastIndexOf("[[");
    const cut =
      open >= 0 && this.#pending.indexOf("]]", open) < 0
        ? open
        : this.#pending.endsWith("[")
          ? this.#pending.length - 1
          : this.#pending.length;
    const ready = this.#pending.slice(0, cut);
    this.#pending = this.#pending.slice(cut);
    return this.#reveal(ready);
  }

  flush(): string {
    const rest = this.#pending;
    this.#pending = "";
    return this.#reveal(rest);
  }
}
