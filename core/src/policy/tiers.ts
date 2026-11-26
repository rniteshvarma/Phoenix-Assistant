/**
 * Risk tiers (see docs/PHOENIX_EXECUTION_PLAN.md §4.1).
 *  T0 Read     - automatic
 *  T1 Prepare  - automatic, result shown as a draft
 *  T2 Act      - outward-facing or hard to undo: needs the user's approval
 *  T3 Money    - payments, bookings, deletion: approval + amount shown (+ OTP/PIN stays with the user)
 */
export const Tier = {
  Read: 0,
  Prepare: 1,
  Act: 2,
  Money: 3,
} as const;

export type Tier = (typeof Tier)[keyof typeof Tier];

export const TIER_LABEL: Record<Tier, string> = {
  0: "T0 · read",
  1: "T1 · prepare",
  2: "T2 · act",
  3: "T3 · money / irreversible",
};

export function requiresApproval(tier: Tier): boolean {
  return tier >= Tier.Act;
}
