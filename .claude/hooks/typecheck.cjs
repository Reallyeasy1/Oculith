#!/usr/bin/env node
// PostToolUse: after editing a TS/TSX source file, typecheck the workspace it belongs to.
// Exit 2 feeds the tsc errors back to Claude; exit 0 is silent.
const { spawnSync } = require("node:child_process");
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
  const rel = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");
  const ws = rel.startsWith("apps/server/src/") ? "apps/server" : rel.startsWith("apps/web/src/") ? "apps/web" : null;
  if (!ws || !/\.(ts|tsx)$/.test(rel)) process.exit(0);

  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ws === "apps/web" ? ["tsc", "-b", "--pretty", "false"] : ["tsc", "-p", "tsconfig.json", "--noEmit", "--pretty", "false"];
  const r = spawnSync(npx, args, { cwd: path.join(process.cwd(), ws), encoding: "utf8", shell: process.platform === "win32" });
  if (r.status !== 0) {
    const out = (r.stdout + r.stderr).trim().split("\n").slice(0, 25).join("\n");
    process.stderr.write(`Typecheck failed in ${ws} after editing ${rel}:\n${out}\n`);
    process.exit(2);
  }
  process.exit(0);
});
