import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ScriptedModel, callTool, say } from "../agent/scripted.ts";
import { createPhoenix } from "../phoenix.ts";
import { openDatabase } from "../store/db.ts";
import { EPISODE_LIMIT, MemoryStore, STYLE_SAMPLES_PER_SUBJECT } from "../store/memory.ts";
import { FakeApprover, tempConfig } from "../testing.ts";
import { rank, recall, renderRecall } from "./recall.ts";

function setup() {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg);
  return { phoenix, done: () => (phoenix.close(), cleanup()) };
}

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-mem-"));
  const db = openDatabase(path.join(dir, "p.db"));
  return { mem: new MemoryStore(db, randomBytes(32)), db, done: () => (db.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

test("old memory databases are upgraded in place, keeping what was remembered", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "phoenix-mig-"));
  const file = path.join(dir, "old.db");
  try {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, text_enc TEXT NOT NULL, created_at INTEGER NOT NULL)");
    old.close();
    const key = randomBytes(32);
    const db = openDatabase(file);
    const mem = new MemoryStore(db, key);
    mem.add("User lives in Bengaluru");
    db.close();
    const again = new MemoryStore(openDatabase(file), key); // opening twice is fine
    assert.deepEqual(again.list().map((m) => [m.kind, m.text]), [["fact", "User lives in Bengaluru"]]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recall sends the profile, pages for people named, and only the relevant few facts", () => {
  const { mem, done } = store();
  try {
    mem.add("User is Nitesh, a product manager at Varsun, lives in Bengaluru", { kind: "profile" });
    mem.add("Colleague at Varsun; reach on WhatsApp; keep it short", { kind: "person", subject: "Ankit" });
    mem.add("Calls every Sunday evening", { kind: "person", subject: "Mom (Amma)" });
    mem.add("Prefers window seats on flights", { kind: "fact" });
    mem.add("Vegetarian; no mushrooms", { kind: "fact" });
    mem.add("Writes WhatsApp messages in lowercase, no full stops", { kind: "style" });
    for (let i = 0; i < 40; i += 1) mem.add(`Unrelated detail number ${i} about gardening`, { kind: "fact" });

    const r = recall(mem, "Book me a flight to Goa on Friday evening");
    assert.equal(r.profile.length, 1);
    assert.deepEqual(r.relevant.map((m) => m.text), ["Prefers window seats on flights"]);
    assert.equal(r.people.length, 0);
    assert.equal(r.style.length, 0, "no style notes unless writing");

    const w = recall(mem, "WhatsApp Ankit that I'm running late");
    assert.deepEqual(w.people.map((p) => p.subject), ["Ankit"]);
    assert.ok(w.style.some((m) => /lowercase/.test(m.text)));
    assert.equal(recall(mem, "call amma tonight").people[0]?.subject, "Mom (Amma)");

    // Far fewer lines than sending all 46 memories.
    assert.ok(renderRecall(r).length < 5);
  } finally {
    done();
  }
});

test("BM25 ranking prefers the closest match and ignores filler words", () => {
  const { mem, done } = store();
  try {
    const items = [
      mem.add("Dentist is Dr Rao in Indiranagar"),
      mem.add("Favourite restaurant is Meghana Foods, orders chicken biryani"),
      mem.add("Gym on weekday mornings at 7"),
    ];
    assert.equal(rank("order my usual biryani", items)[0]!.text, items[1]!.text);
    assert.deepEqual(rank("please tell me what", items), []);
  } finally {
    done();
  }
});

test("episodes and writing samples roll over; duplicates aren't stored twice", () => {
  const { mem, done } = store();
  try {
    for (let i = 0; i < EPISODE_LIMIT + 5; i += 1) mem.addEpisode(`Asked thing ${i}`);
    assert.equal(mem.list("episode").length, EPISODE_LIMIT);
    assert.equal(mem.list("episode")[0]!.text, "Asked thing 5");
    for (let i = 0; i < 10; i += 1) mem.addStyleSample("Ankit (WhatsApp)", `msg ${i}`);
    assert.equal(mem.list("style").length, STYLE_SAMPLES_PER_SUBJECT);
    const a = mem.add("Likes filter coffee");
    const b = mem.add("likes filter coffee");
    assert.equal(a.id, b.id);
    assert.throws(() => mem.add("x", { kind: "person" }), /subject/);
  } finally {
    done();
  }
});

test("end to end: profile goes in the cached system part, episodes are kept, approved messages teach style", async () => {
  const { phoenix, done } = setup();
  try {
    phoenix.memory.add("User is Nitesh and lives in Bengaluru", { kind: "profile" });
    let profile: string | undefined;
    let firstMessage = "";
    const model = new ScriptedModel([
      () => callTool("Remembering.", "memory_remember", { fact: "Ankit is a colleague", kind: "person", subject: "Ankit" }),
      () => callTool("Sending.", "outbox_send", { to: "ankit@example.com", subject: "Late", body: "running 10 late, start without me" }),
      () => say("Sent, and I'll remember Ankit."),
    ]);
    const wrapped = {
      name: model.name,
      next: (req: Parameters<typeof model.next>[0]) => {
        profile ??= req.profile;
        firstMessage ||= String(req.messages[0]?.content);
        return model.next(req);
      },
    };
    const outcome = await phoenix.ask("email Ankit I'm late", { model: wrapped, approver: new FakeApprover([{ decision: "approve" }, { decision: "approve" }]) }); // email address: asked twice
    assert.equal(outcome.status, "completed");
    assert.match(profile!, /<user_profile>[\s\S]*Nitesh/);
    assert.ok(!firstMessage.includes("Nitesh"), "the profile isn't repeated in the message");

    const kinds = phoenix.memory.list().map((m) => m.kind);
    assert.deepEqual(kinds.sort(), ["episode", "person", "profile", "style"]);
    const sample = phoenix.memory.list("style")[0]!;
    assert.match(sample.text, /running 10 late/);
    assert.match(sample.subject!, /\[\[EMAIL_\d+\]\]/, "who it went to is stored as a placeholder");
    assert.match(phoenix.memory.list("episode")[0]!.text, /email Ankit I'm late/);

    // Next request about Ankit: his page and the writing sample come along.
    let next = "";
    await phoenix.ask("message Ankit about tomorrow", {
      model: new ScriptedModel([(m) => ((next = String(m[0]?.content)), say("ok"))]),
      approver: new FakeApprover([]),
    });
    assert.match(next, /About Ankit:[\s\S]*colleague/);
    assert.match(next, /How the user writes[\s\S]*running 10 late/);
  } finally {
    done();
  }
});

test("rejecting a draft with feedback is kept as a writing lesson", async () => {
  const { phoenix, done } = setup();
  try {
    await phoenix.ask("email the landlord", {
      model: new ScriptedModel([
        () => callTool("Drafting.", "outbox_send", { to: "landlord@example.com", subject: "Rent", body: "Dear Sir, kindly…" }),
        () => say("Okay, I'll make it less formal."),
      ]),
      approver: new FakeApprover([{ decision: "reject", feedback: "too formal, I just say Hi Ramesh" }]),
    });
    assert.match(phoenix.memory.list("style").map((m) => m.text).join(), /too formal, I just say Hi Ramesh/);
  } finally {
    done();
  }
});

test("local-only memories are never recalled or searchable by the model", async () => {
  const { phoenix, done } = setup();
  try {
    phoenix.memory.add("ICOMM needs VAPT before go-live", { kind: "local", subject: "Varsun ERP: ICOMM VAPT" });
    phoenix.memory.add("Prefers VAPT reports as PDF", { kind: "fact" });
    const r = recall(phoenix.memory, "what's happening with the ICOMM VAPT");
    assert.ok(![...r.relevant, ...r.people.flatMap((p) => p.items)].some((m) => m.kind === "local"));
    let searched = "";
    await phoenix.ask("search ICOMM", {
      model: new ScriptedModel([
        () => callTool("Looking.", "memory_search", { query: "ICOMM VAPT" }),
        (m) => ((searched = JSON.stringify(m.at(-1))), say("ok")),
      ]),
      approver: new FakeApprover([]),
    });
    assert.ok(!searched.includes("go-live"), "local memory not returned to the model");
    assert.match(searched, /PDF/);
  } finally {
    done();
  }
});

/** Stand-in embedder: words map to a few "concepts" so meaning can be tested without the model. */
const CONCEPTS: Record<string, number> = { mother: 0, mom: 0, amma: 0, gym: 1, fitness: 1, lifting: 1, workout: 1, plot: 2, plots: 2, farm: 2, leads: 2 };
const fakeEmbedder = {
  name: "fake",
  calls: 0,
  async embed(texts: string[]) {
    this.calls += texts.length;
    return texts.map((t) => {
      const v = [0, 0, 0, 0.05];
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) if (w in CONCEPTS) v[CONCEPTS[w]!] = (v[CONCEPTS[w]!] ?? 0) + 1;
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    });
  },
};

test("meaning search: 'mother' finds Amma's page, 'gym' finds fitness notes; vectors cached and encrypted", async () => {
  const { cfg, cleanup } = tempConfig();
  const phoenix = createPhoenix(cfg, { embedder: fakeEmbedder });
  try {
    phoenix.memory.add("Calls every Sunday evening", { kind: "person", subject: "Amma" });
    phoenix.memory.add("Heavy lifting 7 to 8:30 AM; goal: muscle gain", { kind: "fact" });
    phoenix.memory.add("Prefers window seats on flights", { kind: "fact" });
    let context = "";
    const model = new ScriptedModel([(m) => ((context = String(m[0]?.content)), say("ok"))]);
    await phoenix.ask("remind me to ring my mother and plan food after the workout", { model, approver: new FakeApprover([]) });
    assert.match(context, /About Amma:[\s\S]*Sunday/, "found by meaning, not by name");
    assert.match(context, /Heavy lifting/);
    assert.ok(!context.includes("window seats"));

    const before = fakeEmbedder.calls;
    await phoenix.ask("anything else for my mother?", { model: new ScriptedModel([() => say("ok")]), approver: new FakeApprover([]) });
    assert.ok(fakeEmbedder.calls - before <= 3, "stored memories aren't embedded again");
    const rows = new DatabaseSync(cfg.dbPath).prepare("SELECT vec_enc FROM memory_vectors").all() as Array<{ vec_enc: string }>;
    assert.ok(rows.length >= 3 && rows.every((r) => !r.vec_enc.startsWith("[")), "vectors are stored encrypted");
  } finally {
    phoenix.close();
    cleanup();
  }
});
