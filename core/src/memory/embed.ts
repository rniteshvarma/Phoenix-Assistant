import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

/**
 * Meaning-based memory search, on this Mac: a small sentence-embedding model (all-MiniLM-L6-v2,
 * about 23 MB, quantised) turns each memory and each request into a vector, so "mother" finds
 * "Amma" and "after the gym" finds the fitness notes. The model loads only from local files
 * (no network), and the vectors are stored encrypted next to the memories.
 */

export const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";

export interface Embedder {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

export function modelInstalled(home: string): boolean {
  return fs.existsSync(path.join(home, "models", ...EMBED_MODEL.split("/"), "onnx"));
}

export class LocalEmbedder implements Embedder {
  readonly name = EMBED_MODEL;
  #cacheDir: string;
  #pipe: Promise<(texts: string[], opts: object) => Promise<{ tolist(): number[][] }>> | null = null;

  constructor(home: string) {
    this.#cacheDir = path.join(home, "models");
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.#pipe ??= (async () => {
      const { pipeline, env } = await import("@huggingface/transformers");
      env.cacheDir = this.#cacheDir;
      return (await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8", local_files_only: true })) as never;
    })();
    const pipe = await this.#pipe;
    return (await pipe(texts, { pooling: "mean", normalize: true })).tolist();
  }
}

export function cosine(a: readonly number[], b: readonly number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

/** Encrypted vector cache, keyed by a keyed hash of the text (the text itself isn't stored here). */
export class MemoryVectors {
  #db: DatabaseSync;
  #key: Buffer;
  #embedder: Embedder;
  #mem = new Map<string, number[]>();

  constructor(db: DatabaseSync, dataKey: Buffer, embedder: Embedder) {
    this.#db = db;
    this.#key = dataKey;
    this.#embedder = embedder;
    db.exec("CREATE TABLE IF NOT EXISTS memory_vectors (hash TEXT PRIMARY KEY, model TEXT NOT NULL, vec_enc TEXT NOT NULL)");
  }

  #hash(text: string): string {
    return createHmac("sha256", this.#key).update(`${this.#embedder.name}\n${text}`).digest("hex");
  }

  /** Vectors for these texts, computing (and saving) only the ones not seen before. */
  async vectors(texts: string[]): Promise<number[][]> {
    const hashes = texts.map((t) => this.#hash(t));
    const missing: number[] = [];
    hashes.forEach((h, i) => {
      if (this.#mem.has(h)) return;
      const row = this.#db.prepare("SELECT vec_enc FROM memory_vectors WHERE hash = ?").get(h) as { vec_enc: string } | undefined;
      if (row) this.#mem.set(h, JSON.parse(open(this.#key, row.vec_enc)) as number[]);
      else missing.push(i);
    });
    if (missing.length) {
      const fresh = await this.#embedder.embed(missing.map((i) => texts[i]!));
      const insert = this.#db.prepare("INSERT OR REPLACE INTO memory_vectors (hash, model, vec_enc) VALUES (?, ?, ?)");
      missing.forEach((i, k) => {
        const v = fresh[k]!.map((x) => Math.round(x * 1e5) / 1e5);
        this.#mem.set(hashes[i]!, v);
        insert.run(hashes[i]!, this.#embedder.name, seal(this.#key, JSON.stringify(v)));
      });
    }
    return hashes.map((h) => this.#mem.get(h)!);
  }

  async query(text: string): Promise<number[]> {
    return (await this.#embedder.embed([text]))[0]!;
  }
}
