import { z } from "zod";
import { Tier } from "../policy/tiers.ts";
import { defineTool } from "./types.ts";

/**
 * Phase 6: the Booking Approval Card. Before Phoenix fills in any booking, it puts the whole deal
 * in front of the user: what, when, who, the price breakdown in ₹, the cancellation rules and how
 * they'll pay. Approving lets Phoenix fill everything up to the payment page; paying, OTPs and
 * UPI PINs always stay with the user.
 */

const money = z.number().nonnegative().max(10_000_000);

export const bookingReview = defineTool({
  name: "booking_review",
  tier: Tier.Act,
  description:
    "Show the user a Booking Approval Card for a flight, hotel, train, cab or other booking, before filling in any booking form. " +
    "Include every leg or night, the travellers (names only), the full price breakdown in INR, the cancellation/refund rules and " +
    "where they'll pay. If approved, fill in the booking up to the payment page (screen_act) and stop there: the user pays.",
  schema: z.strictObject({
    kind: z.enum(["flight", "hotel", "train", "cab", "bus", "other"]),
    title: z.string().min(3).max(120).describe('e.g. "Hyderabad → Goa, Fri 12 Dec, IndiGo 6E 2134"'),
    site: z.string().min(2).max(80).describe("Where it will be booked, e.g. MakeMyTrip, IRCTC, the airline's site"),
    itinerary: z.array(z.string().min(2).max(200)).min(1).max(12).describe("One line per leg, night or segment, with times"),
    travellers: z.array(z.string().min(1).max(80)).max(9).default([]),
    price: z.strictObject({
      base: money.optional(),
      taxes: money.optional(),
      fees: money.optional(),
      addOns: money.optional(),
      total: money,
    }),
    cancellation: z.string().min(3).max(400).describe("Refund/cancellation rules as the site states them"),
    payment: z.string().min(3).max(200).describe("How the user will pay, e.g. 'You pay on MakeMyTrip (card or UPI)'"),
    notes: z.string().max(400).optional(),
  }),
  describe: (i) => `Book ${i.kind}: ${i.title} — ₹${i.price.total.toLocaleString("en-IN")} on ${i.site}`,
  async run(i) {
    const parts = [i.price.base, i.price.taxes, i.price.fees, i.price.addOns].filter((v): v is number => v !== undefined);
    const sum = parts.reduce((a, b) => a + b, 0);
    const mismatch = parts.length > 1 && Math.abs(sum - i.price.total) > 1;
    return [
      `Approved: ${i.title} for ₹${i.price.total.toLocaleString("en-IN")} on ${i.site}.`,
      mismatch ? `Note: the parts add up to ₹${sum.toLocaleString("en-IN")}, not the total; recheck the price on the site before the payment page.` : "",
      "Now fill everything in up to the payment page and stop there. Never pay, never enter card details, OTPs or UPI PINs, never sign in for the user. " +
        "If the final price on the site is higher than approved, stop and tell the user.",
    ].filter(Boolean).join(" ");
  },
});
