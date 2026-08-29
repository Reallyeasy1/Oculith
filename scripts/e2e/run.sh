#!/usr/bin/env bash
# E2E lane (#34): the judged configuration — built web + server, NODE_ENV=production, Docker runner — driven by
# Playwright. start-local-poc.sh prepares everything (image, preflight, build, env); this script only pins what must
# never collide with a live `npm run poc` instance: port, state root, instance id, auth token.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo"

env_file="${E2E_ENV_FILE:-$repo/.env}"
if [[ -f "$env_file" ]]; then set -a; . "$env_file"; set +a; fi
# .env carries Docker-image paths and demo knobs that must not reach a host process (same list as the run-poc skill).
unset CODEX_BIN RUNTIME_PROVIDER HOST APP_DATA_DIR AGENT_WORKSPACE_ROOT CODEX_HOME GLASSBOX_TRACE_DIR GLASSBOX_DEMO_FAILURE
: "${ARK_API_KEY:?ARK_API_KEY is required (put it in .env or point E2E_ENV_FILE at a file that has it)}"
: "${ARK_MODEL:?ARK_MODEL is required}"

root="$(mktemp -d "${TMPDIR:-/tmp}/glassbox-e2e-XXXXXX")"
# Git Bash: Docker Desktop bind-mounts want C:/... and MSYS must not rewrite dst=/workspace.
command -v cygpath >/dev/null 2>&1 && root="$(cygpath -m "$root")"
export MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="$root" E2E_ROOT="$root"
export PORT="${E2E_PORT:-3100}" APP_AUTH_TOKEN="${E2E_AUTH_TOKEN:-e2e-shared-token-0123456789abcdef}"
export RUNTIME_INSTANCE_ID="e2e-$$" GLASSBOX_CAPTURE_POLICY="${GLASSBOX_CAPTURE_POLICY:-safe_summary}"
# The full lane exercises real ModelArk Agent Runs; semantic evaluation itself is deterministic so
# judge variance cannot make the acceptance lane flaky.
export TASK_COMPLETION_JUDGE=fake

echo "[e2e] state root: $root  port: $PORT  instance: $RUNTIME_INSTANCE_ID" >&2
status=0
LOCAL_POC_COMMAND="exec node scripts/e2e/driver.cjs" bash scripts/start-local-poc.sh || status=$?
if (( status == 0 )); then rm -rf "$root"; else echo "[e2e] FAILED (exit $status); state kept at $root (server.log is there)" >&2; fi
exit "$status"
