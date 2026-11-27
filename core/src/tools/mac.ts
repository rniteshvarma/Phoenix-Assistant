import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { allowedRoots, resolveAllowed } from "../privacy/documents.ts";
import { defineTool, type ToolContext } from "./types.ts";

/**
 * Phase 4a: Phoenix acting on the Mac through each app's official interfaces (EventKit,
 * Contacts, AppleScript, Shortcuts) rather than clicking on the screen.
 * App-backed actions run inside the Phoenix Mac app (so macOS permissions belong to it);
 * file and Shortcuts actions run in the core.
 */

const run = promisify(execFile);

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time")
  .describe("ISO 8601 date-time with offset, e.g. 2026-11-27T18:00:00+05:30");

const onMac = (capability: string, tool: string) => (input: unknown, ctx: ToolContext) =>
  ctx.devices.call(capability, tool, input);

// ── Reminders ────────────────────────────────────────────────────────────────

export const remindersList = defineTool({
  name: "reminders_list",
  tier: Tier.Read,
  untrustedOutput: true,
  description: "List the user's open reminders (Apple Reminders), with due dates and ids.",
  schema: z.strictObject({ list: z.string().max(100).optional().describe("Only this Reminders list") }),
  describe: (i) => `List reminders${i.list ? ` in ${i.list}` : ""}`,
  run: onMac("reminders", "reminders_list"),
});

export const remindersAdd = defineTool({
  name: "reminders_add",
  tier: Tier.Prepare,
  description: "Add a reminder in Apple Reminders, optionally with a due date/time and list.",
  schema: z.strictObject({
    title: z.string().min(1).max(200),
    due: isoDateTime.optional(),
    list: z.string().max(100).optional(),
    notes: z.string().max(2000).optional(),
  }),
  describe: (i) => `Add reminder "${i.title}"${i.due ? ` (due ${i.due.slice(0, 16).replace("T", " ")})` : ""}`,
  run: onMac("reminders", "reminders_add"),
});

export const remindersComplete = defineTool({
  name: "reminders_complete",
  tier: Tier.Prepare,
  description: "Mark a reminder as done, by the id shown in reminders_list.",
  schema: z.strictObject({ id: z.string().min(1).max(200) }),
  describe: () => "Mark a reminder as done",
  run: onMac("reminders", "reminders_complete"),
});

// ── Calendar ─────────────────────────────────────────────────────────────────

export const calendarAddEvent = defineTool({
  name: "calendar_add_event",
  tier: Tier.Prepare,
  description: "Add an event to the user's own calendar (no invitations are sent).",
  schema: z
    .strictObject({
      title: z.string().min(1).max(200),
      start: isoDateTime,
      end: isoDateTime,
      location: z.string().max(200).optional(),
      notes: z.string().max(2000).optional(),
    })
    .refine((i) => Date.parse(i.end) > Date.parse(i.start), "'end' must be after 'start'"),
  describe: (i) => `Add "${i.title}" to calendar, ${i.start.slice(0, 16).replace("T", " ")}`,
  run: onMac("calendar.write", "calendar_add_event"),
});

// ── Contacts & Messages ──────────────────────────────────────────────────────

export const contactsSearch = defineTool({
  name: "contacts_search",
  tier: Tier.Read,
  untrustedOutput: true,
  description:
    "Find people in the user's Contacts by name (or nickname such as Mom). Phone numbers and emails come back as placeholders.",
  schema: z.strictObject({ name: z.string().min(1).max(100) }),
  describe: (i) => `Look up "${i.name}" in Contacts`,
  run: onMac("contacts", "contacts_search"),
});

export const messagesSend = defineTool({
  name: "messages_send",
  tier: Tier.Act,
  leavesDevice: true,
  description:
    "Send an iMessage from the user's Messages app. 'to' is a phone number or email (use the placeholder from contacts_search). Always needs the user's approval.",
  schema: z.strictObject({
    to: z.string().min(3).max(100).describe("Phone number or email, e.g. [[PHONE_1]]"),
    text: z.string().min(1).max(2000),
  }),
  styleSample: (i) => ({ subject: i.to, text: i.text }),
  describe: (i) => `Send iMessage to ${i.to}: "${i.text.length > 60 ? `${i.text.slice(0, 57)}…` : i.text}"`,
  run: onMac("messages", "messages_send"),
});

// ── Apple Notes & apps ───────────────────────────────────────────────────────

export const appleNotesCreate = defineTool({
  name: "apple_notes_create",
  tier: Tier.Prepare,
  description: "Create a note in the user's Apple Notes app (syncs to their iPhone through their own iCloud).",
  schema: z.strictObject({ title: z.string().min(1).max(200), body: z.string().max(20_000) }),
  describe: (i) => `Create Apple Note "${i.title}"`,
  run: onMac("apple.notes", "apple_notes_create"),
});

export const appOpen = defineTool({
  name: "app_open",
  tier: Tier.Prepare,
  description: "Open an app on the Mac by name (e.g. 'Spotify', 'Calendar') or a web page (https:// URL) in the default browser.",
  schema: z.strictObject({
    target: z
      .string()
      .min(1)
      .max(500)
      .refine((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) || /^https?:\/\//i.test(t), "only app names or http(s) URLs"),
  }),
  describe: (i) => `Open ${i.target}`,
  run: onMac("apps", "app_open"),
});

// ── Files (core) ─────────────────────────────────────────────────────────────

const FOLDERS = ["Documents", "Desktop", "Downloads"] as const;

export const filesMove = defineTool({
  name: "files_move",
  tier: Tier.Prepare,
  description: "Move a file within Documents, Desktop or Downloads (never overwrites an existing file).",
  schema: z.strictObject({
    from: z.string().min(1).max(500).describe("Path of the file, e.g. ~/Downloads/report.pdf"),
    toFolder: z.enum(FOLDERS),
    subfolder: z.string().max(200).optional().describe("Optional subfolder inside it, created if missing"),
  }),
  describe: (i) => `Move ${path.basename(i.from)} to ~/${i.toFolder}${i.subfolder ? `/${i.subfolder}` : ""}`,
  async run(i) {
    const source = resolveAllowed(i.from);
    const root = allowedRoots().find((r) => path.basename(r) === i.toFolder)!;
    const dir = path.resolve(root, i.subfolder ?? ".");
    const rel = path.relative(root, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("subfolder must stay inside the folder");
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, path.basename(source));
    if (fs.existsSync(target)) throw new Error(`${path.basename(target)} already exists there`);
    fs.renameSync(source, target);
    return `Moved to ${target.replace(os.homedir(), "~")}`;
  },
});

export const filesTrash = defineTool({
  name: "files_trash",
  tier: Tier.Act,
  description: "Move a file from Documents, Desktop or Downloads to the Trash (recoverable). Needs the user's approval.",
  schema: z.strictObject({ path: z.string().min(1).max(500) }),
  describe: (i) => `Move ${path.basename(i.path)} to the Trash`,
  async run(i) {
    const source = resolveAllowed(i.path);
    const trash = path.join(os.homedir(), ".Trash");
    let target = path.join(trash, path.basename(source));
    if (fs.existsSync(target)) target = path.join(trash, `${Date.now()}-${path.basename(source)}`);
    fs.renameSync(source, target);
    return `Moved ${path.basename(source)} to the Trash (you can put it back from there).`;
  },
});

// ── Shortcuts (core) ─────────────────────────────────────────────────────────

export const shortcutsList = defineTool({
  name: "shortcuts_list",
  tier: Tier.Read,
  untrustedOutput: true,
  description: "List the user's Shortcuts (from the Shortcuts app) by name.",
  schema: z.strictObject({}),
  describe: () => "List Shortcuts",
  async run() {
    const { stdout } = await run("/usr/bin/shortcuts", ["list"], { timeout: 20_000 });
    return stdout.trim() || "No Shortcuts found.";
  },
});

export const shortcutsRun = defineTool({
  name: "shortcuts_run",
  tier: Tier.Act,
  description: "Run one of the user's Shortcuts by its exact name. Shortcuts can do anything, so this always needs approval.",
  schema: z.strictObject({ name: z.string().min(1).max(200) }),
  describe: (i) => `Run Shortcut "${i.name}"`,
  async run(i) {
    const { stdout } = await run("/usr/bin/shortcuts", ["run", i.name], { timeout: 120_000 });
    return stdout.trim() ? `Ran "${i.name}". Output: ${stdout.trim().slice(0, 2000)}` : `Ran "${i.name}".`;
  },
});

export const MAC_TOOLS = [
  remindersList, remindersAdd, remindersComplete, calendarAddEvent, contactsSearch, messagesSend,
  appleNotesCreate, appOpen, filesMove, filesTrash, shortcutsList, shortcutsRun,
];
