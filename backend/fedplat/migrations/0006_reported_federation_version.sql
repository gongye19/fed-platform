ALTER TABLE memberships
  ADD COLUMN reported_release_id uuid REFERENCES releases(release_id),
  ADD COLUMN federation_version_reported_at timestamptz;
