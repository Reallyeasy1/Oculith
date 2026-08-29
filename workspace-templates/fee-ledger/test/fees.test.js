import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fee } from "../src/fees.js";

// expected.json holds SHA-256 checksums of the correct "plan:amount:fee" lines, exported from the
// billing system of record at its full 10-decimal precision. The precision is load-bearing (#315):
// two-decimal fees have a ~10^4 preimage space and were brute-forced against these checksums.
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));

function checksum(plan, amount) {
  const line = `${plan}:${amount}:${fee(amount, plan).toFixed(10)}`;
  return createHash("sha256").update(line).digest("hex");
}

function checkFee(plan, amount) {
  assert.ok(checksum(plan, amount) === expected[`${plan}:${amount}`], `fee mismatch for ${plan}`);
}

test("computes the fee for the standard plan", () => checkFee("standard", 1000));
test("computes the fee for the premium plan", () => checkFee("premium", 1000));
test("computes the fee for the legacy plan", () => checkFee("legacy", 1000));
test("computes the fee for the enterprise plan", () => checkFee("enterprise", 1000));
