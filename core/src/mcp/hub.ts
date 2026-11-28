import type Anthropic from "@anthropic-ai/sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import fs from "node:fs";
import path from "node:path";
import { Tier } from "../policy/tiers.ts";
import type { SettingsStore } from "../proactive/schedule.ts";
import { findServiceSecret, removeServiceSecret, storeServiceSecret } from "../security/secrets.ts";
import type { Tool, ToolRegistry } from "../tools/types.ts";

/**
 * Third-party connectors over MCP (Model Context Protocol). Each connector's tools become
 * Phoenix tools under the same rules as built-in ones:
 *  - tools the server marks read-only run freely; everything else asks the user first;
 *  - output is outside content (untrusted) and passes through the Privacy Shield;
 *  - inputs go to a third party, so protected details need the user's OK twice;
 *  - tokens live in the Keychain, never in settings or logs.
 * The user adds connectors in the Control Center; Phoenix never adds one by itself.
 */

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  /** stdio: the environment variable the token goes in (e.g. NOTION_TOKEN). http: sent as a Bearer token. */
  tokenEnv?: string;
  hasToken?: boolean;
  enabled: boolean;
  preset?: string;
  addedAt: number;
}

export interface McpToolInfo { name: string; title: string; tier: Tier; description: string }

export interface McpStatus extends McpServerConfig {
  status: "off" | "connecting" | "connected" | "error";
  error?: string;
  tools: McpToolInfo[];
}

/** Ready-made setups; the user can still edit everything before adding. */
export const MCP_PRESETS = [
  { preset: "github", name: "GitHub", transport: "http" as const, url: "https://api.githubcopilot.com/mcp/",
    tokenHelp: "A GitHub personal access token (github.com › Settings › Developer settings › Personal access tokens)." },
  { preset: "notion", name: "Notion", transport: "stdio" as const, command: "npx", args: ["-y", "@notionhq/notion-mcp-server"], tokenEnv: "NOTION_TOKEN",
    tokenHelp: "A Notion integration token (notion.so/my-integrations); share the pages it may use with that integration." },
];

const SETTINGS_KEY = "mcp.servers";
const secretService = (id: string) => `dev.phoenix.mcp.${id}`;
export const toolPrefix = (id: string) => `mcp_${id}_`;

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 16) || "conn";
}

interface Live { client?: Client; status: McpStatus["status"]; error?: string; tools: McpToolInfo[]; stderr: string[] }

export class McpHub {
  #registry: ToolRegistry;
  #settings: SettingsStore;
  #log: (line: string) => void;
  #live = new Map<string, Live>();
  /** Tests swap in an in-memory transport. */
  makeTransport: (cfg: McpServerConfig, token: string | undefined, stderr: string[]) => Transport = defaultTransport;
  readToken: (id: string) => string | undefined = (id) => findServiceSecret(secretService(id));

  constructor(opts: { registry: ToolRegistry; settings: SettingsStore; log?: (line: string) => void }) {
    this.#registry = opts.registry;
    this.#settings = opts.settings;
    this.#log = opts.log ?? (() => {});
  }

  list(): McpServerConfig[] {
    return this.#settings.get<McpServerConfig[]>(SETTINGS_KEY, []);
  }

  #save(list: McpServerConfig[]): void {
    this.#settings.set(SETTINGS_KEY, list);
  }

  status(): McpStatus[] {
    return this.list().map((c) => {
      const live = this.#live.get(c.id);
      return { ...c, status: c.enabled ? (live?.status ?? "connecting") : "off", error: live?.error, tools: live?.tools ?? [] };
    });
  }

  async startAll(): Promise<void> {
    await Promise.all(this.list().filter((c) => c.enabled).map((c) => this.#connect(c)));
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((c) => this.#disconnect(c.id)));
  }

  async add(input: Omit<McpServerConfig, "id" | "enabled" | "addedAt" | "hasToken">, token?: string): Promise<McpStatus> {
    const name = input.name.trim();
    if (!name) throw new Error("give the connector a name");
    if (input.transport === "http") {
      const u = new URL(input.url ?? "");
      if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname))) {
        throw new Error("connector URLs must use https (or http on this Mac)");
      }
    } else if (!input.command?.trim()) {
      throw new Error("give the command that starts the connector");
    }
    let id = slug(name);
    const taken = new Set(this.list().map((c) => c.id));
    for (let n = 2; taken.has(id); n += 1) id = `${slug(name).slice(0, 14)}${n}`;
    if (token?.trim()) storeServiceSecret(secretService(id), `Phoenix connector: ${name.replace(/["\\\n]/g, "")}`, token);
    const cfg: McpServerConfig = { ...input, name, id, enabled: true, hasToken: !!token?.trim(), addedAt: Date.now() };
    this.#save([...this.list(), cfg]);
    await this.#connect(cfg);
    return this.status().find((s) => s.id === id)!;
  }

  async remove(id: string): Promise<void> {
    await this.#disconnect(id);
    removeServiceSecret(secretService(id));
    this.#save(this.list().filter((c) => c.id !== id));
    this.#live.delete(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const list = this.list().map((c) => (c.id === id ? { ...c, enabled } : c));
    const cfg = list.find((c) => c.id === id);
    if (!cfg) throw new Error(`no connector "${id}"`);
    this.#save(list);
    if (enabled) await this.#connect(cfg);
    else await this.#disconnect(id);
  }

  async reconnect(id: string): Promise<void> {
    const cfg = this.list().find((c) => c.id === id);
    if (!cfg) throw new Error(`no connector "${id}"`);
    await this.#disconnect(id);
    if (cfg.enabled) await this.#connect(cfg);
  }

  async #disconnect(id: string): Promise<void> {
    this.#registry.removePrefix(toolPrefix(id));
    const live = this.#live.get(id);
    this.#live.set(id, { status: "off", tools: [], stderr: [] });
    await live?.client?.close().catch(() => {});
  }

  async #connect(cfg: McpServerConfig): Promise<void> {
    const stderr: string[] = [];
    const live: Live = { status: "connecting", tools: [], stderr };
    this.#live.set(cfg.id, live);
    try {
      const client = new Client({ name: "phoenix", version: "1.0.0" });
      const token = cfg.hasToken ? this.readToken(cfg.id) : undefined;
      await withTimeout(client.connect(this.makeTransport(cfg, token, stderr)), 45_000, "the connector didn't start in time");
      const { tools } = await withTimeout(client.listTools(), 30_000, "the connector didn't list its tools in time");
      live.client = client;
      live.tools = [];
      for (const t of tools) {
        const tool = toPhoenixTool(cfg, client, t);
        if (!tool) continue;
        this.#registry.add(tool);
        live.tools.push({ name: tool.name, title: t.title ?? t.annotations?.title ?? t.name, tier: tool.tier, description: t.description ?? "" });
      }
      live.status = "connected";
      this.#log(`connector ${cfg.name}: ${live.tools.length} tools`);
    } catch (err) {
      live.status = "error";
      const detail = stderr.join("").trim().split("\n").slice(-2).join(" ");
      live.error = `${err instanceof Error ? err.message : String(err)}${detail ? ` (${detail.slice(0, 200)})` : ""}`;
      this.#log(`connector ${cfg.name} failed: ${live.error}`);
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

function defaultTransport(cfg: McpServerConfig, token: string | undefined, stderr: string[]): Transport {
  if (cfg.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(cfg.url!), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    });
  }
  // Under launchd PATH is minimal: find npx/node next to the running Node.
  const nodeDir = path.dirname(process.execPath);
  const command = ["npx", "node"].includes(cfg.command!) && fs.existsSync(path.join(nodeDir, cfg.command!)) ? path.join(nodeDir, cfg.command!) : cfg.command!;
  const env: Record<string, string> = { ...getDefaultEnvironment(), PATH: `${nodeDir}:${process.env.PATH ?? "/usr/bin:/bin"}` };
  if (token && cfg.tokenEnv) env[cfg.tokenEnv] = token;
  const transport = new StdioClientTransport({ command, args: cfg.args ?? [], env, stderr: "pipe" });
  transport.stderr?.on("data", (d: Buffer) => {
    stderr.push(d.toString());
    if (stderr.length > 40) stderr.shift();
  });
  return transport;
}

type McpTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

function toPhoenixTool(cfg: McpServerConfig, client: Client, t: McpTool): Tool | null {
  const name = `${toolPrefix(cfg.id)}${t.name}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (t.inputSchema?.type !== "object") return null;
  const readOnly = t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint !== true;
  return {
    name,
    description: `[${cfg.name} connector${readOnly ? ", read-only" : ""}] ${t.description ?? t.title ?? t.name}`.slice(0, 1024),
    tier: readOnly ? Tier.Read : Tier.Act,
    untrustedOutput: true,
    leavesDevice: true,
    escalateWhenTainted: false,
    parse: (input) =>
      input && typeof input === "object" && !Array.isArray(input) ? { ok: true, value: input } : { ok: false, error: "input must be an object" },
    describe: (input) => {
      const args = JSON.stringify(input ?? {});
      return `${cfg.name}: ${t.title ?? t.annotations?.title ?? t.name} ${args.length > 160 ? `${args.slice(0, 157)}…` : args}`;
    },
    async run(input) {
      const r = await client.callTool({ name: t.name, arguments: input as Record<string, unknown> }, undefined, { timeout: 90_000 });
      const content = (r.content ?? []) as Array<{ type: string; text?: string; resource?: { text?: string; uri?: string } }>;
      const text = content
        .map((c) => (c.type === "text" ? c.text : c.type === "resource" ? (c.resource?.text ?? c.resource?.uri ?? "") : `[${c.type}]`))
        .filter(Boolean)
        .join("\n")
        .slice(0, 60_000);
      if (r.isError) throw new Error(text || `${cfg.name} reported an error`);
      return text || "(no output)";
    },
    inputSchema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  };
}
