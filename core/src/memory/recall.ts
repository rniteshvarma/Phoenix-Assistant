import { isStyleSample, type MemoryItem, type MemoryStore } from "../store/memory.ts";

/**
 * Choosing what Phoenix remembers *for this request*, on this Mac, without a model call:
 *  - the profile (always; it sits in the cached part of the prompt),
 *  - pages for people and projects named in the request,
 *  - the few other memories that best match the request (BM25 keyword ranking),
 *  - recent episodes when the request refers back ("yesterday", "that", "follow up"),
 *  - writing-style notes and samples when the request is about writing to someone.
 * Everything else stays on the Mac; the model can still look it up with memory_search.
 */

export interface Recall {
  profile: MemoryItem[];
  people: Array<{ subject: string; items: MemoryItem[] }>;
  relevant: MemoryItem[];
  style: MemoryItem[];
}

const STOP = new Set(
  ("a an and are as at be but by can could do does for from had has have he her his i if in into is it its me my " +
    "of on or our she so that the their them then there these they this to too us was we were what when where which " +
    "who why will with would you your please phoenix rise tell ask want need get let make just " +
    // Times of day and weekdays are in almost every request and say little about which memory fits.
    "today tomorrow tonight morning evening afternoon night now later week monday tuesday wednesday thursday friday saturday sunday").split(" "),
);

export function tokens(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ed")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("es")) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith("s")) return t.slice(0, -1);
  return t;
}

/** BM25 ranking of `items` against `query`. Pure. */
export function rank(query: string, items: readonly MemoryItem[], limit = 8): MemoryItem[] {
  const q = [...new Set(tokens(query))];
  if (q.length === 0 || items.length === 0) return [];
  const docs = items.map((m) => tokens(`${m.subject ?? ""} ${m.subject ?? ""} ${m.text}`));
  const avg = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length, k1 = 1.2, b = 0.75;
  const now = Date.now();
  return items
    .map((m, i) => {
      const d = docs[i]!;
      let score = 0;
      for (const t of q) {
        const f = d.filter((x) => x === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (N - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      // Older episodes matter less.
      if (m.kind === "episode") score *= 1 / (1 + (now - m.createdAt) / (14 * 86_400_000));
      return { m, score };
    })
    .filter((x) => x.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

/** Names a person/project goes by: "Mom (Amma)" → ["mom", "amma"]. */
export function aliases(subject: string): string[] {
  return subject.toLowerCase().split(/[()/,|]+|\s+or\s+|\s+aka\s+/).map((s) => s.trim()).filter((s) => s.length > 1);
}

function mentions(text: string, subject: string): boolean {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  return aliases(subject).some((a) => t.includes(` ${a.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `));
}

const REFERS_BACK = /\b(yesterday|earlier|last (time|week|night)|before|again|follow ?up|that (one|thing|email|message)|remind me what|what did (i|we))\b/i;
const WRITING = /\b(text|message|msg|whatsapp|imessage|email|mail|reply|respond|draft|write|send|tell)\b/i;

export function recall(store: MemoryStore, request: string): Recall {
  const all = store.list();
  const profile = all.filter((m) => m.kind === "profile");

  const pages = new Map<string, MemoryItem[]>();
  for (const m of all) {
    if ((m.kind === "person" || m.kind === "project") && m.subject && mentions(request, m.subject)) {
      // (local memories are never picked: they don't leave this Mac)
      pages.set(m.subject, [...(pages.get(m.subject) ?? []), m]);
    }
  }
  const people = [...pages].map(([subject, items]) => ({ subject, items: items.slice(-10) }));
  const shown = new Set([...profile, ...people.flatMap((p) => p.items)].map((m) => m.id));

  // Style notes come only with writing requests, in their own section.
  const pool = all.filter((m) => !shown.has(m.id) && m.kind !== "profile" && m.kind !== "style" && m.kind !== "local");
  const relevant = rank(request, pool, 8);
  if (REFERS_BACK.test(request)) {
    for (const e of all.filter((m) => m.kind === "episode").slice(-3)) if (!relevant.includes(e)) relevant.push(e);
  }

  let style: MemoryItem[] = [];
  if (WRITING.test(request)) {
    const notes = all.filter((m) => m.kind === "style" && !isStyleSample(m.text));
    const named = new Set(people.map((p) => p.subject));
    const samples = all.filter((m) => m.kind === "style" && isStyleSample(m.text));
    // Samples sent to someone named in the request first, then the most recent others.
    const forThem = samples.filter((m) => m.subject && [...named].some((n) => aliases(n).some((a) => aliases(m.subject!).includes(a))));
    const recent = samples.filter((m) => !forThem.includes(m)).slice(-3);
    style = [...notes.slice(-6), ...forThem.slice(-3), ...recent].slice(0, 10);
  }
  return { profile, people, relevant, style };
}

/** The profile, as a stable block for the cached part of the prompt. */
export function renderProfile(profile: readonly MemoryItem[]): string {
  if (profile.length === 0) return "";
  return ["<user_profile>", ...profile.map((m) => `[#${m.id}] ${m.text}`), "</user_profile>"].join("\n");
}

/** Lines for the per-turn <context> block. */
export function renderRecall(r: Recall): string[] {
  const lines: string[] = [];
  for (const p of r.people) {
    lines.push(`About ${p.subject}:`);
    for (const m of p.items) lines.push(`  [#${m.id}] ${m.text}`);
  }
  if (r.relevant.length) {
    lines.push("Possibly relevant memories:");
    for (const m of r.relevant) {
      const when = m.kind === "episode" ? `${new Date(m.createdAt).toLocaleDateString("en-GB")} ` : "";
      lines.push(`  [#${m.id}] ${when}${m.subject ? `(${m.subject}) ` : ""}${m.text}`);
    }
  }
  if (r.style.length) {
    lines.push("How the user writes (match this when drafting for them):");
    for (const m of r.style) lines.push(`  [#${m.id}] ${m.subject ? `(to ${m.subject}) ` : ""}${m.text}`);
  }
  return lines;
}

/** The skill index: names and one-line descriptions only (cached with the profile). */
export function renderSkillIndex(skills: ReadonlyArray<{ name: string; description: string }>): string {
  if (skills.length === 0) return "";
  return ["<skills>", ...skills.map((s) => `- ${s.name}: ${s.description}`), "</skills>"].join("\n");
}

/** The saved skill that clearly fits this request, if any (its steps go in the context). */
export function matchSkill<T extends { id: number; name: string; description: string; steps: string }>(
  request: string,
  skills: readonly T[],
): T | undefined {
  const items = skills.map((s) => ({ id: s.id, kind: "fact" as const, subject: s.name, text: s.description, createdAt: 0 }));
  const best = rank(request, items, 1)[0];
  return best && skills.find((s) => s.id === best.id);
}
