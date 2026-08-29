# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

For container-based Agent execution, follow
[docs/LOCAL_POC.md](docs/LOCAL_POC.md).

## Validate

```bash
npm run check
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

The PostgreSQL store conformance cases are skipped unless `TEST_DATABASE_URL`
points at a **throwaway** database (they empty its tables between cases — that
is why they never read the app's `DATABASE_URL`):

```bash
docker run -d --rm --name testpg -e POSTGRES_PASSWORD=test -e POSTGRES_DB=launchpad_test -p 127.0.0.1:54329:5432 postgres:16-alpine
TEST_DATABASE_URL="postgres://postgres:test@127.0.0.1:54329/launchpad_test" npm run test -w @launchpad/server
docker rm -f testpg
```

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Never commit credentials, local state, workspaces, build output, or Terraform
  state.
- Report security issues according to [SECURITY.md](SECURITY.md).
