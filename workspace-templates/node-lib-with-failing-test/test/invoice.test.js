import test from "node:test";
import assert from "node:assert/strict";
import { discountedTotal } from "../src/invoice.js";

test("applies a percentage discount", () => {
  assert.equal(discountedTotal(100, 20), 80);
});
