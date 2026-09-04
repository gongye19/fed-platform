ALTER TABLE submissions ADD COLUMN submission_number bigint;

WITH numbered AS (
  SELECT submission_id,
         row_number() OVER (
           PARTITION BY app_id, federation_id, site_id
           ORDER BY created_at, submission_id
         ) AS value
  FROM submissions
)
UPDATE submissions s SET submission_number = numbered.value
FROM numbered WHERE numbered.submission_id = s.submission_id;

ALTER TABLE submissions
  ALTER COLUMN submission_number SET NOT NULL,
  ADD CHECK (submission_number > 0),
  ADD UNIQUE (app_id, federation_id, site_id, submission_number);

ALTER TABLE releases
  ADD COLUMN release_number bigint,
  ADD COLUMN generation_job_id uuid REFERENCES agent_jobs(job_id);

WITH numbered AS (
  SELECT release_id,
         row_number() OVER (
           PARTITION BY app_id, federation_id
           ORDER BY created_at, release_id
         ) AS value
  FROM releases
)
UPDATE releases r SET release_number = numbered.value
FROM numbered WHERE numbered.release_id = r.release_id;

ALTER TABLE releases
  ALTER COLUMN release_number SET NOT NULL,
  ADD CHECK (release_number > 0),
  ADD UNIQUE (app_id, federation_id, release_number);

WITH matched AS (
  SELECT r.release_id, r.created_at,
         (
           SELECT j.job_id
           FROM agent_jobs j
           WHERE j.app_id = r.app_id
             AND j.federation_id = r.federation_id
             AND j.kind = 'generation.requested'
             AND j.status = 'succeeded'
             AND j.created_at <= r.created_at
             AND EXISTS (
               SELECT 1
               FROM release_artifacts ra
               JOIN artifacts a
                 ON a.app_id = ra.app_id AND a.federation_id = ra.federation_id
                AND a.digest = ra.artifact_digest
               WHERE ra.release_id = r.release_id
                 AND a.metadata ->> 'round_id' = j.payload ->> 'round_id'
             )
           ORDER BY j.created_at DESC
           LIMIT 1
         ) AS job_id
  FROM releases r
), unique_jobs AS (
  SELECT *, row_number() OVER (PARTITION BY job_id ORDER BY created_at DESC) AS occurrence
  FROM matched WHERE job_id IS NOT NULL
)
UPDATE releases r SET generation_job_id = unique_jobs.job_id
FROM unique_jobs
WHERE unique_jobs.release_id = r.release_id AND unique_jobs.occurrence = 1;

ALTER TABLE releases ADD UNIQUE (generation_job_id);

CREATE TABLE release_inputs (
  release_id uuid NOT NULL REFERENCES releases(release_id),
  submission_id uuid NOT NULL REFERENCES submissions(submission_id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  PRIMARY KEY (release_id, submission_id),
  UNIQUE (release_id, ordinal)
);

INSERT INTO release_inputs (release_id, submission_id, ordinal)
SELECT r.release_id, s.submission_id, input.ordinal::integer
FROM releases r
JOIN agent_jobs j ON j.job_id = r.generation_job_id
CROSS JOIN LATERAL jsonb_array_elements_text(
  coalesce(j.payload -> 'submission_ids', '[]'::jsonb)
) WITH ORDINALITY AS input(submission_id, ordinal)
JOIN submissions s ON s.submission_id::text = input.submission_id;

ALTER TABLE deliveries ADD COLUMN targeted_at timestamptz;

UPDATE deliveries d SET targeted_at = first_command.created_at
FROM (
  SELECT delivery_id, min(created_at) AS created_at
  FROM commands
  GROUP BY delivery_id
) first_command
WHERE first_command.delivery_id = d.delivery_id;

CREATE INDEX release_inputs_by_submission ON release_inputs (submission_id);
CREATE INDEX deliveries_by_target ON deliveries (release_id, site_id)
  WHERE targeted_at IS NOT NULL;
