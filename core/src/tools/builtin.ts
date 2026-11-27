import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { calendarEvents } from "./calendar.ts";
import { documentRead, documentsList } from "./documents.ts";
import { MAC_TOOLS } from "./mac.ts";
import { screenAct } from "./screen.ts";
import { skillRead, skillSave } from "./skills.ts";
import { memoryForget, memoryRemember, memorySearch } from "./memory.ts";
import { defineTool, type Tool } from "./types.ts";

/** Resolve `name` inside `dir`, refusing anything that escapes it (`..`, absolute paths). */
function insideDir(dir: string, name: string): string {
  const target = path.resolve(dir, name);
  const rel = path.relative(dir, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("path is outside the allowed folder");
  }
  return target;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "note";
}

async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  for (let i = 1; ; i += 1) {
    const candidate = insideDir(dir, i === 1 ? `${base}${ext}` : `${base}-${i}${ext}`);
    try {
      await fs.access(candidate);
    } catch {
      return candidate;
    }
  }
}

export const notesSave = defineTool({
  name: "notes_save",
  tier: Tier.Prepare,
  description:
    "Save a private Markdown note in the user's local Phoenix notes folder. The note stays on this device; nothing is sent anywhere.",
  schema: z.strictObject({
    title: z.string().min(1).max(120).describe("Short title for the note"),
    body: z.string().min(1).max(20_000).describe("Note content in Markdown"),
  }),
  describe: (i) => `Save note "${i.title}"`,
  async run(i, ctx) {
    const file = await uniquePath(ctx.cfg.notesDir, slugify(i.title), ".md");
    await fs.writeFile(file, `# ${i.title}\n\n${i.body}\n`, { mode: 0o600, flag: "wx" });
    return `Saved note "${i.title}" as ${path.basename(file)}.`;
  },
});

export const notesList = defineTool({
  name: "notes_list",
  tier: Tier.Read,
  description: "List the user's saved Phoenix notes (file names, newest first).",
  schema: z.strictObject({}),
  describe: () => "List notes",
  async run(_i, ctx) {
    const names = (await fs.readdir(ctx.cfg.notesDir)).filter((n) => n.endsWith(".md"));
    if (names.length === 0) return "No notes yet.";
    const withTimes = await Promise.all(
      names.map(async (n) => ({ n, t: (await fs.stat(path.join(ctx.cfg.notesDir, n))).mtimeMs })),
    );
    return withTimes.sort((a, b) => b.t - a.t).map((x) => x.n).join("\n");
  },
});

export const notesRead = defineTool({
  name: "notes_read",
  tier: Tier.Read,
  untrustedOutput: true,
  description: "Read one of the user's saved notes by file name (as returned by notes_list).",
  schema: z.strictObject({
    file: z.string().min(1).max(200).describe("File name, e.g. groceries.md"),
  }),
  describe: (i) => `Read note ${i.file}`,
  async run(i, ctx) {
    return fs.readFile(insideDir(ctx.cfg.notesDir, i.file), "utf8");
  },
});

export const outboxSend = defineTool({
  name: "outbox_send",
  tier: Tier.Act,
  leavesDevice: true,
  description:
    "Send an email on the user's behalf. Always requires the user's approval. " +
    "In this early build it is SIMULATED: the email is written to the local outbox folder, not delivered.",
  schema: z.strictObject({
    to: z.email().describe("Recipient email address"),
    subject: z.string().min(1).max(200),
    body: z.string().min(1).max(20_000).describe("Plain-text email body"),
  }),
  describe: (i) => `Send email to ${i.to}: "${i.subject}"`,
  styleSample: (i) => ({ subject: i.to, text: i.body }),
  async run(i, ctx) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = await uniquePath(ctx.cfg.outboxDir, `${stamp}-${slugify(i.subject)}`, ".json");
    const record = { ...i, taskId: ctx.taskId, simulatedAt: new Date().toISOString() };
    await fs.writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600, flag: "wx" });
    return `Email to ${i.to} placed in the local outbox (simulated send, not delivered).`;
  },
});

export const BUILTIN_TOOLS: Tool[] = [
  screenAct,
  skillRead,
  skillSave,
  notesSave,
  notesList,
  notesRead,
  outboxSend,
  memoryRemember,
  memorySearch,
  memoryForget,
  calendarEvents,
  documentsList,
  documentRead,
  ...MAC_TOOLS,
];
