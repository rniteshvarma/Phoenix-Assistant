/**
 * On-device detection of sensitive data. Runs locally before anything is sent to a cloud
 * service; what it finds is swapped for placeholders by the PrivacyVault.
 *
 * Detection favours catching too much over too little: a needless placeholder costs a little
 * clarity, a missed ID number would leak it.
 */

export const KINDS = [
  "PRIVATE_KEY", "API_KEY", "PASSWORD", "LOGIN", "OTP", "CVV", "CARD", "AADHAAR", "BANK_ACCOUNT",
  "IFSC", "PAN", "PASSPORT", "DRIVING_LICENCE", "EMAIL", "UPI", "PHONE",
] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  PRIVATE_KEY: "private key",
  API_KEY: "API key",
  PASSWORD: "password or PIN",
  LOGIN: "login ID",
  OTP: "one-time code",
  CVV: "card security code",
  CARD: "card number",
  AADHAAR: "Aadhaar number",
  BANK_ACCOUNT: "bank account number",
  IFSC: "IFSC code",
  PAN: "PAN",
  PASSPORT: "passport number",
  DRIVING_LICENCE: "driving licence number",
  EMAIL: "email address",
  UPI: "UPI ID",
  PHONE: "phone number",
};

export interface Finding {
  kind: Kind;
  start: number;
  end: number;
  value: string;
}

interface Rule {
  kind: Kind;
  re: RegExp;
  /** Capture group holding the value (the rest of the match is context, e.g. "PAN:"). */
  group?: number;
  accept?: (value: string, text: string, start: number) => boolean;
}

const digitsOf = (s: string) => s.replace(/\D/g, "");

function near(text: string, index: number, keyword: RegExp, window = 48): boolean {
  return keyword.test(text.slice(Math.max(0, index - window), index + window));
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

// Verhoeff checksum, used by Aadhaar numbers.
const VD = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VP = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7], [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 0, 3, 9, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VINV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i += 1) c = VD[c]![VP[i % 8]![Number(rev[i])]!]!;
  return c === 0;
}

/** Check digit that makes `digits` + it Verhoeff-valid (used to build test data). */
export function verhoeffCheckDigit(digits: string): number {
  let c = 0;
  const rev = digits.split("").reverse();
  for (let i = 0; i < rev.length; i += 1) c = VD[c]![VP[(i + 1) % 8]![Number(rev[i])]!]!;
  return VINV[c]!;
}

const SEP = "[^\\S\\n]*(?:is|:|=|-|–)?[^\\S\\n]*";

/** "password: x" / "pin is 1234" — or, without a separator, a value that looks like a secret. */
function secretLike(value: string, text: string, start: number): boolean {
  const hasSeparator = /(?:\bis|:|=|-|–)[^\S\n]*$/i.test(text.slice(Math.max(0, start - 8), start));
  return hasSeparator || /[\d\W_]/.test(value);
}

/** Rules in priority order: when matches overlap, the earlier rule wins. */
const RULES: Rule[] = [
  { kind: "PRIVATE_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  {
    kind: "API_KEY",
    re: /\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35})/g,
  },
  {
    kind: "PASSWORD",
    re: new RegExp(`\\b(?:password|passwd|pwd|passcode|pass code|login pin|m-?pin|atm pin|upi pin|card pin|pin)\\b${SEP}([^\\s,;]{3,64})`, "gi"),
    group: 1,
    accept: (v, text, start) =>
      secretLike(v, text, start) && !/^(?:is|was|for|to|of|the|and|reset|change|changed|expired|required|code)$/i.test(v),
  },
  {
    kind: "LOGIN",
    re: new RegExp(`\\b(?:username|user name|user id|userid|login id|login name|customer id|net ?banking id)\\b${SEP}([^\\s,;]{3,64})`, "gi"),
    group: 1,
    accept: secretLike,
  },
  {
    kind: "OTP",
    re: /\b(?:otp|one[- ]time (?:password|code|pin)|verification code|security code|auth(?:entication)? code|login code)\b[^0-9\n]{0,24}(\d{4,8})\b/gi,
    group: 1,
  },
  { kind: "CVV", re: /\b(?:cvv2?|cvc2?|card verification (?:value|code))\b[^0-9\n]{0,12}(\d{3,4})\b/gi, group: 1 },
  {
    kind: "BANK_ACCOUNT",
    re: /\b(?:a\/c|acc(?:oun)?t|bank account|savings account|current account)(?:[^\S\n]*(?:no\.?|number|num|#))?[^\S\n]*(?:is|:|-)?[^\S\n]*(\d[\d -]{7,20}\d)\b/gi,
    group: 1,
    accept: (v) => {
      const n = digitsOf(v).length;
      return n >= 9 && n <= 18;
    },
  },
  {
    kind: "CARD",
    re: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (v) => {
      const d = digitsOf(v);
      return d.length >= 13 && d.length <= 19 && luhnValid(d);
    },
  },
  {
    kind: "AADHAAR",
    re: /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g,
    accept: (v, text, start) => verhoeffValid(digitsOf(v)) || near(text, start, /aadh?aa?r|\buid\b|uidai|आधार/i),
  },
  { kind: "IFSC", re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g },
  {
    kind: "PAN",
    re: /\b[A-Za-z]{3}[PCHFATBLJGpchfatbljg][A-Za-z]\d{4}[A-Za-z]\b/g,
    accept: (v, text, start) => v === v.toUpperCase() || near(text, start, /\bpan\b/i),
  },
  { kind: "PASSPORT", re: /\b[A-PR-WY][1-9]\d{6}\b/g },
  { kind: "DRIVING_LICENCE", re: /\b[A-Z]{2}[ -]?\d{2}[ -]?(?:19|20)\d{2}[ -]?\d{7}\b/g },
  {
    kind: "DRIVING_LICENCE",
    re: /\b(?:driving licen[cs]e|\bDL)(?:[^\S\n]*(?:no\.?|number|#))?[^\S\n]*(?:is|:|-)?[^\S\n]*([A-Z0-9][A-Z0-9 -]{7,18}[A-Z0-9])\b/gi,
    group: 1,
    accept: (v) => /\d{5,}/.test(v.replace(/[ -]/g, "")),
  },
  { kind: "EMAIL", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g },
  { kind: "UPI", re: /\b[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,30}\b(?![.@\w-])/g },
  { kind: "PHONE", re: /(?:\+91[^\S\n]?-?[^\S\n]?|\b0)?\b[6-9]\d{4}[^\S\n]?-?[^\S\n]?\d{5}\b/g },
  {
    kind: "PHONE",
    re: /\+\d{1,3}[^\S\n]?-?[^\S\n]?\(?\d{1,4}\)?(?:[^\S\n]?-?[^\S\n]?\d{2,4}){2,4}\b/g,
    accept: (v) => {
      const n = digitsOf(v).length;
      return n >= 8 && n <= 15;
    },
  },
];

/** Placeholders already in the text (e.g. [[EMAIL_1]]) are never detected again. */
export const PLACEHOLDER = /\[\[([A-Z_]+)_(\d+)\]\]/g;

/** Find sensitive values in `text`: non-overlapping, in order of appearance. */
export function detect(text: string): Finding[] {
  const taken: Array<[number, number]> = [];
  for (const m of text.matchAll(PLACEHOLDER)) taken.push([m.index!, m.index! + m[0].length]);
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  const found: Finding[] = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.includes("d") ? rule.re.flags : `${rule.re.flags}d`);
    for (const m of text.matchAll(re)) {
      const span = rule.group ? m.indices?.[rule.group] : m.indices?.[0];
      if (!span) continue;
      const [start, end] = span;
      const value = text.slice(start, end);
      if (rule.accept && !rule.accept(value, text, start)) continue;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      found.push({ kind: rule.kind, start, end, value });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}
