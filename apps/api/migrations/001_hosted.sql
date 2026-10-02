BEGIN;
CREATE TABLE IF NOT EXISTS journal_schema_versions(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS journal_users (
  id uuid PRIMARY KEY, email text UNIQUE NOT NULL, password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS journal_auth_limits(key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS journal_sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES journal_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS journal_sessions_user ON journal_sessions(user_id);
CREATE INDEX IF NOT EXISTS journal_sessions_expiry ON journal_sessions(expires_at);
CREATE TABLE IF NOT EXISTS journal_accounts (
  user_id uuid NOT NULL REFERENCES journal_users(id) ON DELETE CASCADE, id uuid NOT NULL,
  name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), currency text NOT NULL DEFAULT 'USD',
  kind text NOT NULL CHECK(kind IN ('manual','import','sync')), broker text NOT NULL DEFAULT '',
  initial_balance numeric NOT NULL DEFAULT 0, method text NOT NULL DEFAULT 'fifo' CHECK(method IN ('fifo','lifo','wavg')),
  credentials_enc text, archived_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS journal_executions (
  user_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL,
  content_hash text NOT NULL, executed_at timestamptz NOT NULL, payload jsonb NOT NULL,
  PRIMARY KEY(user_id,id), UNIQUE(user_id,account_id,content_hash),
  FOREIGN KEY(user_id,account_id) REFERENCES journal_accounts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS journal_executions_account_time ON journal_executions(user_id,account_id,executed_at,id);
CREATE TABLE IF NOT EXISTS journal_trades (
  user_id uuid NOT NULL, key text NOT NULL, account_id uuid NOT NULL,
  opened_at timestamptz NOT NULL, closed_at timestamptz, payload jsonb NOT NULL,
  annotations jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
  PRIMARY KEY(user_id,key), FOREIGN KEY(user_id,account_id) REFERENCES journal_accounts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS journal_trades_page ON journal_trades(user_id,opened_at DESC,key DESC);
CREATE INDEX IF NOT EXISTS journal_trades_account_page ON journal_trades(user_id,account_id,opened_at DESC,key DESC);
CREATE TABLE IF NOT EXISTS journal_documents (
  user_id uuid NOT NULL REFERENCES journal_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('settings','journal','note','playbook','progress','missed','prop')),
  id text NOT NULL CHECK(length(id) BETWEEN 1 AND 200), payload jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,kind,id)
);
CREATE TABLE IF NOT EXISTS journal_jobs (
  user_id uuid NOT NULL, id uuid NOT NULL, account_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('import','sync')), idempotency_key text NOT NULL, payload_hash text NOT NULL,
  payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid, lease_until timestamptz, result jsonb, error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,id), UNIQUE(user_id,idempotency_key),
  FOREIGN KEY(user_id,account_id) REFERENCES journal_accounts(user_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS journal_jobs_account ON journal_jobs(user_id,account_id);
CREATE INDEX IF NOT EXISTS journal_jobs_claim ON journal_jobs(available_at,created_at) WHERE status IN ('queued','running');
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['journal_accounts','journal_executions','journal_trades','journal_documents','journal_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=tab AND policyname='journal_owner') THEN
      EXECUTE format($policy$CREATE POLICY journal_owner ON %I USING (user_id = (SELECT nullif(current_setting('journal.user_id',true),'')::uuid)) WITH CHECK (user_id = (SELECT nullif(current_setting('journal.user_id',true),'')::uuid))$policy$,tab);
    END IF;
  END LOOP;
END $$;
INSERT INTO journal_schema_versions(version) VALUES(1) ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION journal_claim_job() RETURNS SETOF journal_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE journal_jobs SET status='failed',error='Worker retry limit reached',lease_until=NULL,updated_at=now()
    WHERE status='running' AND lease_until<now() AND attempts>=3;
  RETURN QUERY WITH candidate AS (
    SELECT user_id,id FROM journal_jobs
    WHERE ((status='queued' AND available_at<=now()) OR (status='running' AND lease_until<now())) AND attempts<3
    ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1
  ) UPDATE journal_jobs j SET status='running',attempts=j.attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '60 seconds',updated_at=now()
    FROM candidate c WHERE j.user_id=c.user_id AND j.id=c.id RETURNING j.*;
END $$;
CREATE OR REPLACE FUNCTION journal_renew_job(owner uuid,job uuid,lease uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH renewed AS (UPDATE journal_jobs SET lease_until=now()+interval '60 seconds',updated_at=now()
    WHERE user_id=owner AND id=job AND lease_id=lease AND status='running' AND lease_until>now() RETURNING id)
  SELECT EXISTS(SELECT 1 FROM renewed);
$$;
REVOKE ALL ON FUNCTION journal_claim_job() FROM PUBLIC;
REVOKE ALL ON FUNCTION journal_renew_job(uuid,uuid,uuid) FROM PUBLIC;
COMMIT;
