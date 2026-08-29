#!/usr/bin/env node
/* Layout measurement for #201: loads the built app at laptop widths and reports
 * document scrollWidth vs clientWidth on the agent view, All runs, and an open trace,
 * plus whether the sidebar brand text overflows its column.
 *
 *   PORT=3221 APP_AUTH_TOKEN=... node scripts/dev/measure-layout.cjs [--shots DIR]
 *
 * Playwright is deliberately not in package.json (same rule as scripts/e2e/driver.cjs);
 * set PLAYWRIGHT_DIR to a directory whose node_modules holds playwright.
 */
"use strict";

const path = require("path");

const BASE = process.env.LAUNCHPAD_URL || "http://127.0.0.1:" + (process.env.PORT || "3221");
const TOKEN = process.env.APP_AUTH_TOKEN || "";
const shotsAt = process.argv.indexOf("--shots");
const SHOT_DIR = shotsAt !== -1 ? process.argv[shotsAt + 1] : null;

function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  try { return require(dir ? require.resolve("playwright", { paths: [dir] }) : "playwright"); } catch {
    throw new Error("playwright is not resolvable. Set PLAYWRIGHT_DIR (see scripts/e2e/driver.cjs).");
  }
}

const SIZES = [
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
  { width: 800, height: 600 },
];

async function measure(page, label) {
  const m = await page.evaluate(() => {
    const doc = document.documentElement;
    const cw = doc.clientWidth;
    // Widest offenders: elements whose border box extends past the viewport's right edge.
    const offenders = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.right > cw + 1 && r.width > 0) {
        offenders.push(el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : "") + " right=" + Math.round(r.right));
      }
    }
    const brand = document.querySelector(".brand");
    const sidebar = document.querySelector(".sidebar");
    let brandClipped = null;
    if (brand && sidebar) {
      const strong = brand.querySelector("strong");
      brandClipped = strong
        ? strong.getBoundingClientRect().right > sidebar.getBoundingClientRect().right + 1 ||
          strong.scrollWidth > strong.clientWidth + 1
        : false;
    }
    return { scrollWidth: doc.scrollWidth, clientWidth: cw, brandClipped, offenders: offenders.slice(0, 6) };
  });
  const flag = m.scrollWidth > m.clientWidth ? "  << H-SCROLL" : "";
  console.log(
    "  " + label.padEnd(12) + " scrollWidth=" + m.scrollWidth + " clientWidth=" + m.clientWidth +
    " brandClipped=" + m.brandClipped + flag,
  );
  if (m.scrollWidth > m.clientWidth && m.offenders.length) {
    for (const o of m.offenders) console.log("      offender: " + o);
  }
  return m;
}

async function main() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  let bad = 0;
  try {
    for (const size of SIZES) {
      console.log("\n=== " + size.width + "x" + size.height + " ===");
      const context = await browser.newContext({ viewport: size });
      const page = await context.newPage();
      await page.goto(BASE + "/", { waitUntil: "networkidle" });
      if (await page.locator("input[type=password]").count()) {
        await page.locator("input[type=password]").fill(TOKEN);
        await page.keyboard.press("Enter");
      }
      await page.locator(".app-shell").waitFor({ timeout: 15000 });
      await page.waitForTimeout(1500);

      // 1) agent view (default: first Agent selected)
      let m = await measure(page, "agent");
      if (m.scrollWidth > m.clientWidth || m.brandClipped) bad++;
      if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, "agent-" + size.width + ".png"), fullPage: false });

      // 2) All runs overview
      await page.locator(".overview-nav .agent-card").click();
      await page.waitForTimeout(1500);
      m = await measure(page, "all-runs");
      if (m.scrollWidth > m.clientWidth || m.brandClipped) bad++;
      if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, "all-runs-" + size.width + ".png"), fullPage: false });

      // 3) trace open (first row of the Runs table)
      const rows = page.locator(".runs-table tbody tr[data-run-id]");
      if (await rows.count()) {
        await rows.first().click();
        await page.locator(".trace-detail").waitFor({ timeout: 15000 });
        await page.waitForTimeout(1000);
        m = await measure(page, "trace");
        if (m.scrollWidth > m.clientWidth || m.brandClipped) bad++;
        if (SHOT_DIR) await page.screenshot({ path: path.join(SHOT_DIR, "trace-" + size.width + ".png"), fullPage: false });
      } else {
        console.log("  trace        skipped (no runs)");
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  console.log("\n" + (bad === 0 ? "PASS: no page-level horizontal scroll, brand intact." : "FAIL: " + bad + " view(s) overflow or clip the brand."));
  process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
