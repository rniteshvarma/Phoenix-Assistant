import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { DEFAULT_SCREEN_APPS, NEVER_APPS, runScreenSession } from "../screen/session.ts";
import type { SettingsStore } from "../proactive/schedule.ts";
import { defineTool } from "./types.ts";

/** Apps the user allowed Phoenix to operate on screen (`phoenix screen allow <App>`). */
export function allowedScreenApps(settings: SettingsStore): string[] {
  return settings.get<string[]>("screen.apps", DEFAULT_SCREEN_APPS);
}

export const screenAct = defineTool({
  name: "screen_act",
  tier: Tier.Act,
  description:
    "Operate one app on the user's Mac screen (clicking and typing like a person) to do a task that no other tool can do, " +
    "e.g. WhatsApp Desktop, a website in Safari/Chrome, or an iPhone app through the 'iPhone Mirroring' app. " +
    "Prefer dedicated tools (reminders, calendar, iMessage, notes) when they fit. Needs the user's approval to start; " +
    "final steps (send, submit, book) are approved again on the way, and payments are never made — Phoenix stops before paying. " +
    "Give the exact app name and a complete goal, including any text to send.",
  schema: z.strictObject({
    app: z.string().min(1).max(60).describe('App name, e.g. "WhatsApp", "Safari", "iPhone Mirroring"'),
    goal: z.string().min(3).max(1000).describe("What to do, in full, e.g. 'Send \"Running 10 min late\" to Ankit'"),
  }),
  // The quoted message in a goal like: Send "Running late" to Ankit.
  styleSample: (i) => {
    const quoted = /["“]([^"”]{2,600})["”]/.exec(i.goal)?.[1];
    const to = /\bto\s+([\p{L}][\p{L} .'-]{0,40}?)(?:\s+on\b|[.,]|$)/u.exec(i.goal)?.[1]?.trim();
    return quoted ? { subject: to ? `${to} (${i.app})` : i.app, text: quoted } : null;
  },
  describe: (i) => `Use ${i.app} on your screen: ${i.goal.length > 120 ? `${i.goal.slice(0, 117)}…` : i.goal}`,
  async run(i, ctx) {
    if (NEVER_APPS.test(i.app)) throw new Error(`Phoenix never operates ${i.app} (banking, payment, password or system app)`);
    const allowed = allowedScreenApps(ctx.settings);
    if (!allowed.some((a) => a.toLowerCase() === i.app.toLowerCase())) {
      throw new Error(
        `${i.app} isn't on the list of apps Phoenix may operate (${allowed.join(", ")}). ` +
          `Tell the user they can allow it with: npm run phoenix -- screen allow "${i.app}"`,
      );
    }
    const model = ctx.session?.screenModel?.();
    if (!model || !ctx.session) throw new Error("screen control isn't available here (it needs Claude and the Phoenix Mac app)");
    if (!ctx.devices.has("screen")) throw new Error("screen control needs the Phoenix Mac app, which isn't connected");
    return runScreenSession(i.app, i.goal, {
      devices: ctx.devices,
      vault: ctx.vault,
      model,
      confirm: ctx.session.confirm,
      signal: ctx.session.signal,
    });
  },
});
