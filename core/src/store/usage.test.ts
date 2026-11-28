import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import { ClaudeModel } from "../agent/model.ts";
import { say } from "../agent/scripted.ts";
import { createPhoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { cacheHitRate, costUSD } from "./usage.ts";

function fakeClient(captured: Record<string, unknown>[]) {
  return {
    beta: {
      messages: {
        stream: (params: Record<string, unknown>) => {
          captured.push(params);
          return {
            on() {},
            finalMessage: async () => ({
              stop_reason: "end_turn", model: "claude-opus-5-5", content: [{ type: "text", text: "Hi" }],
              usage: { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 9000, cache_creation_input_tokens: 300 },
            }),
          };
        },
      },
    },
  } as unknown as Anthropic;
}

test("requests cache the conversation as well as the system prompt and profile; effort is per job", async () => {
  const captured: Record<string, unknown>[] = [];
  const chat = new ClaudeModel(fakeClient(captured));
  const turn = await chat.next({ system: "sys", profile: "<user_profile>x</user_profile>", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.deepEqual(captured[0]!.cache_control, { type: "ephemeral" }, "automatic caching for the conversation");
  const system = captured[0]!.system as Array<{ cache_control?: unknown }>;
  assert.equal(system.filter((b) => b.cache_control).length, 2, "system prompt and profile stay explicitly cached");
  assert.deepEqual(captured[0]!.output_config, { effort: "medium" });
  assert.deepEqual(turn.usage, { input: 120, output: 40, cacheRead: 9000, cacheWrite: 300 });

  await new ClaudeModel(fakeClient(captured), { effort: "low" }).next({ system: "s", messages: [{ role: "user", content: "brief" }], tools: [] });
  assert.deepEqual(captured[1]!.output_config, { effort: "low" });
});

test("usage is recorded per day and route, with estimated cost and cache rate", async () => {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  try {
    const model = {
      name: "claude-opus-5-5",
      next: async () => ({ ...say("ok"), usage: { input: 1000, output: 200, cacheRead: 30_000, cacheWrite: 2000 }, model: "claude-opus-5-5" }),
    };
    await phoenix.ask("hello", { model, approver: new FakeApprover([]) });
    await phoenix.ask("brief me", { model, approver: new FakeApprover([]), readOnly: true });
    const rows = phoenix.usage.recent(1);
    assert.deepEqual(rows.map((r) => [r.route, r.calls]).sort(), [["briefing", 1], ["chat", 1]]);
    // 1000×$4 + 200×$20 + 30000×$0.20 + 2000×$5 per million = $0.024
    assert.equal(Math.round(costUSD("claude-opus-5-5", rows[0]!) * 1000), 24);
    assert.equal(Math.round(cacheHitRate(rows) * 100), 91);
  } finally {
    phoenix.close();
    cleanup();
  }
});
