#!/usr/bin/env node
// SessionStart: print branch, dirty files, open P0 issues, and — for parallel work — what is already taken:
// claimed issues (in-progress / in-review), open PRs, active worktrees and branch owners. Never fails the session.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000, shell: process.platform === "win32" }).trim();
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
const p0 = json(run("gh", ["issue", "list", "--label", "P0", "--state", "open", "--limit", "20", "--json", "number,title,milestone,labels,assignees"]))
  .map((i) => `#${i.number} [${i.milestone?.title ?? "-"}]${i.labels?.some((l) => /^in-(progress|review)$/.test(l.name)) ? " (claimed by " + (i.assignees?.[0]?.login ?? "?") + ")" : ""} ${i.title}`)
  .join("\n");
const claimed = ["in-progress", "in-review"]
  .flatMap((label) => json(run("gh", ["issue", "list", "--label", label, "--state", "open", "--limit", "30", "--json", "number,title,assignees"])).map((i) => `#${i.number} ${label} ${i.assignees?.map((a) => a.login).join(",") || "unassigned"} — ${i.title}`))
  .join("\n");
const prs = json(run("gh", ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,baseRefName"]))
  .map((p) => `#${p.number} ${p.headRefName} → ${p.baseRefName} — ${p.title}`)
  .join("\n");
const worktrees = run("git", ["worktree", "list", "--porcelain"])
  .split("\n")
  .filter((l) => l.startsWith("worktree "))
  .map((l) => l.slice(9))
  .filter((w) => !/[\\/]Oculith$/.test(w));

// Branch owners live in the shared .git dir; drop entries whose branch no longer exists or that are older than 24 h.
let owners = "";
const commonDir = run("git", ["rev-parse", "--git-common-dir"]);
const ownersFile = commonDir ? path.resolve(commonDir, "oculith-branch-owners.json") : "";
if (ownersFile && fs.existsSync(ownersFile)) {
  try {
    const map = JSON.parse(fs.readFileSync(ownersFile, "utf8"));
    const live = new Set(run("git", ["branch", "--format=%(refname:short)"]).split("\n").map((s) => s.trim()));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    for (const [b, o] of Object.entries(map)) if (!live.has(b) || Date.parse(o.at) < cutoff) delete map[b];
    fs.writeFileSync(ownersFile, JSON.stringify(map, null, 2));
    owners = Object.entries(map).map(([b, o]) => `${b} ← session ${String(o.session).slice(0, 8)}… (${o.at})`).join("\n");
  } catch {
    owners = "";
  }
}

const out = [
  `Oculith session — branch: ${branch || "?"}${dirty ? ` — ${dirty.split("\n").length} uncommitted file(s)` : " — clean"}`,
  p0 ? `Open P0 issues:\n${p0}` : "Open P0 issues: (gh unavailable or none)",
  claimed ? `Claimed issues (do not start these):\n${claimed}` : "Claimed issues: none",
  prs ? `Open PRs:\n${prs}` : "Open PRs: none",
  worktrees.length ? `Active worktrees (agents in flight — the main tree is the controller's):\n${worktrees.join("\n")}` : "Active worktrees: none",
  owners ? `Branch owners (other sessions' branches are read-only for you):\n${owners}` : "Branch owners: none recorded",
  "Workflow: bash scripts/dev/claim-issue.sh N → git switch -c feat/N-slug origin/main → tests first → npm run check → /finish-issue N → bash scripts/dev/merge-prs.sh <pr>. Rule: .claude/rules/parallel-work.md",
];
process.stdout.write(out.join("\n") + "\n");
