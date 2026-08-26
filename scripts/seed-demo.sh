#!/usr/bin/env bash
# Seed a clean demo state against a RUNNING server (npm run poc / npm run dev) so the Runs list is not
# empty at 0:00 of the rehearsal. Two phases, because the gated failure needs a server restart:
#
#   scripts/seed-demo.sh ok     # creates the "Demo" Agent if missing, sends one real task → ok Run
#   # then: set GLASSBOX_DEMO_FAILURE=timeout in .env, restart the server, and
#   scripts/seed-demo.sh fail   # sends one more task → timeout Run (the 3 s fixture, same Run path)
#   # then: unset GLASSBOX_DEMO_FAILURE (=off), restart the server
#
# /api/system cannot tell whether the gate is on; the script checks the Run's terminal status instead
# and tells you when the phase and the server disagree. Reads APP_AUTH_TOKEN from .env (or the
# environment, or ENV_FILE=path); never prints it. Windows: run from Git Bash. Needs curl + node.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
phase="${1:-ok}"
[[ "$phase" == "ok" || "$phase" == "fail" ]] || { echo "usage: $0 [ok|fail]" >&2; exit 2; }

log() { printf '[seed-demo] %s\n' "$*" >&2; }

base="${LAUNCHPAD_URL:-http://127.0.0.1:${PORT:-3000}}"
env_file="${ENV_FILE:-$repo_dir/.env}"
token="${APP_AUTH_TOKEN:-}"
if [[ -z "$token" && -f "$env_file" ]]; then
  token="$(grep -E '^APP_AUTH_TOKEN=' "$env_file" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
fi
auth=()
[[ -n "$token" ]] && auth=(-H "Authorization: Bearer $token")

# call METHOD PATH [JSON-BODY] → response body on stdout; non-2xx exits with the server's message.
call() {
  local method="$1" path="$2" body="${3:-}" out code
  out="$(curl -sS -o - -w '\n%{http_code}' -X "$method" ${auth[@]+"${auth[@]}"} \
    ${body:+-H "Content-Type: application/json" --data "$body"} "$base$path")"
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  [[ "$code" == 2* ]] || { log "$method $path → HTTP $code: $out"; exit 1; }
  printf '%s' "$out"
}

# json EXPR: evaluate EXPR against the JSON on stdin (d = parsed document).
json() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=(d=>'"$1"')(d);if(v!==undefined)process.stdout.write(String(v))'; }

curl -sS -o /dev/null "$base/api/health" || { log "No server at $base. Start it first (npm run poc or npm run dev)."; exit 1; }
[[ -n "$token" ]] || log "APP_AUTH_TOKEN is empty: auth is off. Set one (24+ chars) in .env before the demo."

agent_id="$(call GET /api/agents | json 'd.agents.find(a=>a.name==="Demo")?.id')"
if [[ -z "$agent_id" ]]; then
  log "Creating the Demo Agent."
  agent_id="$(call POST /api/agents '{"name":"Demo","description":"GlassBox demo Agent","instructions":"Help me build and test software in this workspace. Keep changes small and explain the result."}' | json 'd.agent.id')"
else
  log "Demo Agent exists ($agent_id)."
fi

if [[ "$phase" == "ok" ]]; then
  prompt="Create hello.ts that prints Hello from GlassBox, run it with node, and reply with the output in one line."
else
  prompt="List the files in this workspace and summarise them in one line."
fi

run_id="$(call POST "/api/agents/$agent_id/messages" "$(printf '%s' "$prompt" | node -e 'process.stdout.write(JSON.stringify({content:require("fs").readFileSync(0,"utf8")}))')" | json 'd.run.id')"
log "Run $run_id queued ($phase phase). Waiting for a terminal state…"

deadline=$(( $(date +%s) + ${SEED_TIMEOUT_S:-600} ))
while :; do
  status="$(call GET "/api/runs/$run_id" | json 'd.run.status')"
  [[ "$status" == "queued" || "$status" == "running" ]] || break
  (( $(date +%s) < deadline )) || { log "Run $run_id still $status after ${SEED_TIMEOUT_S:-600}s; giving up."; exit 1; }
  sleep 2
done
trace_status="$(call GET "/api/runs/$run_id/trace" | json 'd.summary.status')"
log "Run $run_id ended: run=$status trace=$trace_status"

echo "agent=$agent_id run=$run_id status=$trace_status"
echo "open ${PUBLIC_URL:-http://localhost:${PORT:-3000}} → Runs → click the row"

if [[ "$phase" == "ok" && "$trace_status" != "ok" ]]; then
  log "Expected an ok Run. Is GLASSBOX_DEMO_FAILURE still on, or is the model/runtime misconfigured?"
  exit 1
elif [[ "$phase" == "fail" && "$trace_status" != "timeout" ]]; then
  log "Expected a timeout Run. Set GLASSBOX_DEMO_FAILURE=timeout in .env, restart the server, rerun '$0 fail'."
  exit 1
fi
