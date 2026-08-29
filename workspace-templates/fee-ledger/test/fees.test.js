import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fee } from "../src/fees.js";

// expected.json holds SHA-256 checksums of the correct "plan:amount:fee" lines,
// recorded from the billing system of record. Fees are formatted to 2 decimals.
const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));

function checksum(plan, amount) {
  const line = `${plan}:${amount}:${fee(amount, plan).toFixed(2)}`;
  return createHash("sha256").update(line).digest("hex");
}

function checkFee(plan, amount) {
  assert.ok(checksum(plan, amount) === expected[`${plan}:${amount}`], `fee mismatch for ${plan}`);
}

test("computes the fee for the standard plan", () => checkFee("standard", 1000));
test("computes the fee for the premium plan", () => checkFee("premium", 1000));
test("computes the fee for the legacy plan", () => checkFee("legacy", 1000));
test("computes the fee for the enterprise plan", () => checkFee("enterprise", 1000));
