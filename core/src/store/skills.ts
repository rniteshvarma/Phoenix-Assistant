import type { DatabaseSync } from "node:sqlite";
import { open, seal } from "../security/crypto.ts";

/**
 * Skills: routines the user taught Phoenix ("Phoenix, learn this: …"), in plain language.
 * Only each skill's name and one-line description go with requests; the steps are pulled
 * in when a request matches, or read with skill_read. Encrypted at rest on this Mac.
 */
export interface Skill {
  id: number;
  name: string;
  description: string;
  steps: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export const SKILL_LIMIT = 200;

export const SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name_enc        TEXT NOT NULL,
  description_enc TEXT NOT NULL,
  steps_enc       TEXT NOT NULL,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);`;

export class SkillStore {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(db: DatabaseSync, dataKey: Buffer) {
    this.#db = db;
    this.#key = dataKey;
    db.exec(SKILLS_SCHEMA);
  }

  list(): Skill[] {
    const rows = this.#db.prepare("SELECT * FROM skills ORDER BY id ASC").all() as unknown as Array<{
      id: number; name_enc: string; description_enc: string; steps_enc: string; enabled: number; created_at: number; updated_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      name: open(this.#key, r.name_enc),
      description: open(this.#key, r.description_enc),
      steps: open(this.#key, r.steps_enc),
      enabled: r.enabled === 1,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  byName(name: string): Skill | undefined {
    const n = name.trim().toLowerCase();
    return this.list().find((s) => s.name.toLowerCase() === n);
  }

  /** Create, or update the skill with this id (or with the same name). */
  save(skill: { id?: number; name: string; description: string; steps: string; enabled?: boolean }): Skill {
    const name = skill.name.trim();
    if (!name || !skill.steps.trim()) throw new Error("a skill needs a name and steps");
    const now = Date.now();
    const existing = skill.id ? this.list().find((s) => s.id === skill.id) : this.byName(name);
    const clash = this.byName(name);
    if (clash && existing && clash.id !== existing.id) throw new Error(`there is already a skill called "${name}"`);
    if (existing) {
      this.#db
        .prepare("UPDATE skills SET name_enc = ?, description_enc = ?, steps_enc = ?, enabled = ?, updated_at = ? WHERE id = ?")
        .run(seal(this.#key, name), seal(this.#key, skill.description.trim()), seal(this.#key, skill.steps.trim()),
          (skill.enabled ?? existing.enabled) ? 1 : 0, now, existing.id);
      return this.list().find((s) => s.id === existing.id)!;
    }
    if (this.list().length >= SKILL_LIMIT) throw new Error(`Phoenix already has ${SKILL_LIMIT} skills`);
    const r = this.#db
      .prepare("INSERT INTO skills (name_enc, description_enc, steps_enc, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(seal(this.#key, name), seal(this.#key, skill.description.trim()), seal(this.#key, skill.steps.trim()),
        skill.enabled === false ? 0 : 1, now, now);
    return this.list().find((s) => s.id === Number(r.lastInsertRowid))!;
  }

  remove(id: number): boolean {
    return this.#db.prepare("DELETE FROM skills WHERE id = ?").run(id).changes > 0;
  }
}
