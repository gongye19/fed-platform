CREATE TABLE releases (
  release_id uuid PRIMARY KEY,
  app_id text NOT NULL,
  federation_id text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);

CREATE TABLE release_artifacts (
  release_id uuid NOT NULL REFERENCES releases(release_id),
  app_id text NOT NULL,
  federation_id text NOT NULL,
  artifact_digest text NOT NULL,
  PRIMARY KEY (release_id, artifact_digest),
  FOREIGN KEY (app_id, federation_id, artifact_digest)
    REFERENCES artifacts(app_id, federation_id, digest)
);

CREATE TABLE deliveries (
  delivery_id uuid PRIMARY KEY,
  release_id uuid NOT NULL REFERENCES releases(release_id),
  app_id text NOT NULL,
  federation_id text NOT NULL,
  site_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'staged', 'active', 'failed', 'rolled_back')),
  failed_action text CHECK (failed_action IN ('stage', 'activate', 'rollback')),
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (release_id, site_id),
  FOREIGN KEY (app_id, federation_id, site_id)
    REFERENCES memberships(app_id, federation_id, site_id)
);

CREATE TABLE commands (
  command_cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  command_id uuid NOT NULL UNIQUE,
  delivery_id uuid NOT NULL REFERENCES deliveries(delivery_id),
  app_id text NOT NULL,
  federation_id text NOT NULL,
  site_id text NOT NULL,
  command_type text NOT NULL
    CHECK (command_type IN ('release.stage', 'release.activate', 'release.rollback')),
  attempt integer NOT NULL CHECK (attempt > 0),
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acked', 'failed')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  UNIQUE (delivery_id, command_type, attempt)
);

CREATE INDEX releases_latest
  ON releases (app_id, federation_id, created_at DESC);
CREATE INDEX deliveries_by_release ON deliveries (release_id, state);
CREATE INDEX commands_for_site
  ON commands (site_id, command_cursor)
  WHERE status = 'pending';
