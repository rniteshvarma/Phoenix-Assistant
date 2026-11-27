import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTurn } from "../agent/model.ts";
import { ScriptedModel, callTool, say } from "../agent/scripted.ts";
import { createPhoenix, type Phoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { NEVER_APPS, linesToRedact, runScreenSession, type ScreenModel } from "./session.ts";

function setup() {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  return { phoenix, done: () => (phoenix.close(), cleanup()) };
}

let n = 0;
const act = (name: string, input: Record<string, unknown> = {}) =>
  ({ type: "tool_use", id: `toolu_s${++n}`, name, toolset_name: "computer", input }) as unknown as Anthropic.Beta.BetaContentBlockParam;
const turn = (...content: Anthropic.Beta.BetaContentBlockParam[]): ModelTurn => ({ stopReason: "tool_use", content });
const confirmStep = (summary: string) =>
  ({ type: "tool_use", id: `toolu_s${++n}`, name: "confirm_step", input: { summary } }) as unknown as Anthropic.Beta.BetaContentBlockParam;

/** Plays back fixed turns and keeps every request it got, to inspect the tool results. */
class ScriptedScreen implements ScreenModel {
  readonly name = "scripted screen";
  requests: Anthropic.Beta.BetaMessageParam[][] = [];
  #turns: ModelTurn[];
  constructor(turns: ModelTurn[]) {
    this.#turns = turns;
  }
  async next(req: { messages: Anthropic.Beta.BetaMessageParam[] }): Promise<ModelTurn> {
    this.requests.push(structuredClone(req.messages));
    return this.#turns.shift() ?? { stopReason: "end_turn", content: [{ type: "text", text: "Done." }] };
  }
  /** Tool results the model received after its i-th turn. */
  results(i: number): Anthropic.Beta.BetaToolResultBlockParam[] {
    const msg = this.requests[i + 1]?.at(-1);
    return (msg?.content as Anthropic.Beta.BetaToolResultBlockParam[]) ?? [];
  }
}

/** A pretend Mac app for the "screen" capability. */
function fakeScreen(phoenix: Phoenix, opts: { lines?: unknown[]; action?: (input: any) => string } = {}) {
  const calls: Array<{ tool: string; input: any }> = [];
  const link = {
    id: "mac-1",
    name: "Mac",
    capabilities: new Set(["screen"]),
    send(message: Record<string, unknown>) {
      if (message.type !== "tool.call") return;
      const tool = message.tool as string;
      const input = message.input as any;
      calls.push({ tool, input });
      let result: { ok: true; output: string } | { ok: false; error: string };
      try {
        const output =
          tool === "screen_begin" ? JSON.stringify({ app: input.app, width: 1512, height: 982 })
          : tool === "screen_capture" ? JSON.stringify({ id: "shot-1", width: 1512, height: 982, lines: opts.lines ?? [] })
          : tool === "screen_image" ? JSON.stringify({ mediaType: "image/jpeg", data: "AAAA" })
          : tool === "screen_action" ? (opts.action?.(input) ?? "OK")
          : "OK";
        result = { ok: true, output };
      } catch (err) {
        result = { ok: false, error: (err as Error).message };
      }
      setImmediate(() => phoenix.devices.settle(link.id, message.callId as string, result));
    },
  };
  phoenix.devices.attach(link);
  return calls;
}

test("screenshots: sensitive lines are blacked out on the Mac before Claude sees them", () => {
  const lines = [
    { text: "Ankit Sharma", box: [10, 10, 100, 30] },
    { text: "PAN ABCPE1234F", box: [10, 40, 200, 60] },
    { text: "Card 4111 1111 1111 1111", box: [10, 70, 300, 90] },
    { text: "See you at 6", box: [10, 100, 120, 120] },
  ] as const;
  assert.deepEqual(linesToRedact(lines as never).map((l) => l.text), ["PAN ABCPE1234F", "Card 4111 1111 1111 1111"]);
});

test("banking, payment, password and system apps are never operated", () => {
  for (const app of ["HDFC Bank", "PhonePe", "Google Pay", "1Password", "Passwords", "Terminal", "System Settings", "Zerodha Kite"]) {
    assert.equal(NEVER_APPS.test(app), true, app);
  }
  for (const app of ["WhatsApp", "iPhone Mirroring", "Safari", "Notes", "Spotify", "Incredible App"]) {
    assert.equal(NEVER_APPS.test(app), false, app);
  }
});

test("screen session: redacted screenshot, Return in a chat needs OK, typed placeholders need OK twice", async () => {
  const { phoenix, done } = setup();
  try {
    const calls = fakeScreen(phoenix, {
      lines: [{ text: "Ankit", box: [0, 0, 50, 20] }, { text: "+91 98765 43210", box: [0, 30, 150, 50] }],
    });
    const phone = phoenix.vault.protect("my number is 9876543210").text.match(/\[\[PHONE_\d+\]\]/)![0];
    const model = new ScriptedScreen([
      turn(act("screenshot")),
      turn(act("left_click", { coordinate: [200, 900] }), act("type", { text: `Call me on ${phone}` }), act("key", { text: "Return" })),
      turn(confirmStep("Send \"Call me on …\" to Ankit"), act("key", { text: "Return" })),
      { stopReason: "end_turn", content: [{ type: "text", text: "Sent it to Ankit." }] },
    ]);
    const asked: Array<{ summary: string; kinds?: string[] }> = [];
    const text = await runScreenSession("WhatsApp", "Tell Ankit to call me", {
      devices: phoenix.devices,
      vault: phoenix.vault,
      model,
      confirm: async (summary, kinds) => (asked.push({ summary, kinds }), true),
    });
    assert.equal(text, "Sent it to Ankit.");

    // 1) The screenshot: the phone line was blacked out, and the result echoes the toolset name.
    const image = calls.find((c) => c.tool === "screen_image")!;
    assert.deepEqual(image.input.redact, [[0, 30, 150, 50]]);
    const shot = model.results(0)[0]!;
    assert.equal((shot as any).toolset_name, "computer");
    assert.match(JSON.stringify(shot.content), /blanked out/);

    // 2) Typing a protected value asked twice (kinds given), was revealed only on the Mac,
    //    and Return without an approved step was refused.
    assert.deepEqual(asked[0]!.kinds, ["phone number"]);
    const typed = calls.find((c) => c.tool === "screen_action" && c.input.name === "type")!;
    assert.equal(typed.input.input.text, "Call me on 9876543210");
    const second = model.results(1);
    assert.equal(second[2]!.is_error, true);
    assert.match(JSON.stringify(second[2]!.content), /confirm_step/);

    // 3) After confirm_step, Return went through with armed=true.
    assert.match(asked[1]!.summary, /Send/);
    const keys = calls.filter((c) => c.tool === "screen_action" && c.input.name === "key");
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.input.armed, true);
    assert.equal(calls.at(-1)!.tool, "screen_end");
  } finally {
    done();
  }
});

test("screen session: payment buttons are refused, later actions skipped; taking over stops it", async () => {
  const { phoenix, done } = setup();
  try {
    const calls = fakeScreen(phoenix, {
      action: (i) => {
        if (i.name === "left_click" && i.input.coordinate[0] === 1) throw new Error("MONEY_STEP: Place order");
        if (i.name === "left_click" && i.input.coordinate[0] === 2) throw new Error("USER_TOOK_OVER");
        return "OK";
      },
    });
    const model = new ScriptedScreen([
      turn(act("left_click", { coordinate: [1, 1] }), act("type", { text: "x" })),
      turn(act("left_click", { coordinate: [2, 2] })),
    ]);
    const text = await runScreenSession("iPhone Mirroring", "Order my usual from Swiggy", {
      devices: phoenix.devices, vault: phoenix.vault, model, confirm: async () => true,
    });
    const first = model.results(0);
    assert.match(JSON.stringify(first[0]!.content), /never pays/);
    assert.match(JSON.stringify(first[1]!.content), /Not executed/);
    assert.equal(calls.filter((c) => c.input?.name === "type").length, 0);
    assert.match(text, /took over/);
    assert.equal(calls.at(-1)!.tool, "screen_end");
  } finally {
    done();
  }
});

test("screen_act: needs approval to start, only allowed apps, never banking apps", async () => {
  const { phoenix, done } = setup();
  try {
    fakeScreen(phoenix);
    const screen = new ScriptedScreen([]);
    const model = Object.assign(
      new ScriptedModel([
        () => callTool("Opening WhatsApp.", "screen_act", { app: "WhatsApp", goal: "Send hi to Ankit" }),
        () => callTool("Trying.", "screen_act", { app: "Photo Booth", goal: "Take a photo" }),
        () => callTool("Trying.", "screen_act", { app: "HDFC Bank", goal: "Check balance" }),
        () => say("Done."),
      ]),
      { screen: () => screen },
    );
    const approver = new FakeApprover([{ decision: "approve" }, { decision: "approve" }, { decision: "approve" }]);
    const outcome = await phoenix.ask("message Ankit", { model, approver });
    assert.equal(outcome.status, "completed");
    assert.equal(approver.seen[0]!.tool, "screen_act");
    assert.match(approver.seen[0]!.summary, /Use WhatsApp on your screen/);
    assert.equal(screen.requests.length, 1, "the WhatsApp session ran");
    const results = JSON.stringify(outcome.messages);
    assert.match(results, /isn't on the list of apps/);
    assert.match(results, /never operates HDFC Bank/);
  } finally {
    done();
  }
});
