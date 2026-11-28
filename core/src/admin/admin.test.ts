import assert from "node:assert/strict";
import { test } from "node:test";
import { ScriptedModel, callTool, say } from "../agent/scripted.ts";
import { Inbound } from "../gateway/protocol.ts";
import { createPhoenix } from "../phoenix.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { handleAdmin } from "./admin.ts";

function setup() {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  return { phoenix, admin: (r: Record<string, unknown>) => handleAdmin(phoenix, r) as Promise<any>, done: () => (phoenix.close(), cleanup()) };
}

test("Control Center messages are validated at the gateway", () => {
  assert.equal(Inbound.safeParse({ type: "admin", id: "1", request: { op: "overview" } }).success, true);
  assert.equal(Inbound.safeParse({ type: "admin", id: "1" }).success, false);
});

test("memory from the Control Center: secrets refused, sensitive values kept as placeholders, shown in full", async () => {
  const { phoenix, admin, done } = setup();
  try {
    await assert.rejects(admin({ op: "memory.add", kind: "fact", text: "my card is 4111 1111 1111 1111" }), /card number/);
    await assert.rejects(admin({ op: "memory.add", kind: "person", text: "colleague" }), /name/);
    const { id } = await admin({ op: "memory.add", kind: "person", subject: "Ankit", text: "Email him at ankit@example.com" });
    assert.match(phoenix.memory.get(id)!.text, /\[\[EMAIL_\d+\]\]/, "stored as a placeholder");
    const listed = (await admin({ op: "memory.list" })).find((m: any) => m.id === id);
    assert.match(listed.text, /ankit@example\.com/, "shown in full on the Mac");
    await admin({ op: "memory.update", id, text: "Colleague; WhatsApp only", subject: "Ankit (AK)" });
    assert.equal(phoenix.memory.get(id)!.subject, "Ankit (AK)");
    assert.equal((await admin({ op: "memory.remove", id })).ok, true);
    await assert.rejects(admin({ op: "nope" }), /invalid request/);
  } finally {
    done();
  }
});

test("skills: saved from the Control Center, indexed with the profile, steps pulled in when they match", async () => {
  const { phoenix, admin, done } = setup();
  try {
    await admin({ op: "skills.save", name: "My usual Swiggy order", description: "Reorder my usual biryani on Swiggy",
      steps: "1. Open iPhone Mirroring → Swiggy\n2. Reorder from Meghana Foods\n3. Stop before payment" });
    await admin({ op: "skills.save", name: "Weekly review", description: "Sunday planning", steps: "1. List open reminders", enabled: false });
    let profile: string | undefined;
    let context = "";
    const model = new ScriptedModel([(m) => ((context = String(m[0]?.content)), say("On it."))]);
    await phoenix.ask("order my usual biryani", {
      model: { name: "x", next: (req) => ((profile = req.profile), model.next(req)) },
      approver: new FakeApprover([]),
    });
    assert.match(profile!, /<skills>\n- My usual Swiggy order: Reorder my usual biryani on Swiggy\n/);
    assert.ok(!profile!.includes("Weekly review"), "switched-off skills are left out");
    assert.match(context, /Meghana Foods/);
  } finally {
    done();
  }
});

test("saving a skill from a conversation needs the user's OK", async () => {
  const { phoenix, done } = setup();
  try {
    const approver = new FakeApprover([{ decision: "reject" }]);
    await phoenix.ask("learn this: my morning routine", {
      model: new ScriptedModel([
        () => callTool("Saving.", "skill_save", { name: "Morning routine", description: "Start the day", steps: "1. Brief me" }),
        () => say("Okay, not saved."),
      ]),
      approver,
    });
    assert.equal(approver.seen[0]!.tool, "skill_save");
    assert.equal(phoenix.skills.list().length, 0);
  } finally {
    done();
  }
});

test("switching a connector off hides its tools from the model and blocks them", async () => {
  const { phoenix, admin, done } = setup();
  try {
    await admin({ op: "connectors.set", id: "phoenix_notes", enabled: false });
    await admin({ op: "connectors.set", id: "web", enabled: false });
    let offered: string[] = [];
    let web: boolean | undefined;
    let blocked = "";
    const model = new ScriptedModel([
      () => callTool("Saving.", "notes_save", { title: "x", body: "y" }),
      (m) => ((blocked = JSON.stringify(m.at(-1))), say("ok")),
    ]);
    await phoenix.ask("save a note", {
      model: { name: "x", next: (req) => ((offered = req.tools.map((t) => t.name)), (web = req.webSearch), model.next(req)) },
      approver: new FakeApprover([]),
    });
    assert.ok(!offered.includes("notes_save"));
    assert.ok(offered.includes("reminders_add"));
    assert.equal(web, false);
    assert.match(blocked, /switched off in the Control Center/);
    const overview = await admin({ op: "overview" });
    assert.equal(overview.connectors.find((c: any) => c.id === "web").enabled, false);
  } finally {
    done();
  }
});

test("history: past conversations listed newest first, read as the user saw them, and deletable", async () => {
  const { phoenix, admin, done } = setup();
  try {
    await phoenix.ask("remind me to call the bank", {
      model: new ScriptedModel([() => callTool("Adding.", "memory_remember", { fact: "Banks with HDFC" }), () => say("Done, reminder set.")]),
      approver: new FakeApprover([]),
    });
    const [first] = await admin({ op: "history.list" });
    assert.equal(first.title, "remind me to call the bank");
    const convo = await admin({ op: "history.get", id: first.id });
    assert.deepEqual(convo.entries.map((e: any) => e.role), ["you", "phoenix", "action", "phoenix"]);
    assert.ok(!JSON.stringify(convo).includes("<context>"), "the hidden context block isn't shown");
    assert.equal((await admin({ op: "history.remove", id: first.id })).ok, true);
    assert.equal((await admin({ op: "history.list" })).length, 0);
  } finally {
    done();
  }
});

test("name and settings: renaming the assistant reaches the cached prompt; bad keys and banking apps refused", async () => {
  const { phoenix, admin, done } = setup();
  try {
    await admin({ op: "settings.set", name: "Agni", proactive: { briefTime: "07:45", meetingLead: 300 } });
    assert.equal(phoenix.settings.proactive().briefTime, "07:45");
    assert.equal(phoenix.settings.proactive().meetingLead, 10, "out-of-range values are ignored");
    let profile: string | undefined;
    const model = new ScriptedModel([() => say("Hi")]);
    await phoenix.ask("hi", { model: { name: "x", next: (req) => ((profile = req.profile), model.next(req)) }, approver: new FakeApprover([]) });
    assert.match(profile!, /named you "Agni"/);
    await assert.rejects(admin({ op: "keys.set", name: "anthropic", value: "not-an-anthropic-key" }), /doesn't look like an Anthropic key/);
    await assert.rejects(admin({ op: "settings.set", screenApps: ["WhatsApp", "HDFC Bank"] }), /never operates HDFC Bank/);
  } finally {
    done();
  }
});

test("travel: built-in playbooks are indexed and pulled in, and a booking needs the approval card", async () => {
  const { phoenix, done } = setup();
  try {
    let profile: string | undefined;
    let context = "";
    const approver = new FakeApprover([{ decision: "approve" }]);
    const model = new ScriptedModel([
      (m) => ((context = String(m[0]?.content)), callTool("Here's the deal.", "booking_review", {
        kind: "flight", title: "Hyderabad → Goa, Fri 12 Dec, 6E 2134", site: "MakeMyTrip",
        itinerary: ["HYD 18:05 → GOI 19:20, nonstop"], travellers: ["Nitesh Varma Rudraraju"],
        price: { base: 4200, taxes: 650, fees: 199, total: 5049 }, cancellation: "₹3,500 fee before 2 h of departure", payment: "You pay on MakeMyTrip",
      })),
      () => say("Approved; filling it in now."),
    ]);
    await phoenix.ask("book me a flight to Goa on Friday evening", {
      model: { name: "x", next: (req) => ((profile ??= req.profile), model.next(req)) },
      approver,
    });
    assert.match(profile!, /- Book a flight: Find, compare and book a flight/);
    assert.match(context, /booking_review/);
    assert.equal(approver.seen[0]!.tool, "booking_review");
    assert.match(approver.seen[0]!.summary, /₹5,049 on MakeMyTrip/);
  } finally {
    done();
  }
});
