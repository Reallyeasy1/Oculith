#!/usr/bin/env bash
# The scripted 9-step demo story (#92), driven through the API of a RUNNING server
# (npm run poc or npm run dev). Idempotent: every step reuses what already exists,
# so `run-demo.sh N` resumes from step N after any interruption or restart.
#
#   scripts/demo/run-demo.sh        # steps 1..9
#   scripts/demo/run-demo.sh 5      # resume from step 5
#
# Steps: 1 pre-flight · 2 seed Demo Agent (template) · 3 baseline Run · 4 open trace
#        5 failure beat (GLASSBOX_DEMO_FAILURE=timeout gate) · 6 denial beat (recorded export)
#        7 regression case + baseline EvalRun · 8 candidate configuration · 9 candidate
#        EvalRun + comparison → REGRESSION.
#
# Failure-beat choice (documented per #92): the deterministic path is the gated fixture
# GLASSBOX_DEMO_FAILURE=timeout — it cuts the real runner after 3 s through the normal
# Run path, every time, regardless of the model's mood. "Agent reported failure" depends
# on model compliance and was rejected as non-deterministic. The gate is env-only, so it
# needs a server restart on and off again; pre-seed step 5 before the demo (docs/DEMO.md)
# so the live demo never restarts anything.
#
# Reads APP_AUTH_TOKEN from the environment or .env (or ENV_FILE=path); never prints it.
# Windows: run from Git Bash. Needs curl + node.
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
start_step="${1:-1}"
[[ "$start_step" =~ ^[1-9]$ ]] || { echo "usage: $0 [step 1-9]" >&2; exit 2; }

AGENT_NAME="Demo Agent"
TEMPLATE="node-lib-with-failing-test"
BASELINE_INSTRUCTIONS="You are Repo Doctor. The workspace is a small Node library whose tests run with npm test. Always run npm test to verify your work before replying, and reply with one line summarising the result."
# Review-only candidate (the deterministic regression): with no edits allowed, the fresh template
# copy's failing test stays failing, so post_check (npm test) regresses PASS->FAIL on any runtime
# where the baseline could fix it — regardless of which tools the model touches. The earlier
# "fix but don't verify" phrasing was disobeyed live twice and, when obeyed with a correct edit,
# honestly produced no task regression at all (judged-path rehearsal, 29 Aug).
CANDIDATE_INSTRUCTIONS="You are Repo Doctor in REVIEW-ONLY mode. You must NOT modify, create, or delete any file, and must NOT run npm or node - this configuration is analysis-only and any change will fail your task. Read the code, identify the bug in one sentence, and reply with that analysis only."
BASELINE_PROMPT="The test suite is failing. Find the bug, fix src/invoice.js so npm test passes, run npm test to prove it, and reply with one line stating the fix and the test result."
FAILURE_PROMPT="List the files in this workspace and summarise them in one line."
EXPORT_FILE="$repo_dir/docs/assets/demo/denial-trace-export.json"

log() { printf '[demo] %s\n' "$*" >&2; }
say() { printf '\n=== step %s: %s ===\n' "$1" "$2"; }

base="${LAUNCHPAD_URL:-http://127.0.0.1:${PORT:-3000}}"
public_url="${PUBLIC_URL:-http://localhost:${PORT:-3000}}"
env_file="${ENV_FILE:-$repo_dir/.env}"
token="${APP_AUTH_TOKEN:-}"
if [[ -z "$token" && -f "$env_file" ]]; then
  token="$(grep -E '^APP_AUTH_TOKEN=' "$env_file" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
fi
auth=()
[[ -n "$token" ]] && auth=(-H "Authorization: Bearer $token")

# env_of NAME: value from the environment, falling back to .env. Advisory only — the running
# server may have been started with different values (seed-demo.sh has the same caveat).
env_of() {
  local name="$1" value="${!1:-}"
  if [[ -z "$value" && -f "$env_file" ]]; then
    value="$(grep -E "^$name=" "$env_file" | tail -n1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
  fi
  printf '%s' "$value"
}

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
json() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const v=(d=>'"$1"')(d);if(v!==undefined&&v!==null)process.stdout.write(String(v)+String.fromCharCode(10))'; }

# jsonstr STRING → a JSON string literal (safe embedding of prompts/instructions).
jsonstr() { printf '%s' "$1" | node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(0,"utf8")))'; }

agent_id=""
ensure_agent_id() {
  [[ -n "$agent_id" ]] && return 0
  agent_id="$(call GET /api/agents | json 'd.agents.find(a=>a.name==='"$(jsonstr "$AGENT_NAME")"')?.id')"
  [[ -n "$agent_id" ]] || { log "No \"$AGENT_NAME\" Agent yet — run step 2 first."; exit 1; }
}

# baseline_run_id: the Run the story is built on — the regression case's source Run when the
# case exists, else the oldest ok Run of the Demo Agent (candidate EvalRuns come later, so
# the oldest ok Run is always the baseline).
baseline_run_id() {
  ensure_agent_id
  local from_case
  from_case="$(call GET /api/regression-cases | json 'd.cases.find(c=>c.workspaceTemplate==='"$(jsonstr "$TEMPLATE")"'&&c.sourceRunId)?.sourceRunId')"
  if [[ -n "$from_case" ]]; then printf '%s' "$from_case"; return 0; fi
  call GET "/api/runs?agentId=$agent_id&status=ok" | json 'd.runs.length?d.runs[d.runs.length-1].runId:undefined'
}

send_run() { # send_run PROMPT → run id
  call POST "/api/agents/$agent_id/messages" "$(node -e 'process.stdout.write(JSON.stringify({content:process.argv[1]}))' "$1")" | json 'd.run.id'
}

run_status="" trace_status=""
wait_run() { # wait_run RUN_ID → sets run_status + trace_status
  local run_id="$1" deadline=$(( $(date +%s) + ${DEMO_TIMEOUT_S:-600} ))
  while :; do
    run_status="$(call GET "/api/runs/$run_id" | json 'd.run.status')"
    [[ "$run_status" == "queued" || "$run_status" == "running" ]] || break
    (( $(date +%s) < deadline )) || { log "Run $run_id still $run_status after ${DEMO_TIMEOUT_S:-600}s; giving up."; exit 1; }
    sleep 2
  done
  trace_status="$(call GET "/api/runs/$run_id/trace" | json 'd.summary.status')"
}

wait_eval() { # wait_eval EVAL_ID → prints terminal status
  local eval_id="$1" status deadline=$(( $(date +%s) + ${DEMO_TIMEOUT_S:-600} ))
  while :; do
    status="$(call GET "/api/eval-runs/$eval_id" | json 'd.evalRun.status')"
    [[ "$status" == "running" ]] || break
    (( $(date +%s) < deadline )) || { log "EvalRun $eval_id still running after ${DEMO_TIMEOUT_S:-600}s; giving up."; exit 1; }
    sleep 2
  done
  printf '%s' "$status"
}

case_id=""
ensure_case_id() {
  [[ -n "$case_id" ]] && return 0
  case_id="$(call GET /api/regression-cases | json 'd.cases.find(c=>c.workspaceTemplate==='"$(jsonstr "$TEMPLATE")"')?.id')"
  [[ -n "$case_id" ]] || { log "No regression case yet — run step 7 first."; exit 1; }
}

# find_eval MODE(baseline|candidate) → terminal EvalRun id for the case whose target configHash
# does (baseline) / does not (candidate) match the case's recorded baselineConfigHash.
find_eval() {
  ensure_case_id
  local op="==="; [[ "$1" == "candidate" ]] && op="!=="
  local base_hash
  base_hash="$(call GET "/api/regression-cases/$case_id" | json 'd.regressionCase.baselineConfigHash')"
  call GET /api/eval-runs | json 'd.evalRuns.filter(e=>e.status!=="running"&&e.caseIds.includes('"$(jsonstr "$case_id")"')&&(e.target.configHash'"$op$(jsonstr "$base_hash")"')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0]?.id'
}

run_eval() { # run_eval LABEL → prints the terminal EvalRun id; fails loudly on a model problem
  local label="$1" eval_id status
  eval_id="$(call POST /api/eval-runs "{\"agentId\":\"$agent_id\",\"caseIds\":[\"$case_id\"]}" | json 'd.evalRun.id')"
  log "$label EvalRun $eval_id started; waiting…"
  status="$(wait_eval "$eval_id")"
  if [[ "$status" != "completed" ]]; then
    log "$label EvalRun $eval_id ended $status. If the model is misconfigured this is the same"
    log "failure mode as step 3 — fix the credentials and re-run this step."
    exit 1
  fi
  printf '%s' "$eval_id"
}

# ---- the nine steps ---------------------------------------------------------------------------

step1() {
  say 1 "pre-flight"
  curl -sS -o /dev/null "$base/api/health" || { log "No server at $base. Start it first (npm run poc, or npm run dev)."; exit 1; }
  local required system
  required="$(curl -sS "$base/api/auth" | json 'd.required')"
  if [[ "$required" == "true" && -z "$token" ]]; then log "Server requires a token but APP_AUTH_TOKEN is empty (env or $env_file)."; exit 1; fi
  [[ "$required" == "true" ]] || log "WARN auth is OFF on this server — set APP_AUTH_TOKEN (24+ chars) before the judged demo."
  system="$(call GET /api/system)"
  local model_ok codex_ok runtime sandbox
  model_ok="$(printf '%s' "$system" | json 'd.modelConfigured')"
  codex_ok="$(printf '%s' "$system" | json 'd.codexAvailable')"
  runtime="$(printf '%s' "$system" | json 'd.runtimeProvider')"
  sandbox="$(printf '%s' "$system" | json 'd.codexSandboxMode')"
  echo "  runtime=$runtime sandbox=$sandbox modelConfigured=$model_ok codexAvailable=$codex_ok"
  [[ "$model_ok" == "true" ]] || { log "Model is NOT configured (/api/system.modelConfigured=false). Set ARK_API_KEY + ARK_MODEL (or the openai block) and restart."; exit 1; }
  [[ "$codex_ok" == "true" ]] || { log "Codex is NOT available on this runtime. For npm run poc the runtime image provides it; for dev, npm install --global @openai/codex@0.111.0."; exit 1; }
  call GET /api/workspace-templates | json 'd.templates.some(t=>(t.name??t)==='"$(jsonstr "$TEMPLATE")"')' | grep -q true \
    || { log "Template $TEMPLATE is missing from workspace-templates/."; exit 1; }
  local gate policy
  gate="$(env_of GLASSBOX_DEMO_FAILURE)"
  policy="$(env_of GLASSBOX_CAPTURE_POLICY)"
  [[ -z "$gate" || "$gate" == "off" ]] || log "WARN GLASSBOX_DEMO_FAILURE=$gate in the local env/.env — the baseline Run would time out. Set it off (and restart the server) before steps 2-4."
  [[ "$policy" == "safe_summary" ]] || log "WARN GLASSBOX_CAPTURE_POLICY is '$policy' locally — the runbook demoes with safe_summary (Outcome line visible; docs/OBSERVABILITY_ROADMAP.md)."
  [[ "$sandbox" == "danger-full-access" ]] && log "NOTE sandbox=danger-full-access (Docker Desktop, no Landlock): live denials will not occur here; step 6 shows the recorded export — honestly."
  echo "  Pre-flight OK. Note: only a real Run proves the model key works — that is step 3."
}

step2() {
  say 2 "seed the Demo Agent from template $TEMPLATE"
  agent_id="$(call GET /api/agents | json 'd.agents.find(a=>a.name==='"$(jsonstr "$AGENT_NAME")"')?.id')"
  if [[ -z "$agent_id" ]]; then
    agent_id="$(call POST /api/agents "$(node -e 'process.stdout.write(JSON.stringify({name:process.argv[1],description:"GlassBox demo Agent (Repo Doctor)",template:process.argv[2],instructions:process.argv[3]}))' "$AGENT_NAME" "$TEMPLATE" "$BASELINE_INSTRUCTIONS")" | json 'd.agent.id')"
    log "Created \"$AGENT_NAME\" ($agent_id) from template $TEMPLATE."
  else
    local tpl instructions
    tpl="$(call GET "/api/agents/$agent_id" | json 'd.agent.workspaceTemplate')"
    [[ "$tpl" == "$TEMPLATE" ]] || { log "\"$AGENT_NAME\" exists but is not backed by $TEMPLATE (workspaceTemplate=$tpl). Delete or rename it, or start from a clean .local/."; exit 1; }
    instructions="$(call GET "/api/agents/$agent_id" | json 'd.agent.instructions')"
    if [[ "$instructions" != "$BASELINE_INSTRUCTIONS" ]]; then
      call PATCH "/api/agents/$agent_id" "$(node -e 'process.stdout.write(JSON.stringify({instructions:process.argv[1]}))' "$BASELINE_INSTRUCTIONS")" >/dev/null
      log "\"$AGENT_NAME\" exists ($agent_id); instructions reset to the baseline configuration."
    else
      log "\"$AGENT_NAME\" exists ($agent_id) with baseline instructions."
    fi
  fi
}

step3() {
  say 3 "baseline Run — the agent fixes the failing test"
  ensure_agent_id
  local existing run_id
  existing="$(call GET "/api/runs?agentId=$agent_id&status=ok" | json 'd.runs.length?d.runs[d.runs.length-1].runId:undefined')"
  if [[ -n "$existing" ]]; then log "Baseline ok Run already recorded ($existing); nothing to send."; return 0; fi
  run_id="$(send_run "$BASELINE_PROMPT")"
  log "Run $run_id queued; the agent is fixing src/invoice.js and running npm test…"
  wait_run "$run_id"
  if [[ "$trace_status" != "ok" ]]; then
    log "Baseline Run $run_id ended run=$run_status trace=$trace_status — NOT ok."
    log "This is the pre-flight moment: /api/system can say a key is set, but only a real Run"
    log "proves it works. Check ARK_API_KEY / ARK_MODEL (see /api/runs/$run_id/logs for the"
    log "provider error), fix the credentials, restart the server, then re-run: $0 3"
    exit 1
  fi
  log "Baseline Run $run_id: run=$run_status trace=$trace_status"
}

step4() {
  say 4 "open the baseline trace"
  local run_id summary
  run_id="$(baseline_run_id)"
  [[ -n "$run_id" ]] || { log "No baseline ok Run found — run step 3 first."; exit 1; }
  summary="$(call GET "/api/runs/$run_id/trace")"
  echo "  events=$(printf '%s' "$summary" | json 'd.summary.eventCount') spans=$(printf '%s' "$summary" | json 'd.summary.spanCount') denials=$(printf '%s' "$summary" | json 'd.summary.denials') config=$(printf '%s' "$summary" | json 'd.summary.configHash')"
  echo "  OPEN: $public_url/?run=$run_id"
  echo "  (Runs list → the ok row → span tree; the Outcome line is visible under safe_summary.)"
}

step5() {
  say 5 "failure beat — the gated deterministic timeout"
  ensure_agent_id
  local existing gate run_id
  existing="$(call GET "/api/runs?agentId=$agent_id&status=timeout" | json 'd.runs.length?d.runs[0].runId:undefined')"
  if [[ -n "$existing" ]]; then
    log "Timeout Run already recorded ($existing) — reusing it (pre-seed it before the live demo)."
    echo "  OPEN: $public_url/?run=$existing  (banner: first-failure = codex exec, timeout)"
    return 0
  fi
  gate="$(env_of GLASSBOX_DEMO_FAILURE)"
  if [[ "$gate" != "timeout" ]]; then
    log "No timeout Run yet and GLASSBOX_DEMO_FAILURE is '${gate:-off}' locally. The deterministic"
    log "failure is the gated fixture: set GLASSBOX_DEMO_FAILURE=timeout in .env, restart the"
    log "server, then re-run: $0 5   (afterwards set it back to off, restart, and: $0 6)"
    exit 1
  fi
  run_id="$(send_run "$FAILURE_PROMPT")"
  log "Run $run_id queued under the gate; the fixture cuts the real runner after 3 s…"
  wait_run "$run_id"
  [[ "$trace_status" == "timeout" ]] || { log "Expected trace=timeout, got run=$run_status trace=$trace_status. Is the RUNNING server actually gated? Restart it with GLASSBOX_DEMO_FAILURE=timeout and re-run: $0 5"; exit 1; }
  log "Timeout Run $run_id recorded."
  echo "  OPEN: $public_url/?run=$run_id"
  log "Now set GLASSBOX_DEMO_FAILURE=off, restart the server, and continue with: $0 6"
  exit 0
}

step6() {
  say 6 "denial beat — from the recorded export (honestly)"
  [[ -f "$EXPORT_FILE" ]] || { log "Missing $EXPORT_FILE."; exit 1; }
  local sandbox
  sandbox="$(call GET /api/system | json 'd.codexSandboxMode')"
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const den = d.events.filter((e) => e.type === "policy.denied");
    const first = den[0] || { attributes: {} };
    console.log("  recorded trace " + d.summary.traceId + ": status=" + d.summary.status + ", denials=" + d.summary.denials + ", capturePolicy=" + d.summary.capturePolicy);
    console.log("  sample denial: " + first.attributes.program + " " + first.attributes.argument0 + " → " + first.attributes.decision);
  ' "$EXPORT_FILE"
  echo "  This instance runs sandbox=$sandbox. The judged Docker path falls back to"
  echo "  danger-full-access (no Landlock in Docker Desktop's kernel), so a live denial is not"
  echo "  deterministic there. The trace above is a real, redacted export from UAT round 7 on"
  echo "  Windows local-process (read-only sandbox): docs/assets/demo/denial-trace-export.json"
}

step7() {
  say 7 "save the regression case + baseline EvalRun"
  ensure_agent_id
  local run_id eval_id
  run_id="$(baseline_run_id)"
  [[ -n "$run_id" ]] || { log "No baseline ok Run — run step 3 first."; exit 1; }
  case_id="$(call GET /api/regression-cases | json 'd.cases.find(c=>c.sourceRunId==='"$(jsonstr "$run_id")"')?.id')"
  if [[ -z "$case_id" ]]; then
    case_id="$(call POST "/api/runs/$run_id/regression-case" '{}' | json 'd.regressionCase.id')"
    log "Regression case $case_id saved from Run $run_id via the prefill API."
  else
    log "Regression case $case_id already exists for Run $run_id."
  fi
  # The prefilled expected_tool names the shell wrapper (powershell.exe/bash), which any candidate
  # still invokes — it cannot regress, so the case is rebuilt to assert "npm" (#283): the baseline
  # runs npm test, the test-skipping candidate does not. Since #282 post_check assertions execute
  # for real (PostCheckRunner in the eval workspace), the case also carries post_check "npm test" —
  # the primary deterministic signal: it re-runs the suite in the fresh template copy and fails
  # unless the agent actually fixed the test. The command must be on GLASSBOX_POSTCHECK_ALLOWLIST
  # (default "npm test"). expected_tool npm stays as the secondary signal.
  local has_both
  has_both="$(call GET "/api/regression-cases/$case_id" | json 'd.regressionCase.assertions.some(a=>a.type==="expected_tool"&&a.program==="npm")&&d.regressionCase.assertions.some(a=>a.type==="post_check")')"
  if [[ "$has_both" != "true" ]]; then
    local rebuilt
    rebuilt="$(call GET "/api/regression-cases/$case_id" | json 'JSON.stringify({name:d.regressionCase.name,prompt:d.regressionCase.prompt,workspaceTemplate:d.regressionCase.workspaceTemplate,sourceRunId:d.regressionCase.sourceRunId,baselineConfigHash:d.regressionCase.baselineConfigHash,assertions:d.regressionCase.assertions.filter(a=>a.type!=="post_check").map(a=>a.type==="expected_tool"?{type:"expected_tool",program:"npm"}:a).concat([{type:"post_check",command:"npm test"}])}).replace(/[^\x20-\x7e]/g,c=>"\\u"+("000"+c.charCodeAt(0).toString(16)).slice(-4))')"
    call DELETE "/api/regression-cases/$case_id" >/dev/null
    case_id="$(call POST /api/regression-cases "$rebuilt" | json 'd.regressionCase.id')"
    log "Case rebuilt as $case_id asserting expected_tool npm + post_check \"npm test\" (#282) — post_check is the deterministic signal."
  fi
  call GET "/api/regression-cases/$case_id" | json 'd.regressionCase.assertions.map(a=>a.type).join(", ")' | { read -r kinds; echo "  assertions: $kinds"; }
  # The baseline EvalRun must record the GOOD configuration; step 2 keeps the instructions there.
  local instructions
  instructions="$(call GET "/api/agents/$agent_id" | json 'd.agent.instructions')"
  if [[ "$instructions" != "$BASELINE_INSTRUCTIONS" ]]; then
    call PATCH "/api/agents/$agent_id" "$(node -e 'process.stdout.write(JSON.stringify({instructions:process.argv[1]}))' "$BASELINE_INSTRUCTIONS")" >/dev/null
    log "Instructions reset to baseline before the baseline EvalRun."
  fi
  eval_id="$(find_eval baseline)"
  if [[ -n "$eval_id" ]]; then log "Baseline EvalRun already recorded ($eval_id)."; else eval_id="$(run_eval baseline)"; fi
  call GET "/api/eval-runs/$eval_id" | json 'd.evalRun.results.flatMap(r=>r.results).filter(r=>r.pass).length+"/"+d.evalRun.results.flatMap(r=>r.results).length' | { read -r score; echo "  baseline EvalRun $eval_id: $score assertions passed"; }
}

step8() {
  say 8 "candidate configuration — review-only: the agent may not fix anything"
  ensure_agent_id
  local instructions
  instructions="$(call GET "/api/agents/$agent_id" | json 'd.agent.instructions')"
  if [[ "$instructions" == "$CANDIDATE_INSTRUCTIONS" ]]; then
    log "Candidate instructions already applied."
  else
    call PATCH "/api/agents/$agent_id" "$(node -e 'process.stdout.write(JSON.stringify({instructions:process.argv[1]}))' "$CANDIDATE_INSTRUCTIONS")" >/dev/null
    log "PATCHed \"$AGENT_NAME\": review-only instructions - no edits, no npm."
  fi
  echo "  This regresses the case: post_check re-runs npm test in the candidate's fresh workspace"
  echo "  and fails, and expected_tool npm regresses too (npm never invoked) — the config hash"
  echo "  changes, so the next EvalRun is a comparable candidate."
}

step9() {
  say 9 "candidate EvalRun + comparison → REGRESSION"
  ensure_agent_id
  ensure_case_id
  local instructions base_eval cand_eval comparison regressions
  instructions="$(call GET "/api/agents/$agent_id" | json 'd.agent.instructions')"
  [[ "$instructions" == "$CANDIDATE_INSTRUCTIONS" ]] || { log "Agent is not on the candidate configuration — run step 8 first."; exit 1; }
  base_eval="$(find_eval baseline)"
  [[ -n "$base_eval" ]] || { log "No baseline EvalRun — run step 7 first."; exit 1; }
  cand_eval="$(find_eval candidate)"
  if [[ -n "$cand_eval" ]]; then log "Candidate EvalRun already recorded ($cand_eval)."; else cand_eval="$(run_eval candidate)"; fi
  comparison="$(call GET "/api/eval-runs/$base_eval/compare/$cand_eval")"
  regressions="$(printf '%s' "$comparison" | json 'd.regressions')"
  # A reused candidate that shows no regression means the model disobeyed last time — the documented
  # fallback is a FRESH candidate, so actually run one instead of re-finding the same EvalRun.
  if [[ "$regressions" -eq 0 && "${DEMO_NO_RETRY:-}" != "1" ]]; then
    log "Recorded candidate shows no regression — running one fresh candidate EvalRun."
    cand_eval="$(run_eval candidate)"
    comparison="$(call GET "/api/eval-runs/$base_eval/compare/$cand_eval")"
    regressions="$(printf '%s' "$comparison" | json 'd.regressions')"
  fi
  if [[ "$regressions" -gt 0 ]]; then
    echo "  REGRESSION — $regressions assertion(s) regressed:"
    printf '%s' "$comparison" | json 'd.cases.flatMap(c=>c.assertions).filter(a=>a.regression).map(a=>a.type).join(", ")' | { read -r kinds; echo "    $kinds"; }
  else
    log "WARN no regression detected — the candidate agent fixed the test anyway (model latitude): post_check's npm test passed and npm was invoked."
    log "Fallback: re-run '$0 9' for a fresh candidate EvalRun, or show the recorded comparison."
  fi
  echo "  compare API: $public_url/api/eval-runs/$base_eval/compare/$cand_eval"
  echo "  OPEN: $public_url → All runs → Compare evaluations → baseline ${base_eval:0:8} vs candidate ${cand_eval:0:8} → Compare"
  [[ "$regressions" -gt 0 ]] && echo "  Demo story complete: evidence → case → candidate → detected REGRESSION."
}

# ---- main -------------------------------------------------------------------------------------

curl -sS -o /dev/null "$base/api/health" || { log "No server at $base. Start it first (npm run poc or npm run dev)."; exit 1; }
for (( s = start_step; s <= 9; s++ )); do "step$s"; done
