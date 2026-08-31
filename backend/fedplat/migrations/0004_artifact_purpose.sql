ALTER TABLE artifact_types
  ADD COLUMN purpose text NOT NULL DEFAULT 'contribution'
  CHECK (purpose IN ('contribution', 'release', 'evaluation'));
