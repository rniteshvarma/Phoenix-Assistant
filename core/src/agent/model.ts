import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../config.ts";
import { ClaudeScreenModel } from "../screen/model.ts";
import type { ScreenModel } from "../screen/session.ts";

export interface ModelRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
  /** Server-side web search; on unless false. */
  webSearch?: boolean;
  /** Who the user is: changes rarely, so it is cached right after the system prompt. */
  profile?: string;
  /** Called with each text fragment as it streams, so the UI and voice can start early. */
  onText?: (delta: string) => void;
}

export interface ModelTurn {
  stopReason: string | null;
  /** Assistant content, appended unchanged to the conversation history. */
  content: Anthropic.Beta.BetaContentBlockParam[];
  refusal?: string;
}

export interface ModelClient {
  readonly name: string;
  next(req: ModelRequest): Promise<ModelTurn>;
  /** A model for operating the screen (computer use), if this client has one. */
  screen?(): ScreenModel;
}

/** Server-side web search: runs on Anthropic's side, read-only, results come back as content. */
const WEB_SEARCH = { type: "web_search_20260209", name: "web_search", max_uses: 5 } as const;

/** Claude Opus 5.5 as Phoenix's planner. The tool loop runs here; tools execute on the user's devices. */
export class ClaudeModel implements ModelClient {
  readonly name = MODELS.planner;
  #client: Anthropic;

  constructor(client = new Anthropic()) {
    this.#client = client;
  }

  screen(): ScreenModel {
    return new ClaudeScreenModel(this.#client);
  }

  async next(req: ModelRequest): Promise<ModelTurn> {
    for (let attempt = 0; ; attempt += 1) {
      const stream = this.#client.beta.messages.stream({
        model: MODELS.planner,
        max_tokens: 64000,
        output_config: { effort: "medium" },
        // On a safety-classifier refusal, let the API re-run the turn on a fallback model.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // System prompt and tools are byte-stable, so this prefix stays cached.
        system: [
          { type: "text", text: req.system, cache_control: { type: "ephemeral" } },
          ...(req.profile ? [{ type: "text" as const, text: req.profile, cache_control: { type: "ephemeral" as const } }] : []),
        ],
        tools: [...req.tools.map((t) => ({ ...t, eager_input_streaming: true })), ...(req.webSearch === false ? [] : [WEB_SEARCH])],
        messages: req.messages,
      });
      if (req.onText) stream.on("text", (delta) => req.onText!(delta));

      let response: Anthropic.Beta.BetaMessage;
      try {
        response = await stream.finalMessage();
      } catch (err) {
        // With eager input streaming, an unparseable tool input (or a dropped connection)
        // surfaces here as a non-API error: re-issue the turn a couple of times.
        if (err instanceof Anthropic.APIError || attempt >= 2) throw err;
        continue;
      }
      return {
        stopReason: response.stop_reason,
        content: response.content,
        refusal:
          response.stop_reason === "refusal"
            ? (response.stop_details?.explanation ?? "The model declined this request.")
            : undefined,
      };
    }
  }
}
