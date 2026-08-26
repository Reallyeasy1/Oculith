#!/usr/bin/env node
// PreToolUse guard for Bash: block history-rewriting/unsafe git, keep parallel sessions from racing on branches
// and PRs, and scan staged changes for secrets before any commit.
// Exit 2 = block (stderr shown to Claude). Exit 0 = allow.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let hook = {};
  try {
    hook = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  const cmd = hook.tool_input?.command ?? "";
  if (!cmd) process.exit(0);
  const session = String(hook.session_id ?? "").slice(0, 64) || "unknown";
  const cwd = hook.cwd && fs.existsSync(hook.cwd) ? hook.cwd : process.cwd();

  const block = (why) => {
    process.stderr.write(`Blocked: ${why}\n`);
    process.exit(2);
  };
  const git = (args) => {
    try {
      return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    } catch {
      return "";
    }
  };

  // ---- unsafe git / secrets in the transcript --------------------------------------------------------------
  if (/git\s+push\b.*(--force\b|-f\b|--force-with-lease)/.test(cmd)) block("force push rewrites shared history; open an issue and ask the user instead.");
  if (/git\s+commit\b.*--no-verify/.test(cmd)) block("--no-verify skips hooks; fix the underlying failure.");
  if (/git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/.test(cmd) && !/\.local|codex-home/.test(cmd))
    block("destructive git operation; confirm with the user before discarding work.");
  if (/rm\s+-rf?\s+(\/|~|\.\s*$|\.\.|\*)/.test(cmd)) block("recursive delete of a broad path.");
  if (/(^|\s)(cat|type|Get-Content|bat|less|head|tail)\s+[^|;&]*\.env(\s|$|\.production)/.test(cmd) && !/\.env\.example/.test(cmd))
    block("printing .env would put secrets in the transcript; read variable names from .env.example instead.");

  // ---- parallel-work guards (see .claude/rules/parallel-work.md) --------------------------------------------
  // Branch deletion on the remote closes any PR based on that branch. Only scripts/dev/merge-prs.sh may do it,
  // after retargeting dependents; it runs as one command so its inner `git push --delete` never reaches this hook.
  if (/git\s+push\b.*(--delete\b|-d\b|\s:\S+)/.test(cmd) && !/OCULITH_MERGE=1/.test(cmd))
    block("deleting a remote branch closes PRs stacked on it; merge with `bash scripts/dev/merge-prs.sh <pr…>` which retargets dependents first.");
  if (/gh\s+pr\s+merge\b/.test(cmd)) block("merges are serialized through `bash scripts/dev/merge-prs.sh <pr…>` (review gate + retarget + branch cleanup).");
  if (/git\s+branch\s+-[dD]\b.*\bmain\b|git\s+push\b.*\bmain\b/.test(cmd) && !/origin\s+main\s*$|pull/.test(cmd) && /push/.test(cmd))
    block("never push to main directly; merge a reviewed PR instead.");

  // One PR per head branch.
  const prCreate = /gh\s+pr\s+create\b/.test(cmd);
  if (prCreate && !process.env.OCULITH_GUARD_SKIP_GH) {
    const headArg = cmd.match(/--head\s+["']?([^\s"']+)/)?.[1];
    const head = headArg && !headArg.startsWith("$") ? headArg : git(["branch", "--show-current"]);
    if (head) {
      try {
        const open = execFileSync("gh", ["pr", "list", "--state", "open", "--head", head, "--json", "number"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000, shell: process.platform === "win32" }).trim();
        const nums = JSON.parse(open || "[]").map((p) => p.number);
        if (nums.length) block(`branch ${head} already has open PR #${nums[0]}; push to it instead of opening a second PR.`);
      } catch {
        /* gh unavailable: don't block */
      }
    }
  }

  // Branch ownership: the session that creates a branch owns it; other sessions may not commit to or push it.
  // State lives in the shared .git dir so worktrees see the same map: <git-common-dir>/oculith-branch-owners.json
  const commonDir = git(["rev-parse", "--git-common-dir"]);
  const ownersFile = commonDir ? path.resolve(cwd, commonDir, "oculith-branch-owners.json") : "";
  const readOwners = () => {
    try {
      return JSON.parse(fs.readFileSync(ownersFile, "utf8"));
    } catch {
      return {};
    }
  };
  const writeOwners = (o) => {
    try {
      fs.writeFileSync(ownersFile, JSON.stringify(o, null, 2));
    } catch {
      /* best effort */
    }
  };
  const override = /OCULITH_OWNER_OVERRIDE=1/.test(cmd);
  const created = cmd.match(/git\s+(?:switch\s+-c|checkout\s+-b)\s+["']?([^\s"';&|]+)/)?.[1];
  if (ownersFile && created && !created.startsWith("$")) {
    const owners = readOwners();
    const cur = owners[created];
    if (cur && cur.session !== session && !override) block(`branch ${created} is owned by another session (${cur.session.slice(0, 8)}…, since ${cur.at}); pick another branch name or ask that session.`);
    owners[created] = { session, at: new Date().toISOString() };
    writeOwners(owners);
  }
  const touches = /git\s+(commit|push)\b/.test(cmd) && !/--delete/.test(cmd);
  if (ownersFile && touches && !override) {
    const pushed = cmd.match(/git\s+push\b(?:\s+-\S+)*\s+\S+\s+["']?([^\s"':;&|]+)/)?.[1];
    const branch = pushed && !pushed.startsWith("$") && !pushed.startsWith("-") ? pushed : git(["branch", "--show-current"]);
    const cur = branch ? readOwners()[branch] : undefined;
    if (cur && cur.session !== session)
      block(`branch ${branch} belongs to another session (${cur.session.slice(0, 8)}…, since ${cur.at}). Another agent or session is working on it; coordinate through the controller. A controller taking over a finished agent branch may prefix the command with OCULITH_OWNER_OVERRIDE=1.`);
  }

  // ---- secret scan of staged content before `git commit` ---------------------------------------------------
  if (/git\s+commit\b/.test(cmd)) {
    const staged = git(["diff", "--cached", "-U0"]);
    const added = staged.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
    const patterns = [
      [/sk-(proj-)?[A-Za-z0-9_-]{20,}/, "OpenAI-style API key"],
      [/ark-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "Ark API key"],
      [/AKLT[A-Za-z0-9]{20,}/, "Volcengine/BytePlus AK"],
      [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
      [/CANARY-SECRET-/, "test canary secret"],
      [/(APP_AUTH_TOKEN|ARK_API_KEY|OPENAI_API_KEY)\s*=\s*['"]?(?!replace-|\s*$|<|\$)[A-Za-z0-9_-]{16,}/, "credential assignment"],
    ];
    for (const line of added) {
      for (const [re, what] of patterns) {
        if (re.test(line)) block(`staged change contains a ${what}: ${line.slice(0, 60)}… — unstage it (git restore --staged <file>).`);
      }
    }
  }
  process.exit(0);
});
