#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
demo_script="$script_dir/run-demo.sh"

load_demo_functions() {
  # Load definitions without executing the nine-step main loop.
  source <(sed '/^# ---- main /,$d' "$demo_script")
}

assert_no_demo_files() {
  local workspace="$1"
  if find "$workspace" -type f -name 'glassbox-redaction-demo.*.txt' -print -quit | grep -q .; then
    echo "temporary redaction file was not cleaned up" >&2
    return 1
  fi
}

test_default_reuses_existing_run() (
  load_demo_functions
  DEMO_REDACTION_BEAT=0
  agent_id="agt-1"
  call() {
    [[ "$1 $2" == "GET /api/runs?agentId=agt-1&status=ok" ]] || return 99
    printf '{"runs":[{"runId":"existing-run"}]}'
  }
  send_run() { echo "default path unexpectedly sent a Run" >&2; return 98; }
  step3 >/dev/null
)

test_opt_in_is_safe_and_repeatable() (
  load_demo_functions
  DEMO_REDACTION_BEAT=1
  agent_id="agt-1"
  workspace="$(mktemp -d)"
  mkdir "$workspace/.notes"
  printf 'operator-owned\n' > "$workspace/.notes/env-backup.txt"
  prompts="$workspace/prompts"
  call() {
    case "$1 $2" in
      "GET /api/runs?agentId=agt-1&status=ok") printf '{"runs":[{"runId":"existing-run"}]}' ;;
      "GET /api/agents/agt-1") printf '{"agent":{"workspacePath":"%s"}}' "$workspace" ;;
      *) return 99 ;;
    esac
  }
  send_run() {
    local prompt="$1" relative
    relative="$(printf '%s' "$prompt" | sed -n 's/.*read \([^ ]*glassbox-redaction-demo\.[^ ]*\.txt\).*/\1/p')"
    [[ -n "$relative" && -f "$workspace/$relative" ]]
    grep -q 'ARK_API_KEY=ark-' "$workspace/$relative"
    printf '%s\n' "$relative" >> "$prompts"
    printf 'new-run'
  }
  wait_run() { run_status="completed"; trace_status="ok"; }

  step3 >/dev/null
  step3 >/dev/null

  [[ "$(cat "$workspace/.notes/env-backup.txt")" == "operator-owned" ]]
  [[ "$(sort -u "$prompts" | wc -l)" -eq 2 ]]
  assert_no_demo_files "$workspace"
)

test_failed_run_cleans_up() (
  workspace="$(mktemp -d)"
  # Execute step3 at the top level of a shell sourced through /dev/fd, matching the focused
  # live-UAT loader. Its `exit 1` must still run the cleanup trap successfully.
  if DEMO_TEST_SCRIPT="$demo_script" DEMO_TEST_WORKSPACE="$workspace" bash -c '
    source <(awk "/^# ---- main /{exit} {print}" "$DEMO_TEST_SCRIPT")
    DEMO_REDACTION_BEAT=1
    agent_id="agt-1"
    call() {
      case "$1 $2" in
        "GET /api/runs?agentId=agt-1&status=ok") printf "{\"runs\":[]}" ;;
        "GET /api/agents/agt-1") printf "{\"agent\":{\"workspacePath\":\"%s\"}}" "$DEMO_TEST_WORKSPACE" ;;
        *) return 99 ;;
      esac
    }
    send_run() { printf "failed-run"; }
    wait_run() { run_status="failed"; trace_status="failed"; }
    step3
  ' >/dev/null 2>&1; then
    echo "failed Run unexpectedly succeeded" >&2
    return 1
  fi
  assert_no_demo_files "$workspace"
  [[ ! -d "$workspace/.notes" ]]
)

test_interrupted_run_cleans_up() (
  load_demo_functions
  DEMO_REDACTION_BEAT=1
  agent_id="agt-1"
  workspace="$(mktemp -d)"
  call() {
    case "$1 $2" in
      "GET /api/runs?agentId=agt-1&status=ok") printf '{"runs":[]}' ;;
      "GET /api/agents/agt-1") printf '{"agent":{"workspacePath":"%s"}}' "$workspace" ;;
      *) return 99 ;;
    esac
  }
  send_run() { printf 'interrupted-run'; }
  wait_run() { kill -TERM "$BASHPID"; }

  if (step3 >/dev/null 2>&1); then
    echo "interrupted Run unexpectedly succeeded" >&2
    return 1
  fi
  assert_no_demo_files "$workspace"
  [[ ! -d "$workspace/.notes" ]]
)

test_default_reuses_existing_run
test_opt_in_is_safe_and_repeatable
test_failed_run_cleans_up
test_interrupted_run_cleans_up
if grep -Fq 'program:\"npm\"' "$demo_script"; then
  echo "demo must not use nondeterministic expected_tool npm assertions" >&2
  exit 1
fi
grep -q 'post_check.*npm test' "$demo_script"
echo "run-demo: default, opt-in rerun, failure, and interruption paths pass"
