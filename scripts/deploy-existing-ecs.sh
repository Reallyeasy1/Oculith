#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

env_file="${1:-.env.production}"
if [[ ! -f "$env_file" ]]; then
  echo "Missing $env_file. Copy .env.example and fill ARK_API_KEY / ARK_MODEL." >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker Engine 24 or newer is required. Follow the Linux install section in README.md." >&2
  exit 1
fi

docker_server_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)"
docker_server_major="${docker_server_version%%.*}"
if [[ ! "$docker_server_major" =~ ^[0-9]+$ ]] || (( docker_server_major < 24 )); then
  echo "Docker Engine 24 or newer is required; found '${docker_server_version:-unavailable}'." >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "The Docker Compose plugin is required (the command must be 'docker compose')." >&2
  exit 1
fi

# Mirror Compose's dotenv reading closely enough to agree with it: last assignment
# wins; CRLF, surrounding whitespace/quotes and unquoted inline comments stripped.
read_env_var() {
  sed -n "s/^$1=//p" "$env_file" | tail -n 1 \
    | sed -e 's/\r$//' -e 's/[[:space:]]\{1,\}#.*$//' \
          -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# HTTPS front: COMPOSE_PROFILES=caddy in the env file enables the caddy service for every
# compose command (up/down/ps alike). Fail closed on the two misconfigurations that would
# otherwise deploy something broken or insecure.
launchpad_domain="$(read_env_var LAUNCHPAD_DOMAIN)"
compose_profiles="$(read_env_var COMPOSE_PROFILES)"
caddy_enabled=0
case ",$compose_profiles," in *,caddy,*) caddy_enabled=1 ;; esac

if (( caddy_enabled )); then
  if [[ -z "$launchpad_domain" ]]; then
    echo "COMPOSE_PROFILES enables caddy but LAUNCHPAD_DOMAIN is empty; set the domain in $env_file." >&2
    exit 1
  fi
  public_port="$(read_env_var PUBLIC_PORT)"
  if [[ "$public_port" != 127.0.0.1:* ]]; then
    echo "With the caddy profile, PUBLIC_PORT must be loopback-bound, e.g. PUBLIC_PORT=127.0.0.1:3000." >&2
    echo "Otherwise port 80 collides with Caddy, or the API stays reachable in cleartext beside it." >&2
    exit 1
  fi
elif [[ -n "$launchpad_domain" ]]; then
  echo "LAUNCHPAD_DOMAIN is set but the caddy profile is off; add COMPOSE_PROFILES=caddy in $env_file." >&2
  exit 1
fi

mkdir -p data workspaces codex-home
if [[ "$(stat -c '%u:%g' data)" != "1000:1000" ]] \
  || [[ "$(stat -c '%u:%g' workspaces)" != "1000:1000" ]] \
  || [[ "$(stat -c '%u:%g' codex-home)" != "1000:1000" ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    chown -R 1000:1000 data workspaces codex-home
  elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo chown -R 1000:1000 data workspaces codex-home
  else
    echo "data, workspaces and codex-home must be owned by UID:GID 1000:1000." >&2
    echo "Run: sudo chown -R 1000:1000 data workspaces codex-home" >&2
    exit 1
  fi
fi
export LAUNCHPAD_ENV_FILE="$env_file"

# --remove-orphans stops a previously deployed caddy when the profile is turned off again.
docker compose --env-file "$env_file" up -d --build --remove-orphans

requested_sandbox_mode="$(read_env_var CODEX_SANDBOX_MODE)"
requested_sandbox_mode="${requested_sandbox_mode:-workspace-write}"
if [[ "$requested_sandbox_mode" == "workspace-write" ]] \
  && ! docker compose --env-file "$env_file" exec -T launchpad \
    codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
  echo "Codex Landlock is unavailable on this Linux kernel/container runtime." >&2
  echo "Falling back to danger-full-access inside the outer Docker boundary." >&2
  echo "This POC does not provide per-Agent isolation; do not store unrelated secrets in it." >&2
  export CODEX_SANDBOX_MODE=danger-full-access
  # Only launchpad needs the new sandbox mode; leaving caddy alone keeps 80/443 up
  # and avoids aborting an in-flight ACME challenge.
  docker compose --env-file "$env_file" up -d --no-build --force-recreate launchpad
fi
docker compose --env-file "$env_file" ps

if (( caddy_enabled )); then
  echo "Agent Launchpad is starting behind Caddy at https://$launchpad_domain."
else
  public_port="$(read_env_var PUBLIC_PORT)"
  echo "Agent Launchpad is starting on port ${public_port:-3000}."
fi
