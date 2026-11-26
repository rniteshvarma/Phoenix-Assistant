import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ApprovalDecision, Approver } from "./agent/loop.ts";
import { loadConfig, type PhoenixConfig } from "./config.ts";
import type { ActionProposal } from "./policy/approvals.ts";

/** Isolated Phoenix home in a temp dir, with a file-based key (never touches the real Keychain). */
export function tempConfig(): { cfg: PhoenixConfig; cleanup: () => void } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-test-"));
  const cfg = loadConfig({ PHOENIX_HOME: home, PHOENIX_KEY_BACKEND: "file" });
  return { cfg, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** Approver that answers from a fixed list and records what it was shown. */
export class FakeApprover implements Approver {
  seen: ActionProposal[] = [];
  #answers: ApprovalDecision[];

  constructor(answers: ApprovalDecision[]) {
    this.#answers = answers;
  }

  async review(proposal: ActionProposal): Promise<ApprovalDecision> {
    this.seen.push(proposal);
    return this.#answers.shift() ?? { decision: "reject" };
  }
}
