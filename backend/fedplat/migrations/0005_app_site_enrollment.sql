CREATE TABLE app_site_credentials (
  credential_id uuid PRIMARY KEY,
  app_id text NOT NULL REFERENCES applications(app_id),
  site_id text NOT NULL,
  display_name text NOT NULL,
  token_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX app_site_credentials_by_site
  ON app_site_credentials (app_id, site_id, created_at DESC);

ALTER TABLE memberships
  ADD COLUMN app_version text,
  ADD COLUMN last_seen_at timestamptz;

INSERT INTO federations (app_id, federation_id, display_name)
SELECT app_id, 'default', display_name
FROM applications a
WHERE NOT EXISTS (
  SELECT 1 FROM federations f
  WHERE f.app_id = a.app_id AND f.disabled_at IS NULL
);

CREATE UNIQUE INDEX one_active_federation_per_app
  ON federations (app_id)
  WHERE disabled_at IS NULL;
