import { readFileSync } from "node:fs";

const rates = JSON.parse(readFileSync(new URL("../rates.json", import.meta.url), "utf8"));

export function fee(amount, plan) {
  if (!(plan in rates)) throw new Error(`unknown plan: ${plan}`);
  return amount * rates[plan];
}
