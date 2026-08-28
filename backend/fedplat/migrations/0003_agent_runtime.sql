ALTER TABLE app_agents
  ADD COLUMN core_plugin_version text NOT NULL DEFAULT '1.0.0',
  ADD COLUMN state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN state_revision bigint NOT NULL DEFAULT 1 CHECK (state_revision > 0);

ALTER TABLE agent_jobs
  ADD COLUMN result jsonb;
