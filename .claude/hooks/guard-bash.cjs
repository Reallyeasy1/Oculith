#!/usr/bin/env node
// PreToolUse guard for Bash/PowerShell: block history-rewriting/unsafe git, keep parallel sessions from racing on
// issues, branches and PRs, and scan staged changes for secrets before any commit.
// Exit 2 = block (stderr shown to Claude). Exit 0 = allow.
//
// Race prevention model (see .claude/rules/parallel-work.md):
//   issue  → claimed on GitHub (label in-progress + assignee) AND locally (issue → session) before any branch for it
//   branch → owned by the session that created (or first committed to) it; other sessions cannot commit/push it
//   PR     → one per head branch; merges only through scripts/dev/merge-prs.sh
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
  const skipGh = !!process.env.OCULITH_GUARD_SKIP_GH;

  const block = (why) => {
    process.stderr.write(`Blocked: ${why}\n`);
    process.exit(2);
  };
  const exec = (bin, args, timeout = 5000) => {
    try {
      return execFileSync(bin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout }).trim(); // no shell: arguments never reach a shell
    } catch {
      return null;
    }
  };
  const git = (args) => exec("git", args) ?? "";
  // Test seam: OCULITH_GH_BIN=<script.js> substitutes a fake gh (scripts/dev/test-guards.sh); production always runs the real gh.
  const gh = (args, t) => (process.env.OCULITH_GH_BIN ? exec(process.execPath, [process.env.OCULITH_GH_BIN, ...args], t) : exec("gh", args, t));
  // `git -C dir -c k=v <sub>` → match the subcommand regardless of global options.
  const GIT = String.raw`git(?:\s+-[cC]\s+\S+)*`;
  const sub = (name) => new RegExp(`${GIT}\\s+${name}\\b`);

  // ---- unsafe git / secrets in the transcript --------------------------------------------------------------
  if (sub("push").test(cmd) && /(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+[\w./-]+)/.test(cmd)) block("force push rewrites shared history; open an issue and ask the user instead.");
  if (sub("commit").test(cmd) && /--no-verify/.test(cmd)) block("--no-verify skips hooks; fix the underlying failure.");
  if (/git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/.test(cmd) && !/\.local|codex-home/.test(cmd))
    block("destructive git operation; confirm with the user before discarding work.");
  if (/rm\s+-rf?\s+(\/|~|\.\s*$|\.\.|\*)/.test(cmd)) block("recursive delete of a broad path.");
  if (/(^|\s)(cat|type|Get-Content|bat|less|head|tail)\s+[^|;&]*\.env(\s|$|\.production)/.test(cmd) && !/\.env\.example/.test(cmd))
    block("printing .env would put secrets in the transcript; read variable names from .env.example instead.");

  // ---- parallel-work guards --------------------------------------------------------------------------------
  // Remote branch deletion closes PRs stacked on it. Only scripts/dev/merge-prs.sh may do it (after retargeting);
  // it runs as one command, so its inner `git push --delete` never reaches this hook.
  if (sub("push").test(cmd) && /(\s--delete\b|\s-d\b|\s:[\w./-]+)/.test(cmd))
    block("deleting a remote branch closes PRs stacked on it; merge with `bash scripts/dev/merge-prs.sh <pr…>` which retargets dependents first.");
  if (/gh\s+pr\s+merge\b/.test(cmd) || /gh\s+api\b.*\/(merge|git\/refs)\b/.test(cmd))
    block("merges and ref deletes are serialized through `bash scripts/dev/merge-prs.sh <pr…>` (review gate + retarget + branch cleanup).");
  if (sub("push").test(cmd) && /(\s|:)main(\s|$)/.test(cmd)) block("never push to main directly; merge a reviewed PR instead.");

  // One PR per head branch.
  if (/gh\s+pr\s+create\b/.test(cmd) && !skipGh) {
    const headArg = cmd.match(/--head\s+["']?([^\s"']+)/)?.[1];
    const head = headArg && !headArg.startsWith("$") ? headArg : git(["branch", "--show-current"]);
    if (head) {
      const open = gh(["pr", "list", "--state", "open", "--head", head, "--json", "number"], 15000);
      if (open) {
        const nums = JSON.parse(open || "[]").map((p) => p.number);
        if (nums.length) block(`branch ${head} already has open PR #${nums[0]}; push to it instead of opening a second PR.`);
      }
    }
  }

  // ---- ownership state: shared .git dir so every worktree sees the same map ---------------------------------
  const commonDir = git(["rev-parse", "--git-common-dir"]);
  const stateFile = commonDir ? path.resolve(cwd, commonDir, "oculith-branch-owners.json") : "";
  const readState = () => {
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      return { branches: s.branches ?? {}, issues: s.issues ?? {} };
    } catch {
      return { branches: {}, issues: {} };
    }
  };
  const writeState = (s) => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
    } catch {
      /* best effort */
    }
  };
  const ownerOverride = /OCULITH_OWNER_OVERRIDE=1/.test(cmd);
  const claimOverride = /OCULITH_CLAIM_OVERRIDE=1/.test(cmd);
  const now = new Date().toISOString();
  const issueOf = (branch) => branch?.match(/^(?:feat|fix|chore)\/(\d+)-/)?.[1];

  // Claiming an issue: same-machine sessions share the GitHub login, so GitHub cannot tell them apart — we can.
  const claiming = cmd.match(/claim-issue\.sh\s+(\d+)/)?.[1];
  if (stateFile && claiming) {
    const s = readState();
    const cur = s.issues[claiming];
    if (cur && cur.session !== session && !claimOverride) block(`issue #${claiming} is already claimed by another session on this machine (${cur.session.slice(0, 8)}…, since ${cur.at}); pick another issue.`);
    s.issues[claiming] = { session, at: now };
    writeState(s);
  }

  // Creating a branch: the issue must be claimed (GitHub: label in-progress + assignee = me; local: this session).
  const created = cmd.match(new RegExp(`${GIT}\\s+(?:switch\\s+(?:-c|-C|--create)|checkout\\s+-[bB]|branch|worktree\\s+add\\s+-b)\\s+["']?([^\\s"';&|-][^\\s"';&|]*)`))?.[1];
  if (stateFile && created && !created.startsWith("$")) {
    const s = readState();
    const b = s.branches[created];
    if (b && b.session !== session && !ownerOverride) block(`branch ${created} is owned by another session (${b.session.slice(0, 8)}…, since ${b.at}); pick another branch name or ask that session.`);
    const n = issueOf(created);
    if (n) {
      const ic = s.issues[n];
      if (ic && ic.session !== session && !claimOverride) block(`issue #${n} is claimed by another session on this machine (${ic.session.slice(0, 8)}…); do not start a second branch for it.`);
      if (!claimOverride && !skipGh) {
        const me = gh(["api", "user", "--jq", ".login"], 15000);
        const view = gh(["issue", "view", n, "--json", "labels,assignees,state"], 15000);
        if (!me || !view) block(`cannot verify that issue #${n} is claimed (gh unavailable). Run \`bash scripts/dev/claim-issue.sh ${n}\` first, or prefix with OCULITH_CLAIM_OVERRIDE=1 when offline.`);
        const v = JSON.parse(view);
        const labels = (v.labels ?? []).map((l) => l.name);
        const assignees = (v.assignees ?? []).map((a) => a.login);
        if (v.state !== "OPEN") block(`issue #${n} is ${v.state}; nothing to branch for.`);
        if (!labels.includes("in-progress") || !assignees.includes(me))
          block(`issue #${n} is not claimed by you (labels: ${labels.join(",") || "none"}; assignees: ${assignees.join(",") || "none"}). Assign it to yourself first: \`bash scripts/dev/claim-issue.sh ${n}\`.`);
      }
      s.issues[n] = { session, at: now };
    }
    s.branches[created] = { session, at: now };
    writeState(s);
  }

  // Committing / pushing: only the owner. An ownerless branch is claimed by the first session that touches it.
  const touches = sub("(?:commit|push)").test(cmd);
  if (stateFile && touches) {
    const current = git(["branch", "--show-current"]);
    let target = current;
    const ref = cmd.match(new RegExp(`${GIT}\\s+push\\b(?:\\s+-\\S+)*\\s+\\S+\\s+["']?([^\\s"';&|]+)`))?.[1];
    if (ref && !ref.startsWith("$") && !ref.startsWith("-")) {
      const local = ref.split(":")[0].replace(/^refs\/heads\//, "");
      target = local === "HEAD" ? current : local;
    }
    if (target) {
      const s = readState();
      const b = s.branches[target];
      if (b && b.session !== session && !ownerOverride)
        block(`branch ${target} belongs to another session (${b.session.slice(0, 8)}…, since ${b.at}). Coordinate through the controller; a controller taking over a finished agent branch may prefix the command with OCULITH_OWNER_OVERRIDE=1.`);
      if (!b || b.session === session) {
        s.branches[target] = { session, at: now }; // claim-on-first-touch / refresh
        writeState(s);
      }
    }
  }

  // ---- secret scan of staged content before `git commit` ---------------------------------------------------
  if (sub("commit").test(cmd)) {
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
