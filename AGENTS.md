# figment-migration

Cloudflare Worker (Hono, D1, R2, Queues) that converts Figment `.fgmt` projects from WebGL to WebGPU with Claude. See `SPEC.md`.

## Verify

`npm run typecheck && npm test && npm audit && npx wrangler deploy --dry-run`

## Branch and deploy

- Base branch `main`; commit and push to it directly.
- Live at https://figment-migration.nodebox.workers.dev (Cloudflare account "Sint Lucas", `40728e030c0e1a608b66d84b0de7ac62`).
- Cloudflare Workers Builds deploys every push to `main` from GitHub. Do not run `npm run deploy` by hand. Confirm a deploy with `npx wrangler deployments list`.
- Schema changes in `schema.sql` are not applied by the build: run `npm run db:migrate:remote` before pushing code that needs them.

## Security

- Fix security issues when you see them, without waiting to be asked: `npm audit` findings, vulnerable or outdated dependencies, exposed secrets, missing auth or input validation. Mention each fix in your report.
- `npm audit` must report 0 vulnerabilities before a deploy.
- Upgrade dependencies with `npm install <pkg>@latest` per package. `npm audit fix` stalls on peer conflicts between `wrangler` and `@cloudflare/workers-types`; never use `--force` or `--legacy-peer-deps`.
- The API has no authentication, on purpose. Figment is open source, so any client check (header, shared key) is spoofable, and real users script the API, so Turnstile or an allowlist would block them. The cost is capped instead: the Anthropic workspace for this key has a spend limit (about €10), plus the upload limits and unguessable task IDs in `src/routes/api.ts`. Do not add client authentication; if abuse shows up, add per-user sign-in with a quota.
- Secrets live in 1Password: `.env.template` holds `op://` references and `scripts/setup-secrets.sh` writes `.env` from them. Never put a secret in code or `wrangler.toml`.

## Notes

- `tsconfig.json` loads only `@cloudflare/workers-types`. Tests that need Node APIs add `/// <reference types="node" />` at the top, so Worker code cannot use Node globals that do not exist at runtime.
