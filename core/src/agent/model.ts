import Anthropic from "@anthropic-ai/sdk";
import { MODELS } from "../config.ts";

export interface ModelRequest {
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  tools: Anthropic.Beta.BetaTool[];
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
}

/** Claude Opus 5.5 as Phoenix's planner. Runs locally-hosted tool loop; tools execute on this Mac. */
export class ClaudeModel implements ModelClient {
  readonly name = MODELS.planner;
  #client: Anthropic;

  constructor(client = new Anthropic()) {
    this.#client = client;
  }

  async next(req: ModelRequest): Promise<ModelTurn> {
    const response = await this.#client.beta.messages.create({
      model: MODELS.planner,
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // On a safety-classifier refusal, let the API re-run the turn on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // The system prompt and tool list are stable, so cache them.
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      tools: req.tools,
      messages: req.messages,
    });
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
