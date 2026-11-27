import { z } from "zod";
import { rank } from "../memory/recall.ts";
import { Tier } from "../policy/tiers.ts";
import { sensitiveReason } from "../store/memory.ts";
import { defineTool } from "./types.ts";

export const memoryRemember = defineTool({
  name: "memory_remember",
  tier: Tier.Prepare,
  description:
    "Remember something lasting about the user, so you don't have to ask again. Pick the kind: " +
    "'profile' = core facts about who they are (name, city, job, family, daily routine; keep these few and short); " +
    "'person' = someone in their life (subject = the name and any nicknames, e.g. 'Mom (Amma)'); " +
    "'project' = something ongoing (subject = its name, e.g. 'Goa trip'); " +
    "'style' = how they write or speak (tone, length, language, greetings, per person if it differs); " +
    "'fact' = any other preference or detail. One clear, self-contained statement per call. " +
    "To correct an old memory, pass its number as 'replaces'. Never store passwords, PINs, OTPs, card or ID numbers.",
  schema: z.strictObject({
    fact: z.string().min(3).max(500).describe('e.g. "Ankit is a colleague at Varsun; prefers short WhatsApp messages"'),
    kind: z.enum(["profile", "person", "project", "fact", "style"]).default("fact"),
    subject: z.string().max(80).optional().describe("Required for person/project: the name (and nicknames)"),
    replaces: z.number().int().positive().optional().describe("Number of an older memory this one corrects"),
  }),
  describe: (i) => `Remember${i.subject ? ` about ${i.subject}` : ""}: ${i.fact}`,
  async run(i, ctx) {
    const reason = sensitiveReason(i.fact) ?? (i.subject ? sensitiveReason(i.subject) : null);
    if (reason) throw new Error(`not stored because ${reason}; Phoenix never keeps secrets in memory`);
    if (i.replaces) {
      const old = ctx.memory.get(i.replaces);
      if (!old) throw new Error(`there is no memory #${i.replaces}`);
      ctx.memory.remove(i.replaces);
    }
    const item = ctx.memory.add(i.fact, { kind: i.kind, subject: i.subject });
    return `Remembered (#${item.id}, ${item.kind}${item.subject ? `: ${item.subject}` : ""}): ${item.text}`;
  },
});

export const memorySearch = defineTool({
  name: "memory_search",
  tier: Tier.Read,
  description:
    "Search everything you remember about the user, including past requests (episodes), people, projects and " +
    "writing style. Use it when the context doesn't have what you need, e.g. \"what did I ask you about the Goa hotel?\"",
  schema: z.strictObject({
    query: z.string().min(2).max(200),
    kind: z.enum(["profile", "person", "project", "fact", "style", "episode"]).optional(),
  }),
  describe: (i) => `Search memory for "${i.query}"`,
  async run(i, ctx) {
    // Local-only memories never go to the model.
    const items = ctx.memory.list(i.kind).filter((m) => m.kind !== "local");
    const found = rank(i.query, items, 12);
    if (found.length === 0) return `Nothing remembered matches "${i.query}".`;
    return found
      .map((m) => `[#${m.id}] ${m.kind}${m.subject ? ` (${m.subject})` : ""}, ${new Date(m.createdAt).toLocaleDateString("en-GB")}: ${m.text}`)
      .join("\n");
  },
});

export const memoryForget = defineTool({
  name: "memory_forget",
  tier: Tier.Prepare,
  description: "Forget a remembered item by its number (shown as [#n]).",
  schema: z.strictObject({ id: z.number().int().positive() }),
  describe: (i) => `Forget memory #${i.id}`,
  async run(i, ctx) {
    return ctx.memory.remove(i.id) ? `Forgot memory #${i.id}.` : `There is no memory #${i.id}.`;
  },
});
