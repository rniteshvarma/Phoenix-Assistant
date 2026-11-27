import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import WebSocket from "ws";
import { ScriptedModel, callTool, demoScript, lastToolResult, say } from "../agent/scripted.ts";
import type { ModelClient } from "../agent/model.ts";
import { createPhoenix } from "../phoenix.ts";
import { tempConfig } from "../testing.ts";
import type { SpeechSynth } from "../voice/tts.ts";
import { loadSecret, speechFromEnvironment } from "../voice/tts.ts";
import { startGateway } from "./server.ts";

const TOKEN = "a".repeat(64);

async function withGateway(
  modelFactory: (request: string) => ModelClient,
  fn: (url: string, ctx: { outboxDir: string }) => Promise<void>,
  speech: SpeechSynth | null = null,
) {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  const gateway = await startGateway(phoenix, { port: 0, token: TOKEN, modelFactory, offline: true, speech });
  try {
    await fn(`ws://127.0.0.1:${gateway.port}`, { outboxDir: cfg.outboxDir });
  } finally {
    await gateway.close();
    phoenix.close();
    cleanup();
  }
}

function connect(url: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }) {
  return new WebSocket(url, { headers });
}

function rejected(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0)));
}

/** Collect messages and answer approvals / tool calls with the given handlers. */
function client(ws: WebSocket, handlers: { onApproval?: (p: any) => object; onToolCall?: (m: any) => object } = {}) {
  const messages: any[] = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    messages.push(msg);
    if (msg.type === "approval.request" && handlers.onApproval) {
      ws.send(JSON.stringify({ type: "approval", proposalId: msg.proposal.id, ...handlers.onApproval(msg.proposal) }));
    }
    if (msg.type === "tool.call" && handlers.onToolCall) {
      ws.send(JSON.stringify({ type: "tool.result", callId: msg.callId, ...handlers.onToolCall(msg) }));
    }
  });
  const waitFor = (pred: (m: any) => boolean) =>
    new Promise<any>((resolve) => {
      const check = () => {
        const hit = messages.find(pred);
        if (hit) return resolve(hit);
        setTimeout(check, 5);
      };
      check();
    });
  return { messages, waitFor };
}

test("gateway refuses a missing/wrong token and any browser Origin", async () => {
  await withGateway(() => new ScriptedModel([]), async (url) => {
    assert.equal(await rejected(connect(url, {})), 401);
    assert.equal(await rejected(connect(url, { authorization: `Bearer ${"b".repeat(64)}` })), 401);
    assert.equal(
      await rejected(connect(url, { authorization: `Bearer ${TOKEN}`, origin: "https://evil.example" })),
      403,
    );
  });
});

test("gateway runs a request end to end: streaming events, approval card, outcome", async () => {
  await withGateway((req) => new ScriptedModel(demoScript(req)), async (url, { outboxDir }) => {
    const ws = connect(url);
    const c = client(ws, { onApproval: () => ({ decision: "approve" }) });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", device: "test-mac", capabilities: [] }));
    await c.waitFor((m) => m.type === "ready");

    ws.send(JSON.stringify({ type: "request", id: "r1", text: "save a note", channel: "voice" }));
    const done = await c.waitFor((m) => m.type === "done");
    assert.equal(done.status, "completed");
    const card = c.messages.find((m) => m.type === "approval.request");
    assert.equal(card.proposal.tool, "outbox_send");
    assert.match(card.proposal.tierLabel, /T2/);
    assert.equal(card.proposal.payloadHash.length, 64);
    assert.ok(c.messages.some((m) => m.type === "event" && m.event.type === "assistant.text"));
    assert.equal(fs.readdirSync(outboxDir).length, 1);
    ws.close();
  });
});

test("rejecting on the Mac means nothing is sent; garbage messages are refused", async () => {
  await withGateway((req) => new ScriptedModel(demoScript(req)), async (url, { outboxDir }) => {
    const ws = connect(url);
    const c = client(ws, { onApproval: () => ({ decision: "reject", feedback: "not now" }) });
    await new Promise((r) => ws.on("open", r));
    ws.send("not json");
    ws.send(JSON.stringify({ type: "approval", proposalId: "nope", decision: "approve" }));
    ws.send(JSON.stringify({ type: "request", id: "r1", text: "save a note" }));
    await c.waitFor((m) => m.type === "done");
    assert.equal(fs.readdirSync(outboxDir).length, 0);
    assert.equal(c.messages.filter((m) => m.type === "error").length, 2);
    ws.close();
  });
});

test("calendar request is answered by the connected Mac app over the gateway", async () => {
  let toolResult = "";
  const model = () =>
    new ScriptedModel([
      () => callTool("Checking.", "calendar_events", { from: "2026-11-27T00:00:00+05:30", to: "2026-11-28T00:00:00+05:30" }),
      (m) => ((toolResult = lastToolResult(m)), say("You have standup at 10.")),
    ]);
  await withGateway(model, async (url) => {
    const ws = connect(url);
    const c = client(ws, { onToolCall: () => ({ ok: true, output: "10:00–10:30 Standup" }) });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", device: "mac", capabilities: ["calendar.read"] }));
    await c.waitFor((m) => m.type === "ready");
    ws.send(JSON.stringify({ type: "request", id: "r1", text: "what's on tomorrow?" }));
    const done = await c.waitFor((m) => m.type === "done");
    assert.equal(done.text, "You have standup at 10.");
    assert.match(toolResult, /Standup/);
    ws.close();
  });
});

test("disconnecting mid-approval cancels the task safely", async () => {
  await withGateway((req) => new ScriptedModel(demoScript(req)), async (url, { outboxDir }) => {
    const ws = connect(url);
    const c = client(ws);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "request", id: "r1", text: "save a note" }));
    await c.waitFor((m) => m.type === "approval.request");
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(fs.readdirSync(outboxDir).length, 0);
  });
});

test("speak: cloud voice audio comes back base64; errors are reported, not thrown", async () => {
  const fakeVoice: SpeechSynth = {
    kind: "cloud",
    label: "fake",
    async synthesize(text) {
      if (text.includes("fail")) throw new Error("ElevenLabs 401: invalid key");
      return { audio: Buffer.from(`MP3:${text}`), mime: "audio/mpeg" };
    },
  };
  await withGateway(() => new ScriptedModel([]), async (url) => {
    const ws = connect(url);
    const c = client(ws);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", device: "mac", capabilities: [] }));
    const ready = await c.waitFor((m) => m.type === "ready");
    assert.equal(ready.tts, "cloud");

    ws.send(JSON.stringify({ type: "speak", id: "s1", text: "Hello there." }));
    const speech = await c.waitFor((m) => m.type === "speech" && m.id === "s1");
    assert.equal(Buffer.from(speech.audio, "base64").toString(), "MP3:Hello there.");
    assert.equal(speech.mime, "audio/mpeg");

    ws.send(JSON.stringify({ type: "speak", id: "s2", text: "please fail" }));
    const err = await c.waitFor((m) => m.type === "speech.error" && m.id === "s2");
    assert.match(err.message, /401/);
    ws.close();
  }, fakeVoice);
});

test("speak without a cloud voice tells the app to use its on-device voice", async () => {
  await withGateway(() => new ScriptedModel([]), async (url) => {
    const ws = connect(url);
    const c = client(ws);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "hello", device: "mac", capabilities: [] }));
    assert.equal((await c.waitFor((m) => m.type === "ready")).tts, "device");
    ws.send(JSON.stringify({ type: "speak", id: "s1", text: "Hi." }));
    assert.equal((await c.waitFor((m) => m.type === "speech.error")).id, "s1");
    ws.close();
  });
});

test("voice config: local Kokoro by default, ElevenLabs only when chosen, Apple when asked", () => {
  assert.equal(loadSecret("X_TEST_KEY", "phoenix-test-nonexistent-item", { X_TEST_KEY: " abc " }), "abc");
  const local = speechFromEnvironment({ ELEVENLABS_API_KEY: "k" }, "/tmp/x");
  assert.equal(local!.kind, "local", "a stray ElevenLabs key doesn't switch Phoenix to the cloud");
  assert.match(local!.label, /af_heart/);
  assert.match(speechFromEnvironment({ PHOENIX_VOICE: "af_bella" }, "/tmp/x")!.label, /af_bella/);
  assert.equal(speechFromEnvironment({ PHOENIX_TTS: "apple" }, "/tmp/x"), null);
  const cloud = speechFromEnvironment({ PHOENIX_TTS: "elevenlabs", ELEVENLABS_API_KEY: "k" }, "/tmp/x");
  assert.equal(cloud!.kind, "cloud");
  assert.match(cloud!.label, /r1KmysJdVYZjJCm4mL3b/);
});

test("local voice audio is 16-bit PCM WAV (half the size of float WAV)", async () => {
  const { toWav16 } = await import("../voice/kokoro.ts");
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 2]);
  const wav = toWav16(samples, 24000);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.readUInt16LE(34), 16, "bits per sample");
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + samples.length * 2);
  assert.equal(wav.readInt16LE(44 + 2 * 3), 32767);
  assert.equal(wav.readInt16LE(44 + 2 * 5), 32767, "clipped");
});
