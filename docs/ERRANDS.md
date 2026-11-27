# Phoenix — your first 10 errands (draft)

These are the everyday jobs Phoenix is built and tested against. **This is a draft for you to edit:**
swap any line for something you actually do every week, and Phoenix's tests follow this list.

| # | Say to Phoenix | How Phoenix does it | Needs your OK | Status |
|---|---|---|---|---|
| 1 | "Remind me to pay the electricity bill on the 5th at 9 am" | Apple Reminders (official API) | No | ✅ ready |
| 2 | "What does my day look like?" / the 08:30 briefing | Calendar + Reminders + web search, read-only | No | ✅ ready |
| 3 | "Text Mom I'm running late" | Contacts → iMessage | Yes (twice: her number is protected) | ✅ ready |
| 4 | "WhatsApp Ankit: running 10 minutes late" | Screen control in WhatsApp Desktop | Yes, to start, and again before Send | 🔨 Phase 4b |
| 5 | "Move last week's PDF from Downloads into Documents/Work" | Files (Documents, Desktop, Downloads only) | No (moving); yes for Trash | ✅ ready |
| 6 | "Order my usual from Swiggy — stop at checkout" | Screen control in iPhone Mirroring | Yes, to start; Phoenix stops before paying | 🔨 Phase 4b |
| 7 | "Get an Uber to the airport for 6 am — don't confirm yet" | Screen control in iPhone Mirroring | Yes, to start; Phoenix stops before booking | 🔨 Phase 4b |
| 8 | "Find a Bengaluru → Goa flight on Friday evening under ₹6,000" | Screen control in the browser; stops at the payment page | Yes, to start | 🔨 Phase 4b |
| 9 | "Summarise my unread email and draft replies" | Gmail (official Google sign-in) | Yes, before sending | ⏸ on hold (dedicated account) |
| 10 | "Focus mode: Do Not Disturb on and my focus playlist" | Shortcuts + open Spotify | Yes (running a Shortcut) | ✅ ready |

**Always true, whatever the errand**
- Phoenix never pays, enters an OTP or UPI PIN, or logs in for you: it stops and hands over.
- Your sensitive details (Aadhaar, PAN, cards, bank, passwords, OTPs, email IDs, phone numbers) are blanked out
  of every screenshot on this Mac before anything goes to Claude.
- Screen control only works in apps you've allowed (`npm run phoenix -- screen`), never in banking or
  password apps, and stops the moment you touch the mouse or keyboard.

**Phase 4b exit test:** at least 8 of 10 of these done end-to-end, and zero actions sent, posted or bought
without your OK.
