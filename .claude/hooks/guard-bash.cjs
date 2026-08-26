#!/usr/bin/env node
// PreToolUse guard for Bash: block history-rewriting/unsafe git, and scan staged changes for secrets before any commit.
// Exit 2 = block (stderr shown to Claude). Exit 0 = allow.
const { execFileSync } = require("node:child_process");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let cmd = "";
  try {
    cmd = JSON.parse(input).tool_input?.command ?? "";
  } catch {
    process.exit(0);
  }
  if (!cmd) process.exit(0);

  const block = (why) => {
    process.stderr.write(`Blocked: ${why}\n`);
    process.exit(2);
  };

  if (/git\s+push\b.*(--force\b|-f\b)/.test(cmd)) block("force push rewrites shared history; open an issue and ask the user instead.");
  if (/git\s+commit\b.*--no-verify/.test(cmd)) block("--no-verify skips hooks; fix the underlying failure.");
  if (/git\s+(reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s)/.test(cmd) && !/\.local|codex-home/.test(cmd))
    block("destructive git operation; confirm with the user before discarding work.");
  if (/rm\s+-rf?\s+(\/|~|\.\s*$|\.\.|\*)/.test(cmd)) block("recursive delete of a broad path.");
  if (/(^|\s)(cat|type|Get-Content|bat|less|head|tail)\s+[^|;&]*\.env(\s|$|\.production)/.test(cmd) && !/\.env\.example/.test(cmd))
    block("printing .env would put secrets in the transcript; read variable names from .env.example instead.");

  // Secret scan of staged content before `git commit`
  if (/git\s+commit\b/.test(cmd)) {
    let staged = "";
    try {
      staged = execFileSync("git", ["diff", "--cached", "-U0"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      staged = "";
    }
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
