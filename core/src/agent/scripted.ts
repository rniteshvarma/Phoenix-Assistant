import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelRequest, ModelTurn } from "./model.ts";

/**
 * A deterministic stand-in for Claude: used by tests and by `--offline` demos,
 * so the whole safety pipeline can be exercised without an API key.
 */
export type ScriptStep = (messages: ReadonlyArray<Anthropic.Beta.BetaMessageParam>) => ModelTurn;

export class ScriptedModel implements ModelClient {
  readonly name = "scripted (offline)";
  #steps: ScriptStep[];
  #index = 0;

  constructor(steps: ScriptStep[]) {
    this.#steps = steps;
  }

  async next(req: ModelRequest): Promise<ModelTurn> {
    const step = this.#steps[this.#index++];
    return step ? step(req.messages) : say("(offline script finished)");
  }
}

let counter = 0;

export function say(text: string): ModelTurn {
  return { stopReason: "end_turn", content: [{ type: "text", text }] };
}

export function callTool(text: string, name: string, input: Record<string, unknown>): ModelTurn {
  counter += 1;
  return {
    stopReason: "tool_use",
    content: [
      { type: "text", text },
      { type: "tool_use", id: `toolu_offline_${counter}`, name, input },
    ],
  };
}

/** Text of the most recent tool result in the conversation. */
export function lastToolResult(messages: ReadonlyArray<Anthropic.Beta.BetaMessageParam>): string {
  const last = messages.at(-1);
  if (!last?.content || typeof last.content === "string") return "";
  for (const block of last.content) {
    if (block.type === "tool_result") {
      return typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    }
  }
  return "";
}

/** Offline demo for the Phase 0 exit test: save a note (auto), then email it (needs approval). */
export function demoScript(request: string): ScriptStep[] {
  const title = request.length > 60 ? `${request.slice(0, 57)}...` : request;
  const body = `Saved by Phoenix from your request:\n\n> ${request}`;
  return [
    () =>
      callTool(
        "Plan: save this as a private note, then email a copy to you. The email needs your OK.",
        "notes_save",
        { title, body },
      ),
    () =>
      callTool("Note saved. Now preparing the email.", "outbox_send", {
        to: "me@example.com",
        subject: `Note: ${title}`,
        body,
      }),
    (messages) => {
      const r = lastToolResult(messages);
      if (r.includes("declined")) return say("Okay, I didn't send the email. The note is still saved.");
      if (r.includes("Not executed") || r.includes("Blocked")) return say(`The email was not sent: ${r}`);
      return say("Done. The note is saved and the email is in your local outbox (simulated send).");
    },
  ];
}
