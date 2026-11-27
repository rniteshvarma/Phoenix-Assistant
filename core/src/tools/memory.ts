import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { sensitiveReason } from "../store/memory.ts";
import { defineTool } from "./types.ts";

export const memoryRemember = defineTool({
  name: "memory_remember",
  tier: Tier.Prepare,
  description:
    "Remember a lasting fact or preference about the user (e.g. their email address, home city, " +
    "dietary preference, how they like replies). Only store what the user told you or clearly wants " +
    "remembered. Never store passwords, PINs, OTPs, card or ID numbers.",
  schema: z.strictObject({
    fact: z.string().min(3).max(500).describe("One self-contained fact, e.g. \"User lives in Bengaluru\""),
  }),
  describe: (i) => `Remember: ${i.fact}`,
  async run(i, ctx) {
    const reason = sensitiveReason(i.fact);
    if (reason) throw new Error(`not stored because ${reason}; Phoenix never keeps secrets in memory`);
    const item = ctx.memory.add(i.fact);
    return `Remembered (#${item.id}): ${item.text}`;
  },
});

export const memoryForget = defineTool({
  name: "memory_forget",
  tier: Tier.Prepare,
  description: "Forget a remembered fact by its number (shown as [#n] in the context).",
  schema: z.strictObject({ id: z.number().int().positive() }),
  describe: (i) => `Forget memory #${i.id}`,
  async run(i, ctx) {
    return ctx.memory.remove(i.id) ? `Forgot memory #${i.id}.` : `There is no memory #${i.id}.`;
  },
});
