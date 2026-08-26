#!/usr/bin/env node
// SessionStart: print branch, dirty files, open P0 issues, and — for parallel work — what is already taken:
// claimed issues (in-progress / in-review), open PRs, active worktrees, and this machine's issue/branch owners.
// Two gh calls total (each 8 s max); never fails the session.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const run = (cmd, args, timeout = 8000) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim();
  } catch {
    return "";
  }
};
const json = (raw) => {
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
};
const branch = run("git", ["branch", "--show-current"]);
const dirty = run("git", ["status", "--short"]);
const issues = json(run("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,milestone,labels,assignees"]));
const has = (i, name) => i.labels?.some((l) => l.name === name);
const claimOf = (i) => (has(i, "in-progress") ? "in-progress" : has(i, "in-review") ? "in-review" : "");
const p0 = issues
  .filter((i) => has(i, "P0"))
  .map((i) => `#${i.number} [${i.milestone?.title ?? "-"}]${claimOf(i) ? ` (${claimOf(i)}: ${i.assignees?.map((a) => a.login).join(",") || "?"})` : ""} ${i.title}`)
  .join("\n");
const claimed = issues
  .filter((i) => claimOf(i))
  .map((i) => `#${i.number} ${claimOf(i)} ${i.assignees?.map((a) => a.login).join(",") || "unassigned"} — ${i.title}`)
  .join("\n");
const prs = json(run("gh", ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName"]))
  .map((p) => `#${p.number} ${p.headRefName} → ${p.baseRefName} — ${p.title}`)
  .join("\n");
const worktrees = run("git", ["worktree", "list", "--porcelain"])
  .split("\n")
  .filter((l) => l.startsWith("worktree "))
  .map((l) => l.slice(9))
  .filter((w) => !/[\\/]Oculith$/.test(w));

// Owners live in the shared .git dir. Prune branch entries whose branch is gone; keep issue claims until the
// issue is no longer open (claims outlive branches on purpose: the claim is the lock).
let owners = "";
const commonDir = run("git", ["rev-parse", "--git-common-dir"]);
const stateFile = commonDir ? path.resolve(commonDir, "oculith-branch-owners.json") : "";
if (stateFile && fs.existsSync(stateFile)) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const branches = s.branches ?? {};
    const claims = s.issues ?? {};
    const live = new Set(run("git", ["branch", "--format=%(refname:short)"]).split("\n").map((x) => x.trim()));
    for (const b of Object.keys(branches)) if (!live.has(b)) delete branches[b];
    const openNums = new Set(issues.map((i) => String(i.number)));
    if (issues.length) for (const n of Object.keys(claims)) if (!openNums.has(n)) delete claims[n];
    fs.writeFileSync(stateFile, JSON.stringify({ branches, issues: claims }, null, 2));
    owners = [
      ...Object.entries(claims).map(([n, o]) => `issue #${n} ← session ${String(o.session).slice(0, 8)}… (${o.at})`),
      ...Object.entries(branches).map(([b, o]) => `${b} ← session ${String(o.session).slice(0, 8)}… (${o.at})`),
    ].join("\n");
  } catch {
    owners = "";
  }
}

const out = [
  `Oculith session — branch: ${branch || "?"}${dirty ? ` — ${dirty.split("\n").length} uncommitted file(s)` : " — clean"}`,
  p0 ? `Open P0 issues:\n${p0}` : issues.length ? "Open P0 issues: none" : "Open issues: (gh unavailable)",
  claimed ? `Claimed issues (do not start these):\n${claimed}` : "Claimed issues: none",
  prs ? `Open PRs:\n${prs}` : "Open PRs: none",
  worktrees.length ? `Active worktrees (agents in flight — the main tree is the controller's):\n${worktrees.join("\n")}` : "Active worktrees: none",
  owners ? `This machine's claims and branch owners (other sessions' are read-only for you):\n${owners}` : "Local claims/branch owners: none recorded",
  "Workflow: bash scripts/dev/claim-issue.sh N (assign yourself — the hook refuses to create feat/N-* otherwise) → git switch -c feat/N-slug origin/main → tests first → npm run check → /finish-issue N → bash scripts/dev/merge-prs.sh <pr>. Rule: .claude/rules/parallel-work.md",
];
process.stdout.write(out.join("\n") + "\n");
