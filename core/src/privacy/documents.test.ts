import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createPhoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { ScriptedModel, callTool, lastToolResult, say } from "../agent/scripted.ts";
import { verhoeffCheckDigit } from "./detect.ts";
import { classifyDocument, cleanText, resolveAllowed, scanDocument } from "./documents.ts";

const aadhaar = (() => { const b = "73915826403"; return b + verhoeffCheckDigit(b); })();

test("ID and financial documents are confidential; ordinary ones aren't", () => {
  const c = (t: string) => classifyDocument(t);
  assert.deepEqual(c(`Government of India\nTest Person\n${aadhaar.replace(/(\d{4})(?=\d)/g, "$1 ")}\nAadhaar`).docType, "Aadhaar card");
  assert.equal(c("INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPE1234F").docType, "PAN card");
  assert.equal(c("REPUBLIC OF INDIA Passport No. K1234567\nP<INDTEST<<PERSON").docType, "passport");
  assert.equal(c("Statement of Account\nA/c No: 50100123456789").docType, "bank statement");
  assert.equal(c("Card 4111 1111 1111 1111").confidential, true);
  const receipt = c("Blue Tokai Coffee\n1 x Cappuccino 220.00\nTotal 400.00");
  assert.equal(receipt.confidential, false);
  assert.equal(receipt.docType, undefined);
  // A normal letter that merely mentions an email address is not a confidential document.
  assert.equal(c("Hi team, notes from today's meeting. Mail me at someone@example.com").confidential, false);
});

test("confidential documents share only their type and placeholders — never names or other content", async () => {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  try {
    const file = path.join(cfg.home, "aadhaar.txt");
    fs.writeFileSync(file, `Government of India\nRamesh Kumar\nDOB 01/01/1990\n${aadhaar}\nAadhaar\n12 MG Road, Hyderabad`);
    const scan = await scanDocument(file, phoenix.vault);
    assert.equal(scan.confidential, true);
    assert.match(scan.shareable, /Aadhaar card/);
    assert.match(scan.shareable, /\[\[AADHAAR_1\]\]/);
    for (const secret of [aadhaar, "Ramesh", "1990", "MG Road"]) assert.ok(!scan.shareable.includes(secret), secret);
  } finally {
    phoenix.close();
    cleanup();
  }
});

test("documents can only be read from Documents, Desktop or Downloads", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "phx-roots-"));
  const allowed = path.join(root, "Documents");
  fs.mkdirSync(allowed);
  fs.writeFileSync(path.join(allowed, "a.txt"), "hi");
  fs.writeFileSync(path.join(root, "secret.txt"), "no");
  try {
    assert.equal(resolveAllowed(path.join(allowed, "a.txt"), [allowed]), fs.realpathSync(path.join(allowed, "a.txt")));
    assert.throws(() => resolveAllowed(path.join(root, "secret.txt"), [allowed]), /only read documents/);
    assert.throws(() => resolveAllowed(path.join(allowed, "../secret.txt"), [allowed]), /only read documents/);
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(allowed, "link.txt"));
    assert.throws(() => resolveAllowed(path.join(allowed, "link.txt"), [allowed]), /only read documents/, "symlinks can't escape");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the model is told only what kind of document it is", async () => {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  const docs = fs.mkdtempSync(path.join(os.homedir(), "Documents", ".phoenix-test-"));
  try {
    const file = path.join(docs, "pan.txt");
    fs.writeFileSync(file, "INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPE1234F\nName TEST PERSON");
    const sent: string[] = [];
    let toolResult = "";
    const model = new ScriptedModel([
      () => callTool("Reading.", "document_read", { path: file }),
      (m) => ((toolResult = lastToolResult(m)), say("That's your PAN card; it stays on your Mac.")),
    ]);
    await phoenix.ask("what's in my pan file?", {
      model: { name: "rec", next: (r) => (sent.push(JSON.stringify(r.messages)), model.next(r)) },
      approver: new FakeApprover([]),
    });
    assert.match(toolResult, /confidential document \(PAN card\)/);
    assert.ok(!sent.join("").includes("ABCPE1234F") && !sent.join("").includes("TEST PERSON"));
  } finally {
    fs.rmSync(docs, { recursive: true, force: true });
    phoenix.close();
    cleanup();
  }
});

test("extracted text is tidied: no image markers, entities decoded, blank runs squeezed", () => {
  assert.equal(cleanText("WATER &amp; POWER\n\uFFFC\n\uFFFC\n\uFFFC\n\n\n\nNext   \n"), "WATER & POWER\n\nNext");
});
