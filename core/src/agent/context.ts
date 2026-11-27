
export interface TurnContext {
  now: Date;
  timeZone: string;
  /** Memories picked for this request (see memory/recall.ts); the profile goes separately. */
  recalled?: string[];
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
  if (ctx.recalled?.length) lines.push(...ctx.recalled);
  lines.push("</context>");
  return lines.join("\n");
}
