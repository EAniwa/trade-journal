BEGIN;
ALTER TABLE journal_jobs ADD COLUMN IF NOT EXISTS payload_hash text NOT NULL DEFAULT 'legacy';
ALTER TABLE journal_jobs ALTER COLUMN payload_hash DROP DEFAULT;
INSERT INTO journal_schema_versions(version) VALUES(2) ON CONFLICT DO NOTHING;
COMMIT;
