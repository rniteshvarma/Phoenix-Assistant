import Anthropic from "@anthropic-ai/sdk";
import type { ModelTurn } from "../agent/model.ts";
import { MODELS } from "../config.ts";
import { usageFrom } from "../store/usage.ts";
import type { ScreenModel, ScreenModelRequest } from "./session.ts";

/** Claude Opus 5.5 with the computer use toolset (GA, no beta header needed for the toolset). */
export class ClaudeScreenModel implements ScreenModel {
  readonly name = MODELS.planner;
  #client: Anthropic;

  constructor(client: Anthropic) {
    this.#client = client;
  }

  async next(req: ScreenModelRequest): Promise<ModelTurn> {
    const stream = this.#client.beta.messages.stream({
      model: MODELS.planner,
      max_tokens: 32000,
      output_config: { effort: "medium" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [{ type: "text", text: req.system }],
      // Screenshots pile up in the conversation; cache everything up to the latest turn.
      cache_control: { type: "ephemeral" },
      tools: [{ type: "computer_toolset_20260801" }, ...req.tools],
      messages: req.messages,
    });
    const response = await stream.finalMessage();
    return {
      stopReason: response.stop_reason,
      usage: usageFrom(response.usage),
      model: response.model,
      content: response.content as Anthropic.Beta.BetaContentBlockParam[],
      refusal:
        response.stop_reason === "refusal"
          ? (response.stop_details?.explanation ?? "The model declined to do this on screen.")
          : undefined,
    };
  }
}
