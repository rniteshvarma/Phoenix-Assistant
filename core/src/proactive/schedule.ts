import type { DatabaseSync } from "node:sqlite";

/** Phase 7a: when Phoenix may speak up on its own. Stored locally (settings table). */
export interface ProactiveSettings {
  enabled: boolean;
  /** Morning briefing time, "HH:MM" local. */
  briefTime: string;
  briefDays: "daily" | "weekdays";
  /** Quiet hours, "HH:MM"–"HH:MM" local; may wrap past midnight. */
  quietStart: string;
  quietEnd: string;
  /** Nudge this many minutes before a meeting. */
  meetingLead: number;
  /** At most this many proactive messages per day. */
  maxPerDay: number;
  /** Paused until this time (ms since epoch). */
  pausedUntil: number;
}

export const PROACTIVE_DEFAULTS: ProactiveSettings = {
  enabled: true,
  briefTime: "08:30",
  briefDays: "daily",
  quietStart: "22:00",
  quietEnd: "07:30",
  meetingLead: 10,
  maxPerDay: 12,
  pausedUntil: 0,
};

export class SettingsStore {
  #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
  }
  get<T>(key: string, fallback: T): T {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown): void {
    this.#db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
  proactive(): ProactiveSettings {
    return { ...PROACTIVE_DEFAULTS, ...this.get<Partial<ProactiveSettings>>("proactive", {}) };
  }
  updateProactive(patch: Partial<ProactiveSettings>): ProactiveSettings {
    const next = { ...this.proactive(), ...patch };
    this.set("proactive", next);
    return next;
  }
}

export const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function minutesOf(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`time must be HH:MM, got "${hhmm}"`);
  return Number(m[1]) * 60 + Number(m[2]);
}

const minuteOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();

export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Inside quiet hours? Handles ranges that wrap midnight (e.g. 22:00–07:30). */
export function inQuietHours(now: Date, start: string, end: string): boolean {
  const n = minuteOfDay(now), s = minutesOf(start), e = minutesOf(end);
  if (s === e) return false;
  return s < e ? n >= s && n < e : n >= s || n < e;
}

/** Time for the morning briefing? Up to 3 hours late (e.g. the Mac was asleep), once a day. */
export function briefDue(now: Date, s: ProactiveSettings, lastBriefDay: string | undefined): boolean {
  if (lastBriefDay === localDay(now)) return false;
  const weekend = now.getDay() === 0 || now.getDay() === 6;
  if (s.briefDays === "weekdays" && weekend) return false;
  const n = minuteOfDay(now), b = minutesOf(s.briefTime);
  return n >= b && n < b + 180;
}

export interface UpcomingEvent { title: string; start: string; location?: string }
export interface DueReminder { id: string; title: string; due: string }
export interface Nudge { key: string; text: string }

/** Meetings starting within `lead` minutes that haven't been announced yet. */
export function meetingNudges(events: UpcomingEvent[], now: Date, lead: number, notified: ReadonlySet<string>): Nudge[] {
  return events.flatMap((e) => {
    const ms = Date.parse(e.start) - now.getTime();
    const key = `event:${e.title}:${e.start}`;
    if (!(ms > 0 && ms <= lead * 60_000 + 30_000) || notified.has(key)) return [];
    const mins = Math.max(1, Math.round(ms / 60_000));
    return [{ key, text: `${e.title} starts in ${mins} minute${mins === 1 ? "" : "s"}${e.location ? `, at ${e.location}` : ""}.` }];
  });
}

/** Reminders due now (or in the last 15 minutes) that haven't been announced yet. */
export function reminderNudges(items: DueReminder[], now: Date, notified: ReadonlySet<string>): Nudge[] {
  return items.flatMap((r) => {
    const ms = Date.parse(r.due) - now.getTime();
    const key = `reminder:${r.id}:${r.due}`;
    if (!(ms <= 30_000 && ms > -15 * 60_000) || notified.has(key)) return [];
    return [{ key, text: `Reminder: ${r.title}.` }];
  });
}
