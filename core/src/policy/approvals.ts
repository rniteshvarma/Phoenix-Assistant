import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { canonicalJson, deepFreeze, hashPayload } from "../security/canonical.ts";
import type { Tier } from "./tiers.ts";

/** Exactly what the user is asked to approve. The payload is frozen at creation. */
export interface ActionProposal {
  readonly id: string;
  readonly taskId: string;
  readonly toolUseId: string;
  readonly tool: string;
  readonly tier: Tier;
  readonly input: unknown;
  readonly payloadHash: string;
  readonly summary: string;
  readonly createdAt: number;
}

/** Proof that the user approved one specific payload. Single use, short-lived. */
export interface ApprovalToken {
  readonly proposalId: string;
  readonly taskId: string;
  readonly tool: string;
  readonly payloadHash: string;
  readonly expiresAt: number;
  readonly sig: string;
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Issues and checks approval tokens. `issue` must only be reachable from a human
 * approval path (terminal today; Face ID on iPhone/Mac later), never from the model.
 */
export class ApprovalAuthority {
  #key: Buffer;
  #ttlMs: number;
  #now: () => number;
  #used = new Set<string>();

  constructor(hmacKey: Buffer, opts: { ttlMs: number; now?: () => number }) {
    this.#key = hmacKey;
    this.#ttlMs = opts.ttlMs;
    this.#now = opts.now ?? Date.now;
  }

  propose(args: {
    taskId: string;
    toolUseId: string;
    tool: string;
    tier: Tier;
    input: unknown;
    summary: string;
  }): ActionProposal {
    const input = deepFreeze(structuredClone(args.input));
    return Object.freeze({
      id: randomUUID(),
      taskId: args.taskId,
      toolUseId: args.toolUseId,
      tool: args.tool,
      tier: args.tier,
      input,
      payloadHash: hashPayload(input),
      summary: args.summary,
      createdAt: this.#now(),
    });
  }

  issue(proposal: ActionProposal): ApprovalToken {
    if (hashPayload(proposal.input) !== proposal.payloadHash) {
      throw new Error("Proposal payload changed after it was shown to the user");
    }
    const unsigned = {
      proposalId: proposal.id,
      taskId: proposal.taskId,
      tool: proposal.tool,
      payloadHash: proposal.payloadHash,
      expiresAt: this.#now() + this.#ttlMs,
    };
    return Object.freeze({ ...unsigned, sig: this.#sign(unsigned) });
  }

  /** Called by the executor right before running a gated tool. Consumes the token on success. */
  verify(
    token: ApprovalToken,
    call: { tool: string; taskId: string; input: unknown },
  ): VerifyResult {
    const { sig, ...unsigned } = token;
    if (!this.#sigMatches(sig, this.#sign(unsigned))) {
      return { ok: false, reason: "approval signature is invalid" };
    }
    if (this.#now() > token.expiresAt) return { ok: false, reason: "approval has expired" };
    if (this.#used.has(token.proposalId)) return { ok: false, reason: "approval was already used" };
    if (token.tool !== call.tool) return { ok: false, reason: "approval is for a different tool" };
    if (token.taskId !== call.taskId) return { ok: false, reason: "approval is for a different task" };
    if (hashPayload(call.input) !== token.payloadHash) {
      return { ok: false, reason: "payload differs from what the user approved" };
    }
    this.#used.add(token.proposalId);
    return { ok: true };
  }

  #sign(unsigned: Omit<ApprovalToken, "sig">): string {
    return createHmac("sha256", this.#key).update(canonicalJson(unsigned)).digest("hex");
  }

  #sigMatches(a: string, b: string): boolean {
    const ab = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ab.length === bb.length && timingSafeEqual(ab, bb);
  }
}
