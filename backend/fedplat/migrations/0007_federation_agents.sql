ALTER TABLE app_agents RENAME TO federation_agents;

ALTER TABLE federation_agents
  ADD COLUMN federation_id text;

UPDATE federation_agents agent
SET federation_id = (
  SELECT federation_id
  FROM federations
  WHERE app_id = agent.app_id AND disabled_at IS NULL
  ORDER BY federation_id
  LIMIT 1
);

ALTER TABLE federation_agents
  ALTER COLUMN federation_id SET NOT NULL,
  DROP CONSTRAINT app_agents_pkey,
  ADD PRIMARY KEY (app_id, federation_id),
  ADD FOREIGN KEY (app_id, federation_id)
    REFERENCES federations(app_id, federation_id);
