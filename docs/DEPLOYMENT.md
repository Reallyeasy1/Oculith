# Deployment

Use one of two paths:

- Install and deploy to an existing Linux VM (GCP Compute Engine is the
  documented demo host; the procedure is cloud-agnostic and works on any
  Ubuntu/Debian VM with a public IP).
- Provision the complete network and ECS stack on Volcengine with Terraform.

Both profiles require an Ark API key and a Responses-capable endpoint. The Ark
key works from any host — the model API does not require the VM to live on
BytePlus. (BytePlus ECS itself is enterprise-account-only, which is why the
demo host is GCP.)

## Existing Linux VM (GCP Compute Engine)

Create the VM with the gcloud CLI (or the console equivalents). Region
`asia-southeast1` (Singapore) keeps the VM close to
`ark.ap-southeast.bytepluses.com`; `e2-medium` matches the recommended
2 vCPU / 4 GiB shape:

```bash
gcloud compute addresses create launchpad-demo-ip --region=asia-southeast1
gcloud compute instances create launchpad-demo \
  --zone=asia-southeast1-b \
  --machine-type=e2-medium \
  --image-family=ubuntu-2404-lts-amd64 \
  --image-project=ubuntu-os-cloud \
  --boot-disk-size=40GB \
  --tags=launchpad-demo \
  --address="$(gcloud compute addresses describe launchpad-demo-ip \
      --region=asia-southeast1 --format='value(address)')"
gcloud compute firewall-rules create launchpad-demo-web \
  --allow=tcp:80,tcp:443 --target-tags=launchpad-demo
```

The reserved static address is what DuckDNS points at below; an ephemeral IP
changes when the instance stops. Firewall: open TCP 80 and 443 when using the
HTTPS overlay below (80 only, restricted to the event network via
`--source-ranges`, for the plain-HTTP setup); leave TCP 22 to
`gcloud compute ssh` (IAP or your project's default SSH rule — restrict it to
administrator IPs if that rule is open). Egress is open by default (Ark, Git,
package registries). GCP's Ubuntu 24.04 kernel supports Landlock, so the Codex
sandbox keeps `workspace-write` without the `danger-full-access` fallback.

Connect with `gcloud compute ssh launchpad-demo --zone=asia-southeast1-b`.

Recommended host:

- Ubuntu 22.04/24.04, Debian 12, or veLinux 2
- 2 vCPU, 4 GiB memory, and a 40 GiB system disk
- Docker Engine 24+ and the Docker Compose plugin

The procedure was verified from a clean veLinux 2 host with a current
Docker Engine and Compose v2 plugin. Debian 10 is unsupported.

### Install Docker

Install prerequisites:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git openssl
```

Select the Docker repository. veLinux 2 uses Debian 12 Bookworm:

```bash
. /etc/os-release
case "$ID" in
  ubuntu|debian)
    DOCKER_DISTRO="$ID"
    DOCKER_CODENAME="$VERSION_CODENAME"
    ;;
  velinux)
    DOCKER_DISTRO=debian
    DOCKER_CODENAME=bookworm
    ;;
  *)
    echo "Use the Docker-supported parent distribution."
    exit 1
    ;;
esac
```

Download the signing key and compare its full fingerprint with the official
[Docker installation guide](https://docs.docker.com/engine/install/):

```bash
curl -fsSL "https://download.docker.com/linux/$DOCKER_DISTRO/gpg" \
  -o /tmp/docker.asc
gpg --show-keys --with-fingerprint /tmp/docker.asc
```

After verification, install Docker:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo gpg --batch --yes --dearmor \
  -o /etc/apt/keyrings/docker.gpg /tmp/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/$DOCKER_DISTRO $DOCKER_CODENAME stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker "$USER"
```

Log in again, then verify:

```bash
docker version
docker compose version
docker run --rm hello-world
```

Do not replace an existing engine on a host with important containers. Use a
dedicated VM for this POC.

### Deploy

```bash
git clone https://github.com/Reallyeasy1/Oculith.git
cd Oculith
cp .env.example .env.production
openssl rand -hex 32
```

Set these values in `.env.production`:

```dotenv
PUBLIC_PORT=80
ARK_API_KEY=your-ark-api-key
ARK_MODEL=ep-your-endpoint-id
APP_AUTH_TOKEN=the-random-token-generated-above
```

Deploy:

```bash
chmod 600 .env.production
bash scripts/deploy-existing-ecs.sh .env.production
```

Verify:

```bash
curl http://127.0.0.1/api/health
# the same token you set in .env.production above
export APP_AUTH_TOKEN=the-random-token-generated-above
curl -H "Authorization: Bearer $APP_AUTH_TOKEN" \
  http://127.0.0.1/api/system
docker compose --env-file .env.production ps
```

Deploy updates with `git pull --ff-only`, then rerun the deployment script.

### HTTPS with Caddy and DuckDNS

The repository ships an optional `caddy` compose profile (service in
`docker-compose.yml`, site config in `deploy/caddy/Caddyfile`) that terminates
TLS with an automatic Let's Encrypt certificate. Use it whenever
`APP_AUTH_TOKEN` crosses an untrusted network.

1. Create a free hostname at [duckdns.org](https://www.duckdns.org) and point it
   at the instance's static external IP (`launchpad-demo-ip` above). DuckDNS is
   on the Public Suffix List, so each
   subdomain gets its own Let's Encrypt rate-limit bucket; do not use nip.io,
   whose shared bucket is usually exhausted.
2. Set in `.env.production`:

   ```dotenv
   COMPOSE_PROFILES=caddy
   LAUNCHPAD_DOMAIN=your-name.duckdns.org
   PUBLIC_PORT=127.0.0.1:3000
   ```

   `PUBLIC_PORT=127.0.0.1:3000` binds the app port to loopback so Caddy is the
   only public entrypoint. The deploy script refuses to start the caddy profile
   without a domain and a loopback-bound `PUBLIC_PORT` (a public app port would
   either collide with Caddy on port 80 or keep serving the API in cleartext
   beside the HTTPS front).
3. Make sure the firewall rule opens TCP 443 and keeps TCP 80 open (the
   `launchpad-demo-web` rule above opens both; Caddy answers the ACME HTTP-01
   challenge on 80 and redirects HTTP to HTTPS).
4. Rerun `bash scripts/deploy-existing-ecs.sh .env.production`.

Verify:

```bash
curl https://your-name.duckdns.org/api/health
curl -H "Authorization: Bearer $APP_AUTH_TOKEN" \
  https://your-name.duckdns.org/api/system
```

Because the profile lives in the env file, every compose command in this
document (`ps`, `down`, `logs`) covers the caddy container unchanged. To turn
HTTPS off again, remove `caddy` from `COMPOSE_PROFILES` and rerun the deploy
script; its `--remove-orphans` stops the leftover caddy container.

Certificates and the ACME account key persist in the `caddy_data` docker
volume — deliberately outside `data/`, which is mounted into the
agent-executing container. Recreating containers does not burn Let's Encrypt
rate limits; `docker compose --env-file .env.production down -v` deletes the
volume and the certificates with it.

### Network and cleanup

- With the HTTPS overlay: allow TCP 80 and 443 from anywhere (the token is
  protected in transit); without it: allow TCP 80 only from the event network
  (`--source-ranges` on the firewall rule).
- Allow TCP 22 only from administrator IP addresses (or use IAP via
  `gcloud compute ssh`).
- Allow outbound HTTPS to Ark and package registries.
- Add HTTPS before using `APP_AUTH_TOKEN` across an untrusted network.

Stop the application without deleting Agent data:

```bash
docker compose --env-file .env.production down
```

When the demo instance is no longer needed, stop the stack, then delete the
GCP resources (this deletes the boot disk and all Agent data — back up `data/`
and `workspaces/` first):

```bash
gcloud compute instances delete launchpad-demo --zone=asia-southeast1-b
gcloud compute firewall-rules delete launchpad-demo-web
gcloud compute addresses delete launchpad-demo-ip --region=asia-southeast1
```

The static address bills while reserved but unattached — release it even if
the instance is merely stopped for a while.

## Terraform deployment

Terraform uses `volcenginecc` to create a VPC, subnet, security group, ECS
instance, EIP, and cloud-init configuration.

Requirements:

- Terraform 1.6+
- Volcengine account AK/SK with resource-creation permissions
- Existing ECS SSH key pair
- Ubuntu image ID and instance type available in the selected region
- Public Git URL for this repository

Create configuration files:

```bash
cp .env.example .env.production
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
```

Set `ARK_API_KEY` and `ARK_MODEL` in `.env.production`. Set the region, zone,
image, instance type, key pair, allowed CIDRs, and repository URL in
`terraform.tfvars`.

Provide account credentials only through the current shell:

```bash
export VOLCENGINE_ACCESS_KEY=your-access-key
export VOLCENGINE_SECRET_KEY=your-secret-key
./scripts/deploy-volcengine.sh
```

After Terraform prints `app_url`, allow 5 to 10 minutes for cloud-init and the
Docker build. Inspect progress with:

```bash
ssh root@your-ecs-public-ip
cloud-init status --wait
tail -n 200 /var/log/cloud-init-output.log
```

Destroy the stack when the event ends:

```bash
terraform -chdir=deploy/volcengine destroy
```

> [!CAUTION]
> Destroying the stack removes the ECS instance, system disk, and Agent
> workspaces. Back up required code first.

## Secret handling

- Ark keys configure model access; Volcengine account AK/SK configures
  Terraform. Never pass account AK/SK to an Agent Runtime.
- `.env.production`, `terraform.tfvars`, and Terraform state must not be
  committed.
- The POC stores the Ark key in Terraform user data and state. Production
  deployments require managed secrets and an encrypted remote state backend.
