CREATE TABLE applications (
  app_id text PRIMARY KEY,
  display_name text NOT NULL,
  current_version text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE application_versions (
  app_id text NOT NULL REFERENCES applications(app_id),
  app_version text NOT NULL,
  adapter_protocol text NOT NULL,
  manifest_digest text NOT NULL,
  manifest jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, app_version)
);

CREATE TABLE app_agents (
  app_id text PRIMARY KEY REFERENCES applications(app_id),
  core_plugin_id text NOT NULL,
  status text NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'failed', 'disabled')),
  config jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sites (
  site_id text PRIMARY KEY,
  display_name text NOT NULL,
  node_version text,
  last_seen_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_credentials (
  credential_id uuid PRIMARY KEY,
  site_id text NOT NULL REFERENCES sites(site_id),
  token_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE CHECK (length(key_hash) = 64),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE federations (
  app_id text NOT NULL REFERENCES applications(app_id),
  federation_id text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, federation_id)
);

CREATE TABLE memberships (
  app_id text NOT NULL,
  federation_id text NOT NULL,
  site_id text NOT NULL REFERENCES sites(site_id),
  can_submit boolean NOT NULL DEFAULT false,
  can_receive boolean NOT NULL DEFAULT false,
  can_execute_task boolean NOT NULL DEFAULT false,
  joined_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  PRIMARY KEY (app_id, federation_id, site_id),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);

CREATE TABLE artifact_types (
  app_id text NOT NULL REFERENCES applications(app_id),
  type_name text NOT NULL,
  format_version integer NOT NULL CHECK (format_version > 0),
  media_type text NOT NULL,
  schema_digest text NOT NULL,
  metadata_schema jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, type_name, format_version)
);

CREATE TABLE task_types (
  app_id text NOT NULL REFERENCES applications(app_id),
  type_name text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  input_schema_digest text NOT NULL,
  output_schema_digest text NOT NULL,
  input_schema jsonb NOT NULL DEFAULT '{}',
  output_schema jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, type_name, version)
);

CREATE TABLE artifacts (
  app_id text NOT NULL,
  federation_id text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  type_name text NOT NULL,
  format_version integer NOT NULL,
  media_type text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  metadata jsonb NOT NULL DEFAULT '{}',
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, federation_id, digest),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id),
  FOREIGN KEY (app_id, type_name, format_version)
    REFERENCES artifact_types(app_id, type_name, format_version)
);

CREATE TABLE submissions (
  submission_id uuid PRIMARY KEY,
  app_id text NOT NULL,
  federation_id text NOT NULL,
  site_id text NOT NULL,
  artifact_digest text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, federation_id, site_id, idempotency_key),
  FOREIGN KEY (app_id, federation_id, site_id)
    REFERENCES memberships(app_id, federation_id, site_id),
  FOREIGN KEY (app_id, federation_id, artifact_digest)
    REFERENCES artifacts(app_id, federation_id, digest)
);

CREATE TABLE events (
  event_id uuid PRIMARY KEY,
  app_id text NOT NULL,
  federation_id text NOT NULL,
  site_id text,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);

CREATE TABLE agent_jobs (
  job_id uuid PRIMARY KEY,
  app_id text NOT NULL,
  federation_id text NOT NULL,
  kind text NOT NULL,
  dedupe_key text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_by text,
  leased_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, federation_id, kind, dedupe_key),
  FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id)
);

CREATE TABLE audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  app_id text,
  federation_id text,
  site_id text,
  target_type text NOT NULL,
  target_id text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  result text NOT NULL DEFAULT 'success',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX memberships_by_site ON memberships (site_id, ended_at);
CREATE INDEX artifacts_by_type
  ON artifacts (app_id, federation_id, type_name, created_at DESC);
CREATE INDEX submissions_latest
  ON submissions (app_id, federation_id, created_at DESC);
CREATE INDEX events_latest
  ON events (app_id, federation_id, received_at DESC);
CREATE INDEX agent_jobs_ready
  ON agent_jobs (status, available_at)
  WHERE status IN ('pending', 'retry');
CREATE INDEX audit_latest ON audit_log (created_at DESC);
