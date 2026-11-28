import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Tier } from "../policy/tiers.ts";
import type { ToolContext } from "./types.ts";
import { MEDIA_TOOLS, parseTime } from "./media.ts";

test("media tools: times, tiers, and files only from the user's media folders", async () => {
  assert.equal(parseTime("1:05"), 65);
  assert.equal(parseTime("00:01:05.5"), 65.5);
  assert.equal(parseTime(12), 12);
  assert.throws(() => parseTime("a:b"));
  const byName = new Map(MEDIA_TOOLS.map((t) => [t.name, t]));
  assert.equal(byName.get("media_transcribe")!.tier, Tier.Read);
  assert.equal(byName.get("media_transcribe")!.untrustedOutput, true);
  for (const n of ["image_create", "video_trim", "video_captions", "screen_record_start"]) assert.equal(byName.get(n)!.tier, Tier.Prepare);
  assert.equal(byName.get("video_trim")!.parse({ file: "a.mov", start: "0:10", end: "0:05" }).ok, false);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-media-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const d of ["Movies", "Pictures", "Documents"]) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, "Movies", "demo.mov"), "x");
    fs.writeFileSync(path.join(home, "secret.mov"), "x");
    const sent: unknown[] = [];
    const ctx = { devices: { call: async (_c: string, _t: string, input: unknown) => (sent.push(input), "ok") } } as unknown as ToolContext;
    await byName.get("video_trim")!.run({ file: "~/Movies/demo.mov", start: "0:01", end: "0:04" }, ctx);
    assert.deepEqual(sent[0], { file: fs.realpathSync(path.join(home, "Movies", "demo.mov")), start: 1, end: 4 });
    await assert.rejects(byName.get("video_trim")!.run({ file: path.join(home, "secret.mov"), start: 0, end: 1 }, ctx), /only/);
    await assert.rejects(byName.get("video_captions")!.run({ file: "~/Movies/demo.mov.txt", language: "en-IN" }, ctx), /no such file|isn't a video/);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
