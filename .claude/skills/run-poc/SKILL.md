---
name: run-poc
description: Launch the judged local POC path (Docker container runtime) on this machine and smoke-test it — handles the Windows/Git Bash quirks and reports /api/system. Use when asked to run the app the way judges will, or before a demo rehearsal.
disable-model-invocation: true
---

Start the platform exactly as reviewers will (`npm run poc` semantics) and prove it is up.

## 1. Preconditions
- Docker running: `docker info --format '{{.ServerVersion}}'`
- `.env` exists with `ARK_API_KEY`, `ARK_MODEL`, `ARK_BASE_URL` (do **not** print it; check with `grep -c ARK_API_KEY .env`)
- Port 3000 free: `netstat -ano | grep ":3000 " | grep LISTENING` (Windows) / `lsof -i :3000` (mac/Linux)

## 2. Launch (background)
Linux/macOS:
```bash
set -a; . ./.env; set +a; npm run poc
```
Windows (Git Bash — npm's cmd.exe cannot run the .sh, and MSYS mangles `dst=/workspace`):
```bash
set -a; . ./.env; set +a
unset CODEX_BIN RUNTIME_PROVIDER HOST APP_DATA_DIR AGENT_WORKSPACE_ROOT CODEX_HOME
MSYS_NO_PATHCONV=1 LOCAL_POC_DATA_ROOT="$(pwd -W)/.local" bash scripts/start-local-poc.sh
```
Run it in the background and tail its log; first run builds `volc-agent-runtime:local` (~2–4 min).

## 3. Smoke
```bash
for i in $(seq 1 120); do curl -s -m 2 http://127.0.0.1:3000/api/health >/dev/null && break; sleep 2; done
curl -s http://127.0.0.1:3000/api/system
```
Expect `runtimeProvider: "container"`, `containerEngine: "docker"`, `modelConfigured: true`, `codexAvailable: true`. `codexSandboxMode` will read `danger-full-access` under Docker Desktop (no Landlock) — expected, documented in `.env.example`.

## 4. Report
Print the `/api/system` JSON, the URL (http://localhost:3000), and how to stop (Ctrl+C in the script's terminal, or kill the PID on :3000). Offer `baseline-verifier` for the full acceptance flow.

If anything fails, quote the last 20 non-Docker-build lines of the log (`grep -vE '^#[0-9]+ '`).
