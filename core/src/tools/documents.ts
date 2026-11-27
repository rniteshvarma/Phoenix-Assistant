import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { SUPPORTED, allowedRoots, resolveAllowed, scanDocument } from "../privacy/documents.ts";
import { defineTool } from "./types.ts";

export const documentRead = defineTool({
  name: "document_read",
  tier: Tier.Read,
  untrustedOutput: true,
  description:
    "Read a document on the user's Mac (in Documents, Desktop or Downloads): PDF, image (text is recognised on the Mac) " +
    "or text file. Confidential documents such as ID cards, passports, bank and card statements are never shared with " +
    "you: you'll only be told what kind of document it is, with placeholders for its protected numbers.",
  schema: z.strictObject({
    path: z.string().min(1).max(500).describe("Full path or ~/… path, e.g. ~/Downloads/scan.pdf"),
  }),
  describe: (i) => `Read ${path.basename(i.path)}`,
  async run(i, ctx) {
    const scan = await scanDocument(resolveAllowed(i.path), ctx.vault);
    return scan.shareable;
  },
});

export const documentsList = defineTool({
  name: "documents_list",
  tier: Tier.Read,
  untrustedOutput: true,
  description: `List documents (${SUPPORTED.join(" ")}) in the user's Documents, Desktop or Downloads, newest first, optionally filtered by a word in the name.`,
  schema: z.strictObject({
    folder: z.enum(["Documents", "Desktop", "Downloads"]).describe("Which folder to look in"),
    nameContains: z.string().max(80).optional().describe("Only files whose name contains this (case-insensitive)"),
  }),
  describe: (i) => `List ${i.folder}${i.nameContains ? ` matching "${i.nameContains}"` : ""}`,
  async run(i) {
    const root = allowedRoots().find((r) => path.basename(r) === i.folder)!;
    const names = (await fs.readdir(root, { recursive: true })).map(String).filter((n) => {
      const ext = path.extname(n).toLowerCase();
      return SUPPORTED.includes(ext) && !n.split(path.sep).some((part) => part.startsWith("."))
        && (!i.nameContains || n.toLowerCase().includes(i.nameContains.toLowerCase()));
    });
    const withTimes = await Promise.all(
      names.slice(0, 2000).map(async (n) => ({ n, t: (await fs.stat(path.join(root, n))).mtimeMs })),
    );
    const top = withTimes.sort((a, b) => b.t - a.t).slice(0, 100);
    if (top.length === 0) return `No matching documents in ~/${i.folder}.`;
    return top.map((f) => `~/${i.folder}/${f.n}`).join("\n");
  },
});
