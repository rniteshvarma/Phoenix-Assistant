import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, hashPayload } from "./canonical.ts";
import { open, seal } from "./crypto.ts";

test("canonical JSON ignores key order and undefined members", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [1, 2], c: "x" }, z: undefined }),
    canonicalJson({ a: { c: "x", d: [1, 2] }, b: 1 }),
  );
  assert.notEqual(hashPayload({ to: "a@b.com" }), hashPayload({ to: "a@b.co" }));
});

test("canonical JSON rejects values that cannot round-trip", () => {
  assert.throws(() => canonicalJson({ n: Number.NaN }));
  assert.throws(() => canonicalJson({ n: 1n }));
});

test("seal/open round-trips and detects tampering or a wrong key", () => {
  const key = randomBytes(32);
  const sealed = seal(key, "hello phoenix");
  assert.equal(open(key, sealed), "hello phoenix");
  assert.notEqual(seal(key, "hello phoenix"), sealed, "fresh IV every time");

  const raw = Buffer.from(sealed.slice(3), "base64");
  raw[raw.length - 1]! ^= 0x01;
  assert.throws(() => open(key, `v1:${raw.toString("base64")}`));
  assert.throws(() => open(randomBytes(32), sealed));
});
