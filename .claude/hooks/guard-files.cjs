#!/usr/bin/env node
// PreToolUse guard for Edit/Write: block edits to secrets, generated state, lock files, and pristine fixtures.
// Exit 2 = block (stderr is shown to Claude). Exit 0 = allow.
const path = require("node:path");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let file = "";
  try {
    file = JSON.parse(input).tool_input?.file_path ?? "";
  } catch {
    process.exit(0);
  }
  if (!file) process.exit(0);

  const rel = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");
  const base = path.basename(rel);

  const rules = [
    [/^\.env(\.production|\.local)?$/.test(base), "secrets file — set values via the shell or ask the user; never write keys from a transcript"],
    [/^\.local\//.test(rel) || /(^|\/)(codex-home|workspaces|\.data)\//.test(rel), "runtime state (Codex sessions, Agent workspaces, JSON store) — generated, not source"],
    [/^(package-lock\.json|.*\/package-lock\.json)$/.test(rel), "lock file — change dependencies with npm, not by hand"],
    [/^fixtures\/protected\/\.pristine\//.test(rel), "pristine fixture snapshot — reset-demo restores from here; edit fixtures/protected/ instead"],
    [/^\.git\//.test(rel), "git internals"],
  ];

  for (const [hit, why] of rules) {
    if (hit) {
      process.stderr.write(`Blocked edit to ${rel}: ${why}.\n`);
      process.exit(2);
    }
  }
  process.exit(0);
});
