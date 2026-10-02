# Hosted journal architecture

The new `/workspace` interface connects to `apps/api`, an asynchronous Fastify/PostgreSQL service. The current configured runtime uses Supabase-hosted PostgreSQL; local PostgreSQL supplies isolated development and test storage. The original SQLite interface remains available separately for self-hosted use; hosted mode blocks its API routes.

## Delivered

Tradeform branding and automatic native service configuration; private email registration and expiring, revocable sessions; HttpOnly browser session cookies; transaction-scoped user context and forced row-level security; restricted API and worker roles; pooled connections; indexed cursor pagination; optimistic versions on reviews, journals and settings; validated atomic imports with content deduplication; persistent job idempotency, worker leases, retries and crash recovery. Imports use the shared open-source parsers and trade calculations. Overview snapshots avoid recalculating historical metrics on every read.

The responsive workspace provides accounts, performance, trade history/reviews, daily notes, CSV imports, manual trades and timezone settings. The iOS project wraps the web workspace.

## Running locally

Run `python3 scripts/hosted-postgres.py` to set up the temporary local cluster, build the web preview with `JOURNAL_PREVIEW=1 NEXT_PUBLIC_JOURNAL_DEMO=0 pnpm build`, then run `python3 scripts/hosted-local.py stack`. The workspace is at localhost:3002. Configuration is stored with mode 0600 in `/private/tmp/trade-journal-hosted-config.json`; this temporary development cluster is not production storage. Run tests with the stack stopped: `python3 scripts/hosted-local.py tests` supplies the real PostgreSQL test connections.

## Production and Supabase

Apply all sorted SQL migrations as a trusted migration owner. Use separate restricted runtime roles: the API requires CRUD on journal tables and the worker requires execute on `journal_claim_job` and `journal_renew_job`, not direct access to other users' tables. Neither runtime role may be superuser or BYPASSRLS. Do not run migrations as a runtime role. Security-definer queue functions must remain owned by a trusted role with a fixed search path and revoked PUBLIC execution.

Set JOURNAL_DATABASE_URL for the API, JOURNAL_WORKER_URL for workers, and JOURNAL_SERVICE_URL for the Next.js proxy. Enable JOURNAL_HOSTED_ONLY=1 for hosted web replicas. Disable demo access and gate registration for production. Use HTTPS, private service networking, an appropriate database pool budget across replicas, backups with tested restoration, and shared infrastructure observability. API health and ready endpoints expose process/database availability.

The SQL uses ordinary PostgreSQL features and can be deployed to Supabase. A separate Google OAuth adapter is prepared (docs/google-login.md) and awaits Google credentials. Optional SUPABASE_URL enables verification of asymmetric authenticated Supabase JWTs through its JWKS endpoint. Supabase-hosted database storage has been verified live; the optional Supabase Auth verifier is separate and provider login, account linking and session refresh UI still need integration. Existing local passwords are not automatically migrated to Supabase Auth.

## Remaining scope

Legacy AI tools, market replay, prop-firm modules, attachments and direct broker synchronization have not been ported into the hosted workspace. Existing SQLite journals need a reviewed migration utility before moving real data. The current worker rebuilds an account after imports; representative large histories and sustained distributed load need profiling before claiming capacity for large numbers of users. Local benchmark results describe only the measured machine, concurrency and fixture sizes; they are not a production capacity guarantee.
