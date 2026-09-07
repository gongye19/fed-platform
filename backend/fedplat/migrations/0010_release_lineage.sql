ALTER TABLE releases
  ADD COLUMN base_release_id uuid REFERENCES releases(release_id);

CREATE INDEX releases_by_base ON releases (base_release_id)
  WHERE base_release_id IS NOT NULL;
