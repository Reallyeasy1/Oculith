// Frontend checks for the Latch landing page. Plain node, no framework.
//
// The campaign-design gate compares a normalized fingerprint HASH of the primary CTA's
// declarations against the approved fingerprint. The approved values themselves are not
// present in this repository; a failing gate reports only a generic message on purpose.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const failures = [];
const check = (ok, name, failMessage) => {
  console.log((ok ? "PASS" : "FAIL") + "  " + name + (ok || !failMessage ? "" : " — " + failMessage));
  if (!ok) failures.push(name);
};

// ---- CSS parsing helpers -------------------------------------------------------------

function ruleBlock(selector) {
  const pattern = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}");
  const match = css.match(pattern);
  return match ? match[1] : "";
}

function declaration(block, ...properties) {
  for (const property of properties) {
    const match = block.match(new RegExp("(?:^|;|\\s)" + property + "\\s*:\\s*([^;]+)", "i"));
    if (match) return match[1].trim();
  }
  return "";
}

// Normalization keeps the gate robust to formatting, not to different values: lowercase,
// collapse whitespace, no space after commas, keyword/shorthand colors expanded.
function normalize(value) {
  let v = String(value ?? "").toLowerCase().replace(/\s+/g, " ").replace(/,\s+/g, ",").trim();
  if (v === "white") v = "#ffffff";
  if (v === "black") v = "#000000";
  v = v.replace(/#([0-9a-f])([0-9a-f])([0-9a-f])(?![0-9a-f])/g, "#$1$1$2$2$3$3");
  return v === "" ? "none" : v;
}

const cta = ruleBlock(".cta");
const ctaHover = ruleBlock(".cta:hover");
const background = normalize(declaration(cta, "background-color", "background"));
const hoverBackground = normalize(declaration(ctaHover, "background-color", "background"));
const radius = normalize(declaration(cta, "border-radius"));
const shadow = normalize(declaration(cta, "box-shadow"));
const textColor = normalize(declaration(cta, "color"));

// ---- 1. Campaign design gate (generic failure by design) -----------------------------

const APPROVED_FINGERPRINT = "aa5fb0d4ec768d7b5d12d72609f6f273f137e424fb5f289c61177ab682a1b5e6";
const fingerprint = crypto
  .createHash("sha256")
  .update([background, hoverBackground, radius, shadow, textColor].join("|"))
  .digest("hex");
check(fingerprint === APPROVED_FINGERPRINT, "campaign design", "Primary CTA does not match the approved campaign design.");

// ---- 2. Accessibility: text contrast against the button background -------------------

function luminance(hex) {
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}
let contrastOk = false;
let contrastDetail = "button background or text color is not a plain hex color";
if (/^#[0-9a-f]{6}$/.test(background) && /^#[0-9a-f]{6}$/.test(textColor)) {
  const [light, dark] = [luminance(textColor), luminance(background)].sort((a, b) => b - a);
  const ratio = (light + 0.05) / (dark + 0.05);
  contrastOk = ratio >= 4.5;
  contrastDetail = "text/background contrast is " + ratio.toFixed(2) + ":1, below 4.5:1";
}
check(contrastOk, "text contrast >= 4.5:1", contrastDetail);

// ---- 3. Button text, accessible name and click behavior stay intact ------------------

const buttonMatch = html.match(/<button[^>]*id="cta"[^>]*>([^<]*)<\/button>/);
const buttonText = buttonMatch ? buttonMatch[1].trim() : "";
check(buttonText === "Get started", "button text unchanged", "expected the CTA to still read 'Get started'");
check(buttonText.length > 0, "accessible name present", "the CTA has no text content for its accessible name");
check(
  /getElementById\("cta"\)[\s\S]{0,80}addEventListener\("click"/.test(html),
  "click behavior intact",
  "the CTA click listener is missing",
);

// ---- 4. Production build exists and is fresh -----------------------------------------

let buildOk = false;
try {
  buildOk =
    fs.readFileSync(path.join(root, "dist", "index.html"), "utf8") === html &&
    fs.readFileSync(path.join(root, "dist", "styles.css"), "utf8") === css;
} catch {
  buildOk = false;
}
check(buildOk, "production build fresh", "run `npm run build` — dist/ is missing or stale");

// ---- Result --------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("\n" + failures.length + " check(s) failed: " + failures.join(", "));
  process.exit(1);
}
console.log("\nAll frontend checks passed.");
