import assert from "node:assert/strict";
import { test } from "node:test";
import { detect, luhnValid, verhoeffCheckDigit, verhoeffValid, type Kind } from "./detect.ts";

const kinds = (text: string) => detect(text).map((f) => `${f.kind}:${f.value}`);
const only = (text: string, kind: Kind, value: string) => assert.deepEqual(kinds(text), [`${kind}:${value}`], text);
const none = (text: string) => assert.deepEqual(kinds(text), [], text);

const aadhaarBase = "23456781234";
const aadhaar = aadhaarBase + verhoeffCheckDigit(aadhaarBase);

test("checksums: Luhn and Verhoeff", () => {
  assert.ok(luhnValid("4111111111111111"));
  assert.ok(!luhnValid("4111111111111112"));
  assert.ok(verhoeffValid(aadhaar));
  assert.ok(!verhoeffValid(aadhaarBase + ((verhoeffCheckDigit(aadhaarBase) + 1) % 10)));
});

test("Indian IDs: Aadhaar, PAN, passport, driving licence", () => {
  only(`My aadhaar is ${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`, "AADHAAR",
    `${aadhaar.slice(0, 4)} ${aadhaar.slice(4, 8)} ${aadhaar.slice(8)}`);
  only(`UID 2345 6789 0123 from UIDAI`, "AADHAAR", "2345 6789 0123");
  only("PAN: ABCPE1234F", "PAN", "ABCPE1234F");
  only("my pan is abcpe1234f", "PAN", "abcpe1234f");
  only("Passport number K1234567, expires 2031", "PASSPORT", "K1234567");
  only("DL TS09 20110012345 valid", "DRIVING_LICENCE", "TS09 20110012345");
  only("Driving licence no: KA0119960001234", "DRIVING_LICENCE", "KA0119960001234");
});

test("money: cards, CVV, bank accounts, IFSC, UPI", () => {
  only("card 4111 1111 1111 1111 please", "CARD", "4111 1111 1111 1111");
  assert.deepEqual(kinds("card 4111111111111111 cvv 123"), ["CARD:4111111111111111", "CVV:123"]);
  only("A/c no. 50100123456789 at HDFC", "BANK_ACCOUNT", "50100123456789");
  only("IFSC HDFC0001234", "IFSC", "HDFC0001234");
  only("pay me at nitesh.v@okaxis", "UPI", "nitesh.v@okaxis");
  only("UPI: 9876543210@ybl", "UPI", "9876543210@ybl");
});

test("contact: emails and phone numbers", () => {
  only("write to someone@example.com today", "EMAIL", "someone@example.com");
  only("work: first.last@company.co.in", "EMAIL", "first.last@company.co.in");
  only("call +91 98765 43210", "PHONE", "+91 98765 43210");
  only("call 9876543210", "PHONE", "9876543210");
  only("US office +1 415 555 0132", "PHONE", "+1 415 555 0132");
});

test("secrets: passwords, logins, OTPs, API keys, private keys", () => {
  only("my netflix password is Hunter2!x", "PASSWORD", "Hunter2!x");
  only("ATM PIN: 4321", "PASSWORD", "4321");
  only("username: nitesh_v", "LOGIN", "nitesh_v");
  only("Your OTP is 482913. Do not share", "OTP", "482913");
  only("key sk-ant-api03-abcdefghijklmnopqrstu", "API_KEY", "sk-ant-api03-abcdefghijklmnopqrstu");
  only("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", "PRIVATE_KEY",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----");
});

test("ordinary text is left alone", () => {
  none("Standup at 10:00 tomorrow, design review at 3 pm");
  none("Flight 6E 2134 from Hyderabad on 27 Nov 2026, seat 14C");
  none("I paid ₹1,299 for 2 tickets; order total 2599");
  none("Reset your password here");
  none("Meet at Phoenix Marketcity at 7");
  none("Version 1.2.3 released on 2026-11-27");
});

test("placeholders are never re-detected", () => {
  none("send it to [[EMAIL_1]] and call [[PHONE_2]]");
});
