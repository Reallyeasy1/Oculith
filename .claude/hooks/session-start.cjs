#!/usr/bin/env node
// SessionStart: print branch, dirty files, and open P0 issues so every session starts oriented.
// stdout is added to Claude's context. Never fails the session.
const { execFileSync } = require("node:child_process");
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: process.platform === "win32" }).trim();
  } catch {
    return "";
  }
};
const branch = run("git", ["branch", "--show-current"]);
const dirty = run("git", ["status", "--short"]);
let issues = "";
try {
  const raw = run("gh", ["issue", "list", "--label", "P0", "--state", "open", "--limit", "20", "--json", "number,title,milestone"]);
  issues = JSON.parse(raw || "[]")
    .map((i) => `#${i.number} [${i.milestone?.title ?? "-"}] ${i.title}`)
    .join("\n");
} catch {
  issues = "";
}
const out = [
  `Oculith session — branch: ${branch || "?"}${dirty ? ` — ${dirty.split("\n").length} uncommitted file(s)` : " — clean"}`,
  issues ? `Open P0 issues:\n${issues}` : "Open P0 issues: (gh unavailable or none)",
  "Workflow: pick an issue → /start-issue N → branch feat/N-slug → tests first → npm run check → commit referencing #N.",
];
process.stdout.write(out.join("\n") + "\n");
