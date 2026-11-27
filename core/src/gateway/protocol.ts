import { z } from "zod";

/**
 * Messages from apps (Mac now, iPhone later) to the Phoenix core over the gateway.
 * Everything inbound is validated; unknown or malformed messages are rejected.
 */
export const Inbound = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    device: z.string().min(1).max(64),
    capabilities: z.array(z.string().max(64)).max(20).default([]),
  }),
  z.object({
    type: z.literal("request"),
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(4000),
    channel: z.enum(["voice", "text"]).default("text"),
    newSession: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("approval"),
    proposalId: z.string().min(1).max(64),
    decision: z.enum(["approve", "reject"]),
    feedback: z.string().max(2000).optional(),
  }),
  z.object({ type: z.literal("cancel") }),
  z.object({
    type: z.literal("speak"),
    id: z.string().min(1).max(64),
    text: z.string().min(1).max(1500),
  }),
  z.object({
    type: z.literal("tool.result"),
    callId: z.string().min(1).max(64),
    ok: z.boolean(),
    output: z.string().max(200_000).optional(),
    error: z.string().max(2000).optional(),
  }),
]);

export type InboundMessage = z.infer<typeof Inbound>;

/*
 * Outbound (core → app), for reference:
 *  { type: "ready", device, model, offline, tts: "local" | "cloud" | "device" }
 *  { type: "speech", id, mime, audio: base64 } | { type: "speech.error", id, message }
 *  { type: "event", requestId, event: AgentEvent }
 *  { type: "approval.request", requestId, proposal: { id, tool, tier, tierLabel, summary, input, payloadHash } }
 *  { type: "tool.call", callId, tool, input }
 *  { type: "done", requestId, status, text, sessionId }
 *  { type: "error", message }
 */
