import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { ScriptedModel, callTool, lastToolResult, say } from "../agent/scripted.ts";
import type { ModelClient, ModelRequest } from "../agent/model.ts";
import { createPhoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { verhoeffCheckDigit } from "./detect.ts";
import { StreamRevealer } from "./vault.ts";

const AADHAAR = (() => { const b = "23456781234"; return b + verhoeffCheckDigit(b); })();
const PAN = "ABCPE1234F";
const EMAIL = "nitesh.test@example.com";

function setup() {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  return { phoenix, cfg, done: () => (phoenix.close(), cleanup()) };
}

/** Wraps a scripted model and records every byte that would be sent to the cloud. */
function recording(model: ModelClient) {
  const sent: string[] = [];
  return {
    sent,
    model: { name: model.name, next: (req: ModelRequest) => (sent.push(JSON.stringify(req.messages)), model.next(req)) },
  };
}

test("vault: same value → same placeholder; reveal restores it; values are encrypted at rest", () => {
  const { phoenix, cfg, done } = setup();
  try {
    const a = phoenix.vault.protect(`PAN ${PAN} and ${EMAIL}`);
    const b = phoenix.vault.protect(`again ${PAN.toLowerCase()} pan`);
    assert.equal(a.text, "PAN [[PAN_1]] and [[EMAIL_1]]");
    assert.equal(b.text, "again [[PAN_1]] pan");
    assert.equal(phoenix.vault.reveal(a.text), `PAN ${PAN} and ${EMAIL}`);
    assert.deepEqual(a.kinds.sort(), ["EMAIL", "PAN"]);
    const raw = fs.readFileSync(cfg.dbPath);
    assert.ok(!raw.includes(PAN) && !raw.includes(EMAIL), "nothing in plain text on disk");
  } finally {
    done();
  }
});

test("nothing sensitive ever reaches the model: request, memory, history, tool results", async () => {
  const { phoenix, cfg, done } = setup();
  try {
    phoenix.memory.add(`User's email is ${EMAIL}`);
    fs.writeFileSync(`${cfg.notesDir}/ids.md`, `Aadhaar ${AADHAAR}\nPAN ${PAN}\nNetbanking password: S3cret!pass`);
    const { sent, model } = recording(
      new ScriptedModel([
        () => callTool("Reading.", "notes_read", { file: "ids.md" }),
        (m) => say(`Found them: ${lastToolResult(m).includes("[[AADHAAR_1]]") ? "[[AADHAAR_1]]" : "?"}`),
      ]),
    );
    const first = await phoenix.ask(`My PAN is ${PAN}. What IDs are in my notes?`, { model, approver: new FakeApprover([]) });
    const followUp = recording(new ScriptedModel([() => say("ok")]));
    await phoenix.ask("thanks", { model: followUp.model, approver: new FakeApprover([]), sessionId: first.sessionId });

    const everything = [...sent, ...followUp.sent].join("\n");
    for (const secret of [AADHAAR, PAN, EMAIL, "S3cret!pass"]) {
      assert.ok(!everything.includes(secret), `${secret} must never be sent to the model`);
    }
    assert.match(everything, /\[\[PAN_1\]\]/);
    assert.match(everything, /\[\[PASSWORD_1\]\]/);
    // …but the user sees the real value in Phoenix's reply on their Mac.
    assert.equal(first.text, `Found them: ${AADHAAR}`);
  } finally {
    done();
  }
});

test("local tools get real values; the note on disk has the actual PAN", async () => {
  const { phoenix, cfg, done } = setup();
  try {
    await phoenix.ask(`save my PAN ${PAN} in a note`, {
      model: new ScriptedModel([() => callTool("Saving.", "notes_save", { title: "IDs", body: "PAN [[PAN_1]]" }), () => say("Saved.")]),
      approver: new FakeApprover([]),
    });
    const [file] = fs.readdirSync(cfg.notesDir);
    assert.match(fs.readFileSync(`${cfg.notesDir}/${file}`, "utf8"), new RegExp(`PAN ${PAN}`));
  } finally {
    done();
  }
});

test("protected data leaving the Mac needs two confirmations; 'no' at the second stops it", async () => {
  const { phoenix, cfg, done } = setup();
  try {
    const script = () =>
      new ScriptedModel([
        () => callTool("Sending.", "outbox_send", { to: "[[EMAIL_1]]", subject: "IDs", body: "PAN [[PAN_1]]" }),
        (m) => say(lastToolResult(m)),
      ]);
    phoenix.vault.protect(`${EMAIL} ${PAN}`); // the user mentioned these earlier

    const declined = new FakeApprover([{ decision: "approve" }, { decision: "reject" }]);
    const r1 = await phoenix.ask("email my PAN to me", { model: script(), approver: declined });
    assert.deepEqual(declined.seen.map((p) => p.stage), [1, 2]);
    assert.deepEqual([...declined.seen[0]!.protectedKinds].sort(), ["EMAIL", "PAN"]);
    assert.deepEqual(declined.seen[0]!.display, { to: EMAIL, subject: "IDs", body: `PAN ${PAN}` }, "the user sees real values");
    assert.match(r1.text, /declined/);
    assert.equal(fs.readdirSync(cfg.outboxDir).length, 0);

    const approved = new FakeApprover([{ decision: "approve" }, { decision: "approve" }]);
    await phoenix.ask("email my PAN to me", { model: script(), approver: approved });
    const [sentFile] = fs.readdirSync(cfg.outboxDir);
    const email = JSON.parse(fs.readFileSync(`${cfg.outboxDir}/${sentFile}`, "utf8"));
    assert.equal(email.to, EMAIL, "the real address is used only after two confirmations");
    assert.equal(email.body, `PAN ${PAN}`);
  } finally {
    done();
  }
});

test("streamed replies reveal placeholders even when split across chunks", () => {
  const values: Record<string, string> = { "[[EMAIL_1]]": EMAIL };
  const r = new StreamRevealer((t) => t.replace(/\[\[[A-Z_]+_\d+\]\]/g, (w) => values[w] ?? w));
  const out = ["Sent to [[EMA", "IL_1]] just ", "now ["].map((d) => r.push(d)).join("") + r.flush();
  assert.equal(out, `Sent to ${EMAIL} just now [`);
});

test("a cloud voice never receives protected values", () => {
  const { phoenix, done } = setup();
  try {
    assert.equal(phoenix.vault.speakable(`Your PAN is ${PAN}.`), "Your PAN is your PAN.");
    assert.equal(phoenix.vault.speakable(`Mail ${EMAIL} now`), "Mail your email address now");
  } finally {
    done();
  }
});

