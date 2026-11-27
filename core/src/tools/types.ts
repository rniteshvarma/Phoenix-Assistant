import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { PhoenixConfig } from "../config.ts";
import type { DeviceHub } from "../gateway/devices.ts";
import type { Tier } from "../policy/tiers.ts";
import type { MemoryStore } from "../store/memory.ts";
import type { PrivacyVault } from "../privacy/vault.ts";
import type { SettingsStore } from "../proactive/schedule.ts";
import type { ScreenModel } from "../screen/session.ts";

/** Shared services tools may use. */
export interface ToolServices {
  memory: MemoryStore;
  devices: DeviceHub;
  vault: PrivacyVault;
  settings: SettingsStore;
}

/** Per-run hooks for long tools that need the user part-way through (screen control). */
export interface ToolSession {
  /** Show an approval card; with `kinds` (protected details) it asks twice. True if approved. */
  confirm(summary: string, kinds?: string[]): Promise<boolean>;
  signal?: AbortSignal;
  /** A model able to drive the screen, if this run has one (not offline/scripted runs). */
  screenModel?: () => ScreenModel;
}

export interface ToolContext extends ToolServices {
  cfg: PhoenixConfig;
  taskId: string;
  session?: ToolSession;
}

/** What a skill author writes. */
export interface ToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  tier: Tier;
  schema: S;
  /** One line for approval cards and logs, e.g. `Send email to a@b.com: "Hi"`. */
  describe: (input: z.infer<S>) => string;
  /** True when the output contains outside content (notes, emails, web pages). */
  untrustedOutput?: boolean;
  /** True when running it sends its input off this Mac (email, forms, bookings…). Protected
   *  values in such an input need the user's approval twice. */
  leavesDevice?: boolean;
  /** For tools that send the user's words: once approved and run, keep them as a writing sample. */
  styleSample?: (input: z.infer<S>) => { subject: string; text: string } | null;
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<string>;
}

/** Type-erased tool as held by the registry; input is validated at every entry point. */
export interface Tool {
  name: string;
  description: string;
  tier: Tier;
  untrustedOutput: boolean;
  leavesDevice: boolean;
  styleSample?: (input: unknown) => { subject: string; text: string } | null;
  parse: (input: unknown) => { ok: true; value: unknown } | { ok: false; error: string };
  describe: (input: unknown) => string;
  run: (input: unknown, ctx: ToolContext) => Promise<string>;
  inputSchema: Anthropic.Beta.BetaTool.InputSchema;
}

export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): Tool {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(spec.name)) {
    throw new Error(`Invalid tool name: ${spec.name}`);
  }
  const parse = (input: unknown) => {
    const result = spec.schema.safeParse(input);
    return result.success
      ? ({ ok: true, value: result.data } as const)
      : ({ ok: false, error: z.prettifyError(result.error) } as const);
  };
  return {
    name: spec.name,
    description: spec.description,
    tier: spec.tier,
    untrustedOutput: spec.untrustedOutput ?? false,
    leavesDevice: spec.leavesDevice ?? false,
    styleSample: spec.styleSample ? (input) => spec.styleSample!(spec.schema.parse(input)) : undefined,
    parse,
    describe: (input) => spec.describe(spec.schema.parse(input)),
    run: (input, ctx) => spec.run(spec.schema.parse(input), ctx),
    inputSchema: toInputSchema(spec.schema),
  };
}

function toInputSchema(schema: z.ZodType): Anthropic.Beta.BetaTool.InputSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema) as Record<string, unknown>;
  if (json.type !== "object") throw new Error("Tool input schema must be a JSON object");
  return json as Anthropic.Beta.BetaTool.InputSchema;
}

export class ToolRegistry {
  #tools = new Map<string, Tool>();

  constructor(tools: Tool[]) {
    for (const tool of tools) {
      if (this.#tools.has(tool.name)) throw new Error(`Duplicate tool: ${tool.name}`);
      this.#tools.set(tool.name, tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  /** Tool definitions sent to the model, in a stable order (keeps the prompt cache warm). */
  apiTools(): Anthropic.Beta.BetaTool[] {
    return [...this.#tools.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
}
