import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ScriptedModel, callTool, lastToolResult, say } from "../agent/scripted.ts";
import { Tier } from "../policy/tiers.ts";
import { createPhoenix, type Phoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { MAC_TOOLS } from "../tools/mac.ts";
import type { ToolContext } from "../tools/types.ts";
import {
  PROACTIVE_DEFAULTS, briefDue, inQuietHours, meetingNudges, minutesOf, reminderNudges,
} from "./schedule.ts";
import { ProactiveScheduler } from "./scheduler.ts";

const at = (hhmm: string, day = "2026-11-27") => new Date(`${day}T${hhmm}:00`); // local time; 27 Nov 2026 is a Friday

function setup() {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  return { phoenix, done: () => (phoenix.close(), cleanup()) };
}

/** A pretend Mac app: records what it was sent and answers tool calls from `answers`. */
function fakeMac(phoenix: Phoenix, answers: Record<string, string>, capabilities = ["notify", "calendar.read", "reminders"]) {
  const sent: Array<Record<string, unknown>> = [];
  const link = {
    id: "mac-1",
    name: "Mac",
    capabilities: new Set(capabilities),
    send(message: Record<string, unknown>) {
      sent.push(message);
      if (message.type === "tool.call") {
        const output = answers[message.tool as string] ?? "[]";
        setImmediate(() => phoenix.devices.settle(link.id, message.callId as string, { ok: true, output }));
      }
    },
  };
  phoenix.devices.attach(link);
  return { sent, proactive: () => sent.filter((m) => m.type === "proactive") };
}

// ── Schedule rules ───────────────────────────────────────────────────────────

test("quiet hours wrap past midnight", () => {
  assert.equal(inQuietHours(at("23:15"), "22:00", "07:30"), true);
  assert.equal(inQuietHours(at("03:00"), "22:00", "07:30"), true);
  assert.equal(inQuietHours(at("07:30"), "22:00", "07:30"), false);
  assert.equal(inQuietHours(at("12:00"), "22:00", "07:30"), false);
  assert.equal(inQuietHours(at("13:30"), "13:00", "14:00"), true);
  assert.equal(inQuietHours(at("13:30"), "09:00", "09:00"), false);
  assert.throws(() => minutesOf("25:00"), /HH:MM/);
});

test("morning briefing: once a day, up to 3 hours late, weekdays option", () => {
  const s = { ...PROACTIVE_DEFAULTS, briefTime: "08:30" };
  assert.equal(briefDue(at("08:29"), s, undefined), false);
  assert.equal(briefDue(at("08:30"), s, undefined), true);
  assert.equal(briefDue(at("11:29"), s, undefined), true);
  assert.equal(briefDue(at("11:30"), s, undefined), false);
  assert.equal(briefDue(at("09:00"), s, "2026-11-27"), false, "already briefed today");
  assert.equal(briefDue(at("09:00"), s, "2026-11-26"), true);
  const weekdays = { ...s, briefDays: "weekdays" as const };
  assert.equal(briefDue(at("09:00", "2026-11-28"), weekdays, undefined), false, "Saturday");
  assert.equal(briefDue(at("09:00", "2026-11-27"), weekdays, undefined), true, "Friday");
});

test("meeting and reminder nudges fire once, at the right time", () => {
  const now = at("10:00");
  const events = [
    { title: "Design review", start: at("10:08").toISOString(), location: "Room 4" },
    { title: "Lunch", start: at("12:30").toISOString() },
    { title: "Already started", start: at("09:55").toISOString() },
  ];
  const nudges = meetingNudges(events, now, 10, new Set());
  assert.deepEqual(nudges.map((n) => n.text), ["Design review starts in 8 minutes, at Room 4."]);
  assert.deepEqual(meetingNudges(events, now, 10, new Set([nudges[0]!.key])), [], "no repeats");

  const reminders = [
    { id: "a", title: "Call the bank", due: at("10:00").toISOString() },
    { id: "b", title: "Later", due: at("10:05").toISOString() },
    { id: "c", title: "Long ago", due: at("09:30").toISOString() },
  ];
  const r = reminderNudges(reminders, now, new Set());
  assert.deepEqual(r.map((n) => n.text), ["Reminder: Call the bank."]);
  assert.deepEqual(reminderNudges(reminders, now, new Set([r[0]!.key])), []);
});

// ── Scheduler ────────────────────────────────────────────────────────────────

test("scheduler: briefing once, nudges deduped, quiet hours and pause respected", async () => {
  const { phoenix, done } = setup();
  try {
    let now = at("08:31");
    const mac = fakeMac(phoenix, {
      calendar_upcoming_json: JSON.stringify([{ title: "Standup", start: at("08:40").toISOString(), location: "" }]),
    });
    let briefs = 0;
    const scheduler = new ProactiveScheduler(phoenix, {
      now: () => now,
      makeModel: () => new ScriptedModel([() => (briefs++, say("Good morning! You have standup at 8:40."))]),
    });

    await scheduler.tick();
    assert.equal(briefs, 1);
    assert.deepEqual(
      mac.proactive().map((m) => [m.kind, m.text]),
      [["brief", "Good morning! You have standup at 8:40."], ["nudge", "Standup starts in 9 minutes."]],
    );

    now = at("08:32");
    await scheduler.tick();
    assert.equal(briefs, 1, "only one briefing a day");
    assert.equal(mac.proactive().length, 2, "the standup nudge isn't repeated");

    // Quiet hours: nothing at all.
    phoenix.settings.updateProactive({ quietStart: "08:00", quietEnd: "09:00" });
    phoenix.settings.set("proactive.lastBrief", "2026-11-26");
    await scheduler.tick();
    assert.equal(mac.proactive().length, 2);

    // Paused: nothing either.
    phoenix.settings.updateProactive({ quietStart: "22:00", quietEnd: "07:30" });
    scheduler.pause(60);
    await scheduler.tick();
    assert.equal(mac.proactive().length, 2);
    assert.equal(briefs, 1);
  } finally {
    done();
  }
});

test("scheduler: daily limit caps nudges; off means silent; no app means no work", async () => {
  const { phoenix, done } = setup();
  try {
    const now = at("14:00");
    const scheduler = new ProactiveScheduler(phoenix, { now: () => now, makeModel: () => new ScriptedModel([]) });
    await scheduler.tick(); // no Mac app connected: nothing to do, no errors

    const mac = fakeMac(phoenix, {
      reminders_due_json: JSON.stringify(
        ["a", "b", "c"].map((id) => ({ id, title: `Task ${id}`, due: at("14:00").toISOString() })),
      ),
    });
    phoenix.settings.updateProactive({ maxPerDay: 2 });
    await scheduler.tick();
    assert.deepEqual(mac.proactive().map((m) => m.text), ["Reminder: Task a.", "Reminder: Task b."]);

    phoenix.settings.updateProactive({ enabled: false, maxPerDay: 12 });
    await scheduler.tick();
    assert.equal(mac.proactive().length, 2);
  } finally {
    done();
  }
});

test("the briefing is read-only: tools that change things are refused, nothing reaches the Mac", async () => {
  const { phoenix, done } = setup();
  try {
    const mac = fakeMac(phoenix, {}, ["notify", "reminders"]);
    let refusal = "";
    const result = await phoenix.ask("brief me", {
      model: new ScriptedModel([
        () => callTool("Adding.", "reminders_add", { title: "Sneaky" }),
        (m) => ((refusal = lastToolResult(m)), say("Good morning.")),
      ]),
      approver: new FakeApprover([]),
      readOnly: true,
    });
    assert.equal(result.status, "completed");
    assert.match(refusal, /read-only briefing/);
    assert.equal(mac.sent.filter((m) => m.type === "tool.call").length, 0);
  } finally {
    done();
  }
});

// ── Mac actions ──────────────────────────────────────────────────────────────

test("Mac actions: tiers and what leaves the Mac", () => {
  const byName = new Map(MAC_TOOLS.map((t) => [t.name, t]));
  const tier = (n: string) => byName.get(n)!.tier;
  for (const n of ["reminders_list", "contacts_search", "shortcuts_list"]) assert.equal(tier(n), Tier.Read, n);
  for (const n of ["reminders_add", "calendar_add_event", "apple_notes_create", "app_open", "files_move"]) {
    assert.equal(tier(n), Tier.Prepare, n);
  }
  for (const n of ["messages_send", "files_trash", "shortcuts_run"]) assert.equal(tier(n), Tier.Act, n);
  assert.deepEqual(MAC_TOOLS.filter((t) => t.leavesDevice).map((t) => t.name), ["messages_send"]);
  assert.equal(byName.get("contacts_search")!.untrustedOutput, true);

  const open = byName.get("app_open")!;
  assert.equal(open.parse({ target: "Spotify" }).ok, true);
  assert.equal(open.parse({ target: "https://example.com" }).ok, true);
  assert.equal(open.parse({ target: "file:///etc/passwd" }).ok, false);
  assert.equal(open.parse({ target: "x-apple.systempreferences:com.apple.preference.security" }).ok, false);
  const cal = byName.get("calendar_add_event")!;
  assert.equal(cal.parse({ title: "x", start: "2026-11-27T10:00:00+05:30", end: "2026-11-27T09:00:00+05:30" }).ok, false);
});

test("files_move / files_trash stay inside Documents, Desktop and Downloads", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-home-"));
  const realHome = process.env.HOME;
  process.env.HOME = home;
  try {
    for (const d of ["Documents", "Desktop", "Downloads", ".Trash"]) fs.mkdirSync(path.join(home, d));
    fs.writeFileSync(path.join(home, "Downloads", "report.pdf"), "x");
    fs.writeFileSync(path.join(home, "secret.txt"), "x");
    const tools = new Map(MAC_TOOLS.map((t) => [t.name, t]));
    const ctx = {} as ToolContext;
    const move = (input: unknown) => tools.get("files_move")!.run(input, ctx);

    await assert.rejects(move({ from: path.join(home, "secret.txt"), toFolder: "Documents" }), /only/);
    await assert.rejects(move({ from: "~/Downloads/report.pdf", toFolder: "Documents", subfolder: "../../" }), /inside/);
    assert.match(await move({ from: "~/Downloads/report.pdf", toFolder: "Documents", subfolder: "Work" }), /Documents\/Work/);
    assert.ok(fs.existsSync(path.join(home, "Documents", "Work", "report.pdf")));

    fs.writeFileSync(path.join(home, "Downloads", "report.pdf"), "y");
    await assert.rejects(move({ from: "~/Downloads/report.pdf", toFolder: "Documents", subfolder: "Work" }), /already exists/);

    await tools.get("files_trash")!.run({ path: "~/Downloads/report.pdf" }, ctx);
    assert.ok(fs.existsSync(path.join(home, ".Trash", "report.pdf")));
    await assert.rejects(tools.get("files_trash")!.run({ path: path.join(home, "secret.txt") }, ctx), /only/);
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
