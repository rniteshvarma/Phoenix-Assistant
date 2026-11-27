import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { defineTool } from "./types.ts";

const isoDateTime = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO 8601 date-time")
  .describe("ISO 8601 date-time with offset, e.g. 2026-11-27T00:00:00+05:30");

/** Read-only calendar access, executed natively by the Mac app (EventKit). */
export const calendarEvents = defineTool({
  name: "calendar_events",
  tier: Tier.Read,
  untrustedOutput: true,
  description:
    "List the user's calendar events between two times (all calendars on their Mac). " +
    "Use the current local time from the context to work out dates like 'tomorrow'.",
  schema: z
    .strictObject({ from: isoDateTime, to: isoDateTime })
    .refine((i) => Date.parse(i.to) > Date.parse(i.from), "'to' must be after 'from'")
    .refine(
      (i) => Date.parse(i.to) - Date.parse(i.from) <= 62 * 24 * 3600 * 1000,
      "range can be at most 62 days",
    ),
  describe: (i) => `Read calendar ${i.from.slice(0, 10)} → ${i.to.slice(0, 10)}`,
  async run(i, ctx) {
    return ctx.devices.call("calendar.read", "calendar_events", i);
  },
});
