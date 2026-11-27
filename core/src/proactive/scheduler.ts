import type { Approver } from "../agent/loop.ts";
import type { ModelClient } from "../agent/model.ts";
import type { Phoenix } from "../phoenix.ts";
import {
  briefDue, inQuietHours, localDay, meetingNudges, reminderNudges, SettingsStore,
  type DueReminder, type UpcomingEvent,
} from "./schedule.ts";

export const BRIEF_REQUEST =
  "(Automatic morning briefing — the user didn't type this.) Give me my morning briefing: today's weather where I live " +
  "(use what you remember about my city; skip weather if you don't know it), my calendar for today, and reminders that " +
  "are due today or overdue. Read only: don't add, change or send anything. Speak it in 3 to 5 short, warm sentences, " +
  "starting with good morning.";

/** Briefings only read: anything that would need approval is declined automatically. */
const declineAll: Approver = { review: async () => ({ decision: "reject" }) };

/**
 * Phase 7a: Phoenix speaking up on its own — a morning briefing, nudges before meetings and
 * when reminders are due — inside quiet hours and a daily limit. Runs in the background core.
 */
export class ProactiveScheduler {
  #phoenix: Phoenix;
  #settings: SettingsStore;
  #makeModel: () => ModelClient;
  #log: (line: string) => void;
  #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #busy = false;
  #notified = new Set<string>();

  constructor(phoenix: Phoenix, opts: { makeModel: () => ModelClient; log?: (line: string) => void; now?: () => Date }) {
    this.#phoenix = phoenix;
    this.#settings = phoenix.settings;
    this.#makeModel = opts.makeModel;
    this.#log = opts.log ?? (() => {});
    this.#now = opts.now ?? (() => new Date());
  }

  start(intervalMs = 30_000): void {
    this.#timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  pause(minutes: number): void {
    this.#settings.updateProactive({ pausedUntil: this.#now().getTime() + minutes * 60_000 });
  }

  /** One check: briefing due? meetings soon? reminders due? */
  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const s = this.#settings.proactive();
      const now = this.#now();
      const devices = this.#phoenix.devices;
      if (!s.enabled || now.getTime() < s.pausedUntil || !devices.has("notify")) return;
      if (inQuietHours(now, s.quietStart, s.quietEnd)) return;

      if (briefDue(now, s, this.#settings.get<string | undefined>("proactive.lastBrief", undefined))) {
        this.#settings.set("proactive.lastBrief", localDay(now));
        await this.briefNow();
      }

      const nudges = [];
      if (devices.has("calendar.read")) {
        const events = await this.#ask<UpcomingEvent[]>("calendar.read", "calendar_upcoming_json", { minutes: s.meetingLead + 1 });
        nudges.push(...meetingNudges(events, now, s.meetingLead, this.#notified));
      }
      if (devices.has("reminders")) {
        const due = await this.#ask<DueReminder[]>("reminders", "reminders_due_json", { minutes: 1 });
        nudges.push(...reminderNudges(due, now, this.#notified));
      }
      for (const n of nudges) {
        this.#notified.add(n.key);
        if (!this.#withinDailyLimit(now)) break;
        this.#notify("nudge", n.text.startsWith("Reminder") ? "Reminder" : "Coming up", n.text);
      }
    } catch (err) {
      this.#log(`proactive: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#busy = false;
    }
  }

  /** Run the morning briefing now and show/speak it on the Mac. */
  async briefNow(): Promise<void> {
    const result = await this.#phoenix.ask(BRIEF_REQUEST, {
      model: this.#makeModel(),
      approver: declineAll,
      channel: "voice",
      readOnly: true,
    });
    if (result.status === "completed" && result.text.trim()) {
      this.#notify("brief", "Your briefing", result.text);
    } else {
      this.#log(`proactive: briefing ${result.status}: ${result.text}`);
    }
  }

  #withinDailyLimit(now: Date): boolean {
    const key = `proactive.count.${localDay(now)}`;
    const count = this.#settings.get<number>(key, 0);
    if (count >= this.#settings.proactive().maxPerDay) return false;
    this.#settings.set(key, count + 1);
    return true;
  }

  #notify(kind: "brief" | "nudge", title: string, text: string): void {
    const sent = this.#phoenix.devices.broadcast("notify", { type: "proactive", kind, title, text });
    this.#log(`proactive ${kind} → ${sent} app(s)`);
  }

  async #ask<T>(capability: string, tool: string, input: unknown): Promise<T> {
    try {
      return JSON.parse(await this.#phoenix.devices.call(capability, tool, input, 10_000)) as T;
    } catch {
      return [] as unknown as T;
    }
  }
}
