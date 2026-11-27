import type { MemoryItem } from "../store/memory.ts";

export interface TurnContext {
  now: Date;
  timeZone: string;
  memories: MemoryItem[];
  /** How the user is talking to Phoenix right now. */
  channel: "voice" | "text";
}

/**
 * Per-turn context, sent as part of the user's message (never in the system prompt,
 * which stays byte-stable for caching).
 */
export function renderContext(ctx: TurnContext): string {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: ctx.timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "longOffset",
  }).format(ctx.now);

  const lines = [
    "<context>",
    `Current local time: ${when} (${ctx.timeZone})`,
    `Channel: ${ctx.channel}${ctx.channel === "voice" ? " (your reply will be spoken aloud)" : ""}`,
  ];
  if (ctx.memories.length > 0) {
    lines.push("Things the user asked you to remember:");
    for (const m of ctx.memories) lines.push(`[#${m.id}] ${m.text}`);
  }
  lines.push("</context>");
  return lines.join("\n");
}
