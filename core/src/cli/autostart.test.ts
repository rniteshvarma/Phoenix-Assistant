import assert from "node:assert/strict";
import { test } from "node:test";
import { appAgent, coreAgent, renderPlist, stableNodePath } from "./autostart.ts";

test("core LaunchAgent: runs serve with this Node, restarts on failure, logs to a file, no secrets", () => {
  const spec = coreAgent({ PHOENIX_VOICE: "af_bella", ANTHROPIC_API_KEY: "sk-ant-api03-SECRET" });
  const plist = renderPlist(spec);
  assert.match(plist, /<key>Label<\/key><string>dev\.phoenix\.core<\/string>/);
  assert.ok(plist.includes(`<string>${stableNodePath()}</string>`), "launches a stable Node path");
  assert.match(plist, /core\/src\/cli\/main\.ts<\/string>\s*<string>serve<\/string>/);
  assert.match(plist, /<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  assert.match(plist, /Library\/Logs\/Phoenix\/core\.log/);
  assert.match(plist, /<key>PHOENIX_VOICE<\/key><string>af_bella<\/string>/);
  assert.ok(!plist.includes("SECRET"), "API keys never go into the plist");
});

test("app LaunchAgent opens the Phoenix app once at login; plist text is XML-escaped", () => {
  const plist = renderPlist(appAgent());
  assert.match(plist, /<string>\/usr\/bin\/open<\/string>\s*<string>-a<\/string>/);
  assert.match(plist, /Phoenix\.app<\/string>/);
  assert.ok(!plist.includes("KeepAlive"));
  assert.match(renderPlist({ label: "x", programArguments: ["a&b<c>"] }), /a&amp;b&lt;c&gt;/);
});
