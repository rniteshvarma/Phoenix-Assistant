import { randomUUID } from "node:crypto";
import http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import type { ApprovalDecision, Approver } from "../agent/loop.ts";
import type { ModelClient } from "../agent/model.ts";
import type { Phoenix } from "../phoenix.ts";
import { TIER_LABEL } from "../policy/tiers.ts";
import { KIND_LABEL, type Kind } from "../privacy/detect.ts";
import type { SpeechSynth } from "../voice/tts.ts";
import { Inbound } from "./protocol.ts";
import { tokenMatches } from "./token.ts";

export interface GatewayOptions {
  /** Loopback only in Phase 1. Phase 3 adds Tailscale + device certificates for the iPhone. */
  host?: string;
  port: number;
  token: string;
  /** Creates the model for each request (Claude, or the scripted model offline). */
  modelFactory: (request: string) => ModelClient;
  offline?: boolean;
  /** Cloud voice for spoken replies; null/undefined means the app uses its on-device voice. */
  speech?: SpeechSynth | null;
  log?: (line: string) => void;
}

export interface Gateway {
  port: number;
  close(): Promise<void>;
}

export function startGateway(phoenix: Phoenix, opts: GatewayOptions): Promise<Gateway> {
  const log = opts.log ?? (() => {});
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "phoenix" }));
      return;
    }
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1_000_000 });

  server.on("upgrade", (req, socket, head) => {
    // Browsers always send Origin; native apps don't. Refusing it stops any website
    // from talking to Phoenix through localhost.
    if (req.headers.origin) return refuse(socket, 403, "Forbidden");
    if (!tokenMatches(opts.token, req.headers.authorization)) return refuse(socket, 401, "Unauthorized");
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function onConnection(ws: WebSocket): void {
    const linkId = randomUUID();
    let deviceName = "app";
    let sessionId: string | undefined;
    let running: AbortController | null = null;
    const approvals = new Map<string, (d: ApprovalDecision) => void>();
    const speechAbort = new AbortController();
    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
    };

    ws.on("message", (raw) => {
      let parsed;
      try {
        parsed = Inbound.safeParse(JSON.parse(raw.toString()));
      } catch {
        return send({ type: "error", message: "invalid JSON" });
      }
      if (!parsed.success) return send({ type: "error", message: "invalid message" });
      const msg = parsed.data;

      switch (msg.type) {
        case "hello":
          deviceName = msg.device;
          phoenix.devices.attach({ id: linkId, name: deviceName, capabilities: new Set(msg.capabilities), send });
          log(`connected: ${deviceName} [${msg.capabilities.join(", ")}]`);
          send({
            type: "ready",
            device: deviceName,
            model: opts.offline ? "offline" : "claude",
            offline: !!opts.offline,
            tts: opts.speech ? opts.speech.kind : "device",
          });
          break;

        case "speak": {
          const speech = opts.speech;
          if (!speech) return send({ type: "speech.error", id: msg.id, message: "no Phoenix voice configured" });
          speech
            // A cloud voice never receives protected values; the local voice runs on this Mac.
            .synthesize(speech.kind === "cloud" ? phoenix.vault.speakable(msg.text) : msg.text, speechAbort.signal)
            .then(({ audio, mime }) => send({ type: "speech", id: msg.id, mime, audio: audio.toString("base64") }))
            .catch((err) => {
              if (!speechAbort.signal.aborted) {
                log(`voice error: ${errorText(err)}`);
                send({ type: "speech.error", id: msg.id, message: errorText(err) });
              }
            });
          break;
        }

        case "request": {
          if (running) return send({ type: "error", message: "Phoenix is still working on the last request" });
          if (msg.newSession) sessionId = undefined;
          const controller = new AbortController();
          running = controller;
          const requestId = msg.id;
          const approver: Approver = {
            review: (proposal, _tool, signal) =>
              new Promise<ApprovalDecision>((resolve) => {
                approvals.set(proposal.id, resolve);
                send({
                  type: "approval.request",
                  requestId,
                  proposal: {
                    id: proposal.id,
                    tool: proposal.tool,
                    tier: proposal.tier,
                    tierLabel: TIER_LABEL[proposal.tier],
                    summary: proposal.summary,
                    input: proposal.display,
                    payloadHash: proposal.payloadHash,
                    stage: proposal.stage,
                    protectedKinds: proposal.protectedKinds.map((k) => KIND_LABEL[k as Kind] ?? k),
                  },
                });
                signal?.addEventListener(
                  "abort",
                  () => {
                    if (approvals.delete(proposal.id)) resolve({ decision: "reject" });
                  },
                  { once: true },
                );
              }),
          };

          let model: ModelClient;
          try {
            model = opts.modelFactory(msg.text);
          } catch (err) {
            running = null;
            return send({ type: "done", requestId, status: "failed", text: errorText(err) });
          }

          phoenix
            .ask(msg.text, {
              model,
              approver,
              sessionId,
              channel: msg.channel,
              signal: controller.signal,
              onEvent: (event) => send({ type: "event", requestId, event }),
            })
            .then((r) => {
              sessionId = r.sessionId;
              send({ type: "done", requestId, status: r.status, text: r.text, sessionId: r.sessionId });
            })
            .catch((err) => send({ type: "done", requestId, status: "failed", text: errorText(err) }))
            .finally(() => {
              if (running === controller) running = null;
            });
          break;
        }

        case "approval": {
          const resolve = approvals.get(msg.proposalId);
          if (!resolve) return send({ type: "error", message: "no such pending approval" });
          approvals.delete(msg.proposalId);
          resolve(
            msg.decision === "approve" ? { decision: "approve" } : { decision: "reject", feedback: msg.feedback },
          );
          break;
        }

        case "cancel":
          running?.abort();
          break;

        case "tool.result":
          phoenix.devices.settle(
            linkId,
            msg.callId,
            msg.ok ? { ok: true, output: msg.output ?? "" } : { ok: false, error: msg.error ?? "failed" },
          );
          break;
      }
    });

    ws.on("close", () => {
      running?.abort();
      speechAbort.abort();
      for (const resolve of approvals.values()) resolve({ decision: "reject" });
      approvals.clear();
      phoenix.devices.detach(linkId);
      log(`disconnected: ${deviceName}`);
    });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

function refuse(socket: Duplex, code: number, text: string): void {
  socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
