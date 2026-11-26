import assert from "node:assert/strict";
import { test } from "node:test";
import { checkApiKey } from "./keycheck.ts";

test("API key check flags pasted control characters, spaces and wrong prefixes", () => {
  assert.equal(checkApiKey(undefined), null);
  assert.equal(checkApiKey(""), null);
  assert.equal(checkApiKey("sk-ant-api03-abcDEF_123-xyz"), null);
  assert.match(checkApiKey("\x1b[200~sk-ant-api03-abc\x1b[201~")!, /hidden characters/);
  assert.match(checkApiKey("sk-ant-api03-abc\n")!, /hidden characters/);
  assert.match(checkApiKey(" sk-ant-api03-abc")!, /hidden characters/);
  assert.match(checkApiKey("openai-key-123")!, /start with sk-ant-/);
});

test("API key check never echoes the key", () => {
  const key = "\x1b[200~sk-ant-api03-SECRETSECRET\x1b[201~";
  assert.ok(!checkApiKey(key)!.includes("SECRET"));
});
