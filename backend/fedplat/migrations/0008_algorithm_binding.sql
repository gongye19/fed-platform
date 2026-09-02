ALTER TABLE federation_agents
  ADD COLUMN algorithm_plugin_id text,
  ADD COLUMN algorithm_plugin_version text,
  ADD COLUMN algorithm_config jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN algorithm_state jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN algorithm_state_revision bigint NOT NULL DEFAULT 1
    CHECK (algorithm_state_revision > 0),
  ADD CONSTRAINT federation_agent_algorithm_pair CHECK (
    (algorithm_plugin_id IS NULL) = (algorithm_plugin_version IS NULL)
  );
