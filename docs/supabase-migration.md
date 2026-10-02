# Move Tradeform storage to Supabase

This changes the database location, while retaining current Tradeform email/Google login and existing user IDs. Do not set SUPABASE_URL just to move storage: that variable switches the authentication verifier to Supabase Auth and would invalidate the current login flow. Supabase Auth integration remains separate work.

## Private connection configuration

In the Codex working directory, supabase-connection.json is a mode-0600 private file with projectUrl, adminUrl and optional caFile. Fill it locally, not in chat. Get the direct PostgreSQL or session-pooler connection from the Supabase project's Connect panel. Use port 5432; transaction pooling on 6543 is not used for this migration. The admin connection needs its database password. Connections use certificate-verified TLS. If the project requires its downloadable CA certificate, save it locally and set caFile. Never disable certificate verification to work around an error.

## Migration stages

From the repo root, invoke pnpm --filter journal-api exec tsx src/supabase.ts with a stage plus three absolute paths: private connection configuration, new private runtime configuration, and existing private local PostgreSQL configuration.

Stages: plan (read-only connection/owner checks), provision (private schema and restricted roles), copy (atomic initial transfer and per-table integrity checks), verify (runtime access, forced RLS, worker privileges and Data API isolation). The provision stage refuses an existing tradeform schema or runtime-role name collision. The copy stage refuses a populated target. It requires the local API/worker stack to be stopped. Source data is read in a consistent snapshot and is never modified or removed.

The private tradeform schema contains the application tables and queue functions. Separate tradeform_api and tradeform_worker login roles are created with generated credentials, no superuser/BYPASSRLS, and no inherited privileges. Public/anon/authenticated/service_role do not receive access to this schema. API requests set owner identity inside transactions. Queue functions remain confined to the private schema.

The transfer excludes generated demo workspaces, expired sessions, ephemeral Google handoffs and old rate-limit counters. It preserves real registered users, password hashes, Google identities, active session hashes, trading accounts, fills, computed trades, review annotations, documents and import history. Expired worker leases are safely requeued or marked failed after their retry limit. Existing public SQLite modules are not migrated by this tool.

After verification, launch with JOURNAL_CONFIG_FILE pointing at the generated private runtime configuration using python3 scripts/hosted-local.py stack. The frontend and simulator keep their existing service address. Only the backend's database connection changes. The launcher disables generated demo access for a Supabase runtime and keeps tests pointed at the isolated local test database, not the remote project.

Verify registration/login, existing trades, saved notes, a new manual trade and worker completion through the connected app. Measure remote API latency before claiming previous local benchmark figures apply. Keep the original local cluster for rollback; return the launcher to the original configuration to roll back before any new remote writes. After remote writes, data reconciliation is required before switching back.

## View users in Supabase

Registered users remain in tradeform.journal_users (not auth.users). In the Supabase SQL editor, run SELECT id,email,created_at FROM tradeform.journal_users ORDER BY created_at DESC. Trading accounts live in tradeform.journal_accounts. Do not display password/session hash columns for routine inspection.

Sources: https://supabase.com/docs/guides/database/connecting-to-postgres and https://supabase.com/docs/guides/api/securing-your-api.

## Completed cutover — October 1, 2026

Connected project `skxffgdobwljnouxdkjs` (`tradeform`, us-east-1) through its dashboard-confirmed session pooler on port 5432. Runtime connections use the downloaded Supabase CA certificate with TLS verification enabled. The local source contained 12 generated demo users and no registered users; the verified transfer therefore copied zero personal rows. The original local database remains intact, and a private pre-transfer snapshot was saved outside the repository.

Supabase is now the default for `scripts/hosted-local.py` when the ignored, mode-0600 root `supabase-runtime.json` exists. An explicit JOURNAL_CONFIG_FILE overrides this choice. The tests mode always selects the local test database. The web frontend and iOS shell keep http://localhost:3002 for local testing. A permanent hosted application URL is still separate deployment work.

Live checks passed for email registration/login, restricted runtime roles, user isolation, background execution imports, notes persistence, HttpOnly web sessions and logout revocation. Temporary verification users were removed. The production web build and all 588 tests passed. Live overview reads measured median 134.93 ms and p95 222.49 ms over 20 sequential requests from this Mac to Supabase; these figures are not production load-test results.

Security advisors returned no findings. Missing foreign-key indexes were added. Advisors still report the current_setting policy initplan warning, but direct EXPLAIN under the API role confirms the ownership subquery uses an InitPlan. Unused-index notices are expected on a newly provisioned database and its indexes were retained.
