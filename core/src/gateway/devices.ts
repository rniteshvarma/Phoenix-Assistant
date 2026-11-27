import { randomUUID } from "node:crypto";

/** A connected Phoenix app (Mac today, iPhone in Phase 3) that can run native actions. */
export interface DeviceLink {
  id: string;
  name: string;
  capabilities: ReadonlySet<string>;
  send(message: Record<string, unknown>): void;
}

interface PendingCall {
  linkId: string;
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Routes native actions (e.g. reading the calendar with EventKit) to a connected app
 * that advertised the capability, and waits for its answer.
 */
export class DeviceHub {
  #links = new Map<string, DeviceLink>();
  #pending = new Map<string, PendingCall>();

  attach(link: DeviceLink): void {
    this.#links.set(link.id, link);
  }

  detach(linkId: string): void {
    this.#links.delete(linkId);
    for (const [callId, call] of this.#pending) {
      if (call.linkId === linkId) {
        clearTimeout(call.timer);
        this.#pending.delete(callId);
        call.reject(new Error("the Phoenix app disconnected"));
      }
    }
  }

  /** Send a message to every connected app with this capability; returns how many got it. */
  broadcast(capability: string, message: Record<string, unknown>): number {
    let sent = 0;
    for (const link of this.#links.values()) {
      if (link.capabilities.has(capability)) {
        link.send(message);
        sent += 1;
      }
    }
    return sent;
  }

  has(capability: string): boolean {
    return [...this.#links.values()].some((l) => l.capabilities.has(capability));
  }

  call(capability: string, tool: string, input: unknown, timeoutMs = 20_000): Promise<string> {
    const link = [...this.#links.values()].find((l) => l.capabilities.has(capability));
    if (!link) {
      return Promise.reject(
        new Error(`this needs the Phoenix Mac app (capability "${capability}"), which isn't connected`),
      );
    }
    const callId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(callId);
        reject(new Error(`${link.name} didn't answer in time`));
      }, timeoutMs);
      this.#pending.set(callId, { linkId: link.id, resolve, reject, timer });
      link.send({ type: "tool.call", callId, tool, input });
    });
  }

  /** Deliver a device's answer. Ignored unless the call was sent to that same device. */
  settle(linkId: string, callId: string, result: { ok: true; output: string } | { ok: false; error: string }): void {
    const call = this.#pending.get(callId);
    if (!call || call.linkId !== linkId) return;
    clearTimeout(call.timer);
    this.#pending.delete(callId);
    if (result.ok) call.resolve(result.output);
    else call.reject(new Error(result.error));
  }
}
