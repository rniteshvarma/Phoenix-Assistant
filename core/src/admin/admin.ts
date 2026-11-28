import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Phoenix } from "../phoenix.ts";
import { checkApiKey } from "../cli/keycheck.ts";
import { PROACTIVE_DEFAULTS } from "../proactive/schedule.ts";
import { NEVER_APPS } from "../screen/session.ts";
import { describeKey, findSecret, removeSecret, SECRETS, storeSecret, type SecretName } from "../security/secrets.ts";
import { MEMORY_KINDS, sensitiveReason, type MemoryKind } from "../store/memory.ts";
import type { History } from "../store/sessions.ts";
import { allowedScreenApps } from "../tools/screen.ts";
import { CONNECTORS, disabledConnectors, setConnector } from "./connectors.ts";
import { backupSettings, createBackup, setupBackupKey, updateBackupSettings } from "../backup/backup.ts";
import { loadMasterKey } from "../security/keys.ts";
import { MCP_PRESETS, type McpHub } from "../mcp/hub.ts";
import { cacheHitRate } from "../store/usage.ts";

/**
 * The Control Center's view of Phoenix: settings, memory, skills, connectors, keys and history.
 * Reached only over the authenticated, this-Mac-only gateway, from the user's own app, so these
 * are the user acting directly; the model can never call any of this.
 * Text is shown with real values filled in (it's the user's own screen); anything the user
 * types into memory or skills is protected before the model ever sees it.
 */
export interface AdminHooks {
  /** API keys changed: rebuild the Claude client. */
  keysChanged?: () => void;
  /** Third-party connectors (only in the running core). */
  mcp?: McpHub;
}

const kind = z.enum(MEMORY_KINDS);
const secretName = z.enum(Object.keys(SECRETS) as [SecretName, ...SecretName[]]);

export const AdminOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("overview") }),
  z.object({ op: z.literal("settings.set"), name: z.string().min(1).max(30).optional(),
    proactive: z.record(z.string(), z.unknown()).optional(), screenApps: z.array(z.string().min(1).max(60)).max(50).optional() }),
  z.object({ op: z.literal("memory.list") }),
  z.object({ op: z.literal("memory.add"), kind, subject: z.string().max(120).optional(), text: z.string().min(2).max(2000) }),
  z.object({ op: z.literal("memory.update"), id: z.number().int(), text: z.string().min(2).max(2000), subject: z.string().max(120).nullable().optional() }),
  z.object({ op: z.literal("memory.remove"), id: z.number().int() }),
  z.object({ op: z.literal("skills.list") }),
  z.object({ op: z.literal("skills.save"), id: z.number().int().optional(), name: z.string().min(2).max(60),
    description: z.string().max(200), steps: z.string().min(3).max(4000), enabled: z.boolean().optional() }),
  z.object({ op: z.literal("skills.remove"), id: z.number().int() }),
  z.object({ op: z.literal("connectors.set"), id: z.string(), enabled: z.boolean() }),
  z.object({ op: z.literal("keys.set"), name: secretName, value: z.string().min(8).max(400) }),
  z.object({ op: z.literal("keys.remove"), name: secretName }),
  z.object({ op: z.literal("keys.test") }),
  z.object({ op: z.literal("history.list") }),
  z.object({ op: z.literal("history.get"), id: z.string().max(64) }),
  z.object({ op: z.literal("history.remove"), id: z.string().max(64) }),
  z.object({ op: z.literal("backup.status") }),
  z.object({ op: z.literal("usage") }),
  z.object({ op: z.literal("backup.setup"), passphrase: z.string().min(1).max(500) }),
  z.object({ op: z.literal("backup.now") }),
  z.object({ op: z.literal("backup.settings"), dir: z.string().min(1).max(500).optional(), nightly: z.boolean().optional() }),
  z.object({ op: z.literal("mcp.add"), preset: z.string().max(40).optional(), name: z.string().min(1).max(40),
    transport: z.enum(["http", "stdio"]), url: z.string().max(500).optional(), command: z.string().max(200).optional(),
    args: z.array(z.string().max(300)).max(30).optional(), tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]{0,60}$/).optional(),
    token: z.string().max(400).optional() }),
  z.object({ op: z.literal("mcp.remove"), id: z.string().max(40) }),
  z.object({ op: z.literal("mcp.set"), id: z.string().max(40), enabled: z.boolean() }),
  z.object({ op: z.literal("mcp.reconnect"), id: z.string().max(40) }),
]);
export type AdminRequest = z.infer<typeof AdminOp>;

export async function handleAdmin(phoenix: Phoenix, raw: unknown, hooks: AdminHooks = {}): Promise<unknown> {
  const parsed = AdminOp.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid request: ${z.prettifyError(parsed.error)}`);
  const req = parsed.data;
  const { memory, skills, settings, vault, sessions } = phoenix;
  const show = (s: string) => vault.reveal(s);
  /** What the user typed: refuse secrets, and keep other sensitive values as placeholders. */
  const store = (s: string) => {
    const reason = sensitiveReason(s);
    if (reason) throw new Error(`not saved: ${reason}. Phoenix never keeps secrets in memory or skills.`);
    return vault.protect(s.trim()).text;
  };

  switch (req.op) {
    case "overview":
      return {
        mcp: hooks.mcp?.status() ?? [],
        mcpPresets: MCP_PRESETS,
        backup: backupView(phoenix),
        name: settings.get<string>("assistant.name", "Phoenix"),
        proactive: settings.proactive(),
        proactiveDefaults: PROACTIVE_DEFAULTS,
        screenApps: allowedScreenApps(settings),
        connectors: connectorList(phoenix),
        keys: keyStatus(),
        counts: Object.fromEntries(MEMORY_KINDS.map((k) => [k, memory.list(k).length])),
        skills: skills.list().length,
      };

    case "settings.set": {
      if (req.name !== undefined) settings.set("assistant.name", req.name.trim());
      if (req.proactive) phoenix.settings.updateProactive(sanitizeProactive(req.proactive));
      if (req.screenApps) {
        const bad = req.screenApps.find((a) => NEVER_APPS.test(a));
        if (bad) throw new Error(`Phoenix never operates ${bad} (banking, payment, password or system app)`);
        settings.set("screen.apps", [...new Set(req.screenApps.map((a) => a.trim()))]);
      }
      return { ok: true };
    }

    case "memory.list":
      return memory.list().map((m) => ({ ...m, text: show(m.text), subject: m.subject && show(m.subject) }));
    case "memory.add": {
      if ((req.kind === "person" || req.kind === "project") && !req.subject?.trim()) throw new Error("add a name for this person or project");
      const item = memory.add(store(req.text), { kind: req.kind as MemoryKind, subject: req.subject ? store(req.subject) : undefined });
      return { id: item.id };
    }
    case "memory.update":
      if (!memory.update(req.id, store(req.text), req.subject === undefined ? undefined : req.subject ? store(req.subject) : null)) {
        throw new Error(`no memory #${req.id}`);
      }
      return { ok: true };
    case "memory.remove":
      return { ok: memory.remove(req.id) };

    case "skills.list":
      return skills.list().map((s) => ({ ...s, steps: show(s.steps), description: show(s.description) }));
    case "skills.save": {
      const skill = skills.save({ id: req.id, name: req.name, description: store(req.description || req.name), steps: store(req.steps), enabled: req.enabled });
      return { id: skill.id };
    }
    case "skills.remove":
      return { ok: skills.remove(req.id) };

    case "connectors.set":
      setConnector(settings, req.id, req.enabled);
      return { connectors: connectorList(phoenix) };

    case "keys.set": {
      if (req.name === "anthropic") {
        const problem = checkApiKey(req.value.trim());
        if (problem) throw new Error(problem.replace(/Your ANTHROPIC_API_KEY/g, "This key").replace(/ Set it again:.*$/, ""));
      }
      storeSecret(req.name, req.value);
      hooks.keysChanged?.();
      return { keys: keyStatus() };
    }
    case "keys.remove":
      removeSecret(req.name);
      hooks.keysChanged?.();
      return { keys: keyStatus() };
    case "keys.test": {
      const key = findSecret(SECRETS.anthropic.env, SECRETS.anthropic.service);
      if (!key) return { ok: false, message: "No Anthropic key saved." };
      try {
        await new Anthropic({ apiKey: key.value, maxRetries: 0, timeout: 15_000 }).models.list({ limit: 1 });
        return { ok: true, message: "The Anthropic key works." };
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: "Anthropic rejected this key (expired or revoked)." };
        if (err instanceof Anthropic.APIConnectionError) return { ok: false, message: "Couldn't reach Anthropic. Check the internet connection." };
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }

    case "history.list":
      return sessions.list(200).map((s) => {
        const entries = transcript(s.messages, show);
        return {
          id: s.id,
          startedAt: s.createdAt,
          updatedAt: s.updatedAt,
          turns: s.turns,
          title: entries.find((e) => e.role === "you")?.text.slice(0, 90) ?? "(conversation)",
          preview: entries.filter((e) => e.role === "phoenix").at(-1)?.text.slice(0, 140) ?? "",
        };
      });
    case "history.get": {
      const s = sessions.get(req.id);
      if (!s) throw new Error("that conversation is gone");
      return { id: s.id, startedAt: s.createdAt, updatedAt: s.updatedAt, entries: transcript(s.messages, show) };
    }
    case "history.remove":
      return { ok: sessions.remove(req.id) };

    case "backup.status":
      return backupView(phoenix);
    case "usage": {
      const rows = phoenix.usage.recent(30);
      const since = (days: number) => rows.filter((r) => Date.parse(r.day) >= Date.now() - days * 86_400_000);
      const sum = (rs: typeof rows) => ({ cost: rs.reduce((s, r) => s + r.cost, 0), calls: rs.reduce((s, r) => s + r.calls, 0), cacheRate: cacheHitRate(rs) });
      return { today: sum(since(1)), week: sum(since(7)), month: sum(rows), byRoute: Object.fromEntries(["chat", "briefing", "screen"].map((route) => [route, sum(rows.filter((r) => r.route === route))])) };
    }
    case "backup.setup":
      setupBackupKey(settings, req.passphrase);
      createBackup(phoenix.cfg, settings, loadMasterKey(phoenix.cfg));
      return backupView(phoenix);
    case "backup.now":
      createBackup(phoenix.cfg, settings, loadMasterKey(phoenix.cfg));
      return backupView(phoenix);
    case "backup.settings":
      updateBackupSettings(settings, { ...(req.dir ? { dir: req.dir.trim() } : {}), ...(req.nightly !== undefined ? { nightly: req.nightly } : {}) });
      return backupView(phoenix);

    case "mcp.add": {
      const hub = needHub(hooks);
      const { op: _op, token, ...cfg } = req;
      return { connector: await hub.add(cfg, token), mcp: hub.status() };
    }
    case "mcp.remove":
      await needHub(hooks).remove(req.id);
      return { mcp: needHub(hooks).status() };
    case "mcp.set":
      await needHub(hooks).setEnabled(req.id, req.enabled);
      return { mcp: needHub(hooks).status() };
    case "mcp.reconnect":
      await needHub(hooks).reconnect(req.id);
      return { mcp: needHub(hooks).status() };
  }
}

function needHub(hooks: AdminHooks): McpHub {
  if (!hooks.mcp) throw new Error("connectors are only available while the Phoenix core is running");
  return hooks.mcp;
}

function backupView(phoenix: Phoenix) {
  const s = backupSettings(phoenix.settings);
  return { ready: !!s.publicKey, dir: s.dir, nightly: s.nightly, keep: s.keep, lastBackup: s.lastBackup ?? null, lastFile: s.lastFile ?? null, lastError: s.lastError ?? null };
}

function connectorList(phoenix: Phoenix) {
  const off = disabledConnectors(phoenix.settings);
  return CONNECTORS.map((c) => ({
    id: c.id, name: c.name, description: c.description, enabled: !off.has(c.id), onMac: !!c.onMac,
    status: c.status ?? null, tools: c.tools,
  }));
}

function keyStatus() {
  return (Object.keys(SECRETS) as SecretName[]).map((name) => {
    const found = findSecret(SECRETS[name].env, SECRETS[name].service);
    return { name, label: SECRETS[name].label.replace(" (Phoenix)", ""), saved: !!found, source: found?.source ?? null,
      hint: found ? describeKey(found.value) : null };
  });
}

function sanitizeProactive(p: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (typeof p.enabled === "boolean") out.enabled = p.enabled;
  for (const k of ["briefTime", "quietStart", "quietEnd"]) if (typeof p[k] === "string" && hhmm.test(p[k] as string)) out[k] = p[k];
  if (p.briefDays === "daily" || p.briefDays === "weekdays") out.briefDays = p.briefDays;
  if (Number.isInteger(p.meetingLead) && (p.meetingLead as number) >= 1 && (p.meetingLead as number) <= 120) out.meetingLead = p.meetingLead;
  if (Number.isInteger(p.maxPerDay) && (p.maxPerDay as number) >= 0 && (p.maxPerDay as number) <= 100) out.maxPerDay = p.maxPerDay;
  return out;
}

export interface TranscriptEntry {
  role: "you" | "phoenix" | "action";
  text: string;
}

/** A conversation as the user saw it: their words, Phoenix's replies, and actions taken. */
export function transcript(messages: History, show: (s: string) => string): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        const text = m.content.replace(/<context>[\s\S]*?<\/context>\s*/g, "").trim();
        if (text) out.push({ role: "you", text: show(text) });
      }
      continue;
    }
    if (typeof m.content === "string") {
      if (m.content.trim()) out.push({ role: "phoenix", text: show(m.content.trim()) });
      continue;
    }
    for (const b of m.content ?? []) {
      if (b.type === "text" && b.text.trim()) out.push({ role: "phoenix", text: show(b.text.trim()) });
      else if (b.type === "server_tool_use" && b.name === "web_search") out.push({ role: "action", text: "Searched the web" });
      else if (b.type === "tool_use") out.push({ role: "action", text: ACTION_LABEL[b.name] ?? b.name.replace(/_/g, " ") });
    }
  }
  // Merge consecutive replies into one bubble.
  return out.reduce<TranscriptEntry[]>((acc, e) => {
    const last = acc.at(-1);
    if (last && last.role === e.role && e.role !== "action") last.text += `\n\n${e.text}`;
    else acc.push({ ...e });
    return acc;
  }, []);
}

const ACTION_LABEL: Record<string, string> = {
  web_search: "Searched the web",
  calendar_events: "Checked the calendar",
  calendar_add_event: "Added a calendar event",
  reminders_list: "Checked reminders",
  reminders_add: "Added a reminder",
  reminders_complete: "Completed a reminder",
  contacts_search: "Looked up a contact",
  messages_send: "Sent an iMessage",
  apple_notes_create: "Created an Apple Note",
  app_open: "Opened an app",
  screen_act: "Used an app on screen",
  memory_remember: "Saved to memory",
  memory_search: "Searched memory",
  skill_save: "Saved a skill",
  outbox_send: "Put an email in the outbox",
};
