import { renderContext } from "./agent/context.ts";
import { runTask, type AgentEvent, type Approver, type TaskOutcome } from "./agent/loop.ts";
import type { ModelClient } from "./agent/model.ts";
import { AuditLog } from "./audit/log.ts";
import { ensureDirs, type PhoenixConfig } from "./config.ts";
import { DeviceHub } from "./gateway/devices.ts";
import { ApprovalAuthority } from "./policy/approvals.ts";
import { PrivacyVault } from "./privacy/vault.ts";
import { SettingsStore } from "./proactive/schedule.ts";
import { PolicyEngine } from "./policy/engine.ts";
import { GuardedExecutor } from "./policy/executor.ts";
import { loadKeys } from "./security/keys.ts";
import { openDatabase } from "./store/db.ts";
import { MemoryStore } from "./store/memory.ts";
import { matchSkill, recall, renderProfile, renderRecall, renderSkillIndex } from "./memory/recall.ts";
import { SkillStore } from "./store/skills.ts";
import { disabledTools } from "./admin/connectors.ts";
import { SessionStore } from "./store/sessions.ts";
import { TaskStore } from "./store/tasks.ts";
import { BUILTIN_TOOLS } from "./tools/builtin.ts";
import { ToolRegistry, type Tool } from "./tools/types.ts";

export interface AskOptions {
  model: ModelClient;
  approver: Approver;
  /** Continue this conversation if it's still fresh; omit to start a new one. */
  sessionId?: string;
  channel?: "voice" | "text";
  onEvent?: (e: AgentEvent) => void;
  signal?: AbortSignal;
  /** Override the clock (tests). */
  now?: Date;
  /** Only allow read-only tools (used for automatic briefings). */
  readOnly?: boolean;
}

export interface AskResult extends TaskOutcome {
  sessionId: string;
}

/** Composition root: wires storage, security, policy, memory, devices and the agent together. */
export function createPhoenix(cfg: PhoenixConfig, opts: { tools?: Tool[] } = {}) {
  ensureDirs(cfg);
  const keys = loadKeys(cfg);
  const db = openDatabase(cfg.dbPath);
  const audit = new AuditLog(db, keys.dataKey);
  const tasks = new TaskStore(db, keys.dataKey);
  const sessions = new SessionStore(db, keys.dataKey);
  const memory = new MemoryStore(db, keys.dataKey);
  const devices = new DeviceHub();
  const settings = new SettingsStore(db);
  const vault = new PrivacyVault(db, keys.dataKey, keys.privacyKey);
  const registry = new ToolRegistry(opts.tools ?? BUILTIN_TOOLS);
  const skills = new SkillStore(db, keys.dataKey);
  // Connectors switched off in the Control Center: their tools are hidden and blocked.
  const policy = new PolicyEngine(registry, (tool) => disabledTools(settings).has(tool));
  const authority = new ApprovalAuthority(keys.hmacKey, { ttlMs: cfg.approvalTtlMs });
  const executor = new GuardedExecutor({
    registry,
    policy,
    authority,
    audit,
    cfg,
    services: { memory, devices, vault, settings, skills },
    vault,
  });
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return {
    cfg,
    audit,
    tasks,
    sessions,
    memory,
    devices,
    settings,
    skills,
    vault,
    registry,
    policy,
    authority,
    executor,

    /** Handle one user request, continuing a conversation when `sessionId` is given. */
    async ask(request: string, o: AskOptions): Promise<AskResult> {
      const session = sessions.resumeOrCreate(o.sessionId);
      // Privacy Shield: sensitive values become placeholders before anything reaches the model.
      // Memory: the profile (cached) plus only what's relevant to this request, picked on this Mac.
      const recalled = recall(memory, request);
      // The stable part (cached): the assistant's name, who the user is, and the skill index.
      const name = settings.get<string>("assistant.name", "Phoenix");
      const enabledSkills = skills.list().filter((s) => s.enabled);
      const profile =
        vault.protect(
          [
            name !== "Phoenix" ? `The user has named you "${name}". Introduce and refer to yourself as ${name}.` : "",
            renderProfile(recalled.profile),
            renderSkillIndex(enabledSkills),
          ].filter(Boolean).join("\n\n"),
        ).text || undefined;
      const skill = matchSkill(request, enabledSkills);
      const skillLines = skill
        ? [`A saved skill that may fit this request — "${skill.name}" (${skill.description}). Follow it if it fits:`, skill.steps]
        : [];
      const context = renderContext({
        now: o.now ?? new Date(),
        timeZone,
        recalled: [...renderRecall(recalled), ...skillLines],
        channel: o.channel ?? "text",
      });
      const safeRequest = vault.protect(request).text;
      const safeContext = vault.protect(context).text;
      const outcome = await runTask(
        { model: o.model, approver: o.approver, registry, policy, authority, executor, audit, tasks, vault, memory, maxSteps: cfg.maxSteps },
        safeRequest,
        { onEvent: o.onEvent, signal: o.signal, history: session.messages, context: safeContext, readOnly: o.readOnly, profile,
          webSearch: !disabledTools(settings).has("web_search") },
      );
      if (!o.readOnly && outcome.status !== "cancelled") {
        try {
          memory.addEpisode(episodeText(safeRequest, outcome.status, vault.protect(outcome.text).text));
        } catch {
          // never fail a request over its diary entry
        }
      }
      sessions.save(session.id, outcome.messages, session.turns + 1);
      return { ...outcome, sessionId: session.id };
    },

    close() {
      if (db.isOpen) db.close();
    },
  };
}

export type Phoenix = ReturnType<typeof createPhoenix>;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** One line for the diary of past requests (already protected). */
export function episodeText(request: string, status: string, reply: string): string {
  return status === "completed"
    ? `Asked: "${clip(request, 200)}" → ${clip(reply, 240) || "done"}`
    : `Asked: "${clip(request, 200)}" → not finished (${status}): ${clip(reply, 160)}`;
}
