CREATE TABLE IF NOT EXISTS journal_identities (
 provider text NOT NULL, subject text NOT NULL, user_id uuid NOT NULL REFERENCES journal_users(id) ON DELETE CASCADE,
 PRIMARY KEY(provider,subject), UNIQUE(user_id,provider)
);
CREATE TABLE IF NOT EXISTS journal_auth_transfers (
 ticket_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES journal_users(id) ON DELETE CASCADE,
 challenge text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_auth_transfers_expiry ON journal_auth_transfers(expires_at);

CREATE INDEX IF NOT EXISTS journal_auth_transfers_user ON journal_auth_transfers(user_id);
