/**
 * Playbooks that ship with Phoenix (read-only). They sit next to the user's own skills: only the
 * names and one-line descriptions go with each request; the steps when a request matches.
 * A user skill with the same name takes precedence.
 */
export interface BuiltinSkill { id: number; name: string; description: string; steps: string; builtin: true }

const COMMON_END = `
- After the user says they've paid: save the trip as a project memory (dates, PNR/booking ID, address, check-in times)
  and add reminders (web check-in 48 h before a flight, leave-for-airport time, hotel check-in). Ask before adding them.
- Never pay, never enter card numbers, CVVs, OTPs or UPI PINs, never sign in or solve CAPTCHAs for the user: stop and hand over.`;

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: -1,
    builtin: true,
    name: "Book a flight",
    description: "Find, compare and book a flight up to the payment page",
    steps: `1. Get only what's missing: from, to, date, time window, budget, travellers, cabin. Use memory (home city, airline/seat preferences) instead of asking.
2. Look up current options with web_search (fares change; say when the prices are from).
3. Open the user's usual site in Safari or Chrome with screen_act (default: Google Flights to compare, then the airline or MakeMyTrip to book) and search.
4. Show the best 3 options in one short list: airline + flight no., times, duration, stops, fare, baggage, refundability. Recommend one and say why.
5. When the user picks: call booking_review with the full breakdown (base, taxes, fees, add-ons, total ₹), cancellation rules and where they'll pay.
6. If approved: screen_act to fill traveller details (names from memory; ID numbers only as placeholders, which needs the user's OK twice) and continue to the payment page. Stop there and tell the user it's ready for them to pay.${COMMON_END}`,
  },
  {
    id: -2,
    builtin: true,
    name: "Book a hotel",
    description: "Find, compare and book a hotel or stay up to the payment page",
    steps: `1. Get only what's missing: city/area, check-in and check-out dates, guests, rooms, budget per night, must-haves.
2. Search current options with web_search, then the user's usual site (Booking.com, MakeMyTrip, Agoda, the hotel's own site) with screen_act.
3. Show the best 3: name, area and distance to where they need to be, rating and number of reviews, price per night and total with taxes, cancellation policy. Recommend one.
4. When the user picks: booking_review with nights, guests, price breakdown, cancellation deadline and where they'll pay.
5. If approved: fill guest details up to the payment page and stop.${COMMON_END}`,
  },
  {
    id: -3,
    builtin: true,
    name: "Book a train (IRCTC)",
    description: "Check availability and book an Indian Railways train up to payment",
    steps: `1. Get: from and to stations, date, class (SL/3A/2A/1A/CC), quota (general or Tatkal), travellers.
2. Check trains and availability (web_search, or the IRCTC site with screen_act). Show the best 3: train no. and name, times, duration, availability/waitlist, fare.
3. IRCTC needs the user's own login and CAPTCHA: ask them to sign in themselves, then continue.
4. When the user picks: booking_review with the fare breakdown and IRCTC's cancellation rules. Tatkal opens at 10:00 (AC) / 11:00 (non-AC) the day before: mention it if relevant.
5. If approved: fill passenger details up to the payment page and stop.${COMMON_END}`,
  },
  {
    id: -4,
    builtin: true,
    name: "Book a cab",
    description: "Get an Uber/Ola ride ready to confirm in iPhone Mirroring",
    steps: `1. Get pickup (default: where the user is or home from memory), drop, and time (now or scheduled).
2. Open the app in iPhone Mirroring with screen_act; enter pickup and drop; read the ride options and fares.
3. Tell the user the options (type, fare, ETA) and recommend one.
4. Requesting the ride is a final step: call confirm_step with the ride type, fare and pickup, and only then tap Request/Confirm.
5. Payment stays with the user's app settings; never change payment methods.`,
  },
];
