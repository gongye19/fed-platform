from __future__ import annotations

import hashlib
import uuid
from contextlib import contextmanager
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


class ConflictError(RuntimeError):
    pass


class NotFoundError(RuntimeError):
    pass


class ForbiddenError(RuntimeError):
    pass


class Database:
    def __init__(self, database_url: str) -> None:
        self.database_url = database_url

    @contextmanager
    def connection(self) -> Iterator[psycopg.Connection]:
        # ponytail: one connection per operation; add psycopg_pool when concurrency warrants it.
        with psycopg.connect(self.database_url, row_factory=dict_row) as conn:
            yield conn

    def health(self) -> None:
        with self.connection() as conn:
            conn.execute("SELECT 1").fetchone()

    def register_application(
        self,
        manifest: dict[str, Any],
        manifest_digest: str,
        agent_binding: dict[str, Any],
    ) -> bool:
        app_id = manifest["app_id"]
        app_version = manifest["app_version"]
        with self.connection() as conn:
            existing = conn.execute(
                """SELECT manifest_digest FROM application_versions
                   WHERE app_id = %s AND app_version = %s""",
                (app_id, app_version),
            ).fetchone()
            if existing:
                if existing["manifest_digest"] != manifest_digest:
                    raise ConflictError("the app version is already registered with another manifest")
                return False

            conn.execute(
                """INSERT INTO applications (app_id, display_name, current_version)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (app_id) DO UPDATE
                   SET display_name = EXCLUDED.display_name,
                       current_version = EXCLUDED.current_version,
                       updated_at = now()""",
                (app_id, manifest["display_name"], app_version),
            )
            conn.execute(
                """INSERT INTO application_versions
                   (app_id, app_version, adapter_protocol, manifest_digest, manifest)
                   VALUES (%s, %s, %s, %s, %s)""",
                (
                    app_id,
                    app_version,
                    manifest["adapter_protocol"],
                    manifest_digest,
                    Jsonb(manifest),
                ),
            )
            conn.execute(
                """INSERT INTO federations (app_id, federation_id, display_name)
                   SELECT %s, 'default', %s
                   WHERE NOT EXISTS (
                     SELECT 1 FROM federations
                     WHERE app_id = %s AND disabled_at IS NULL
                   )
                   ON CONFLICT (app_id, federation_id) DO NOTHING""",
                (app_id, manifest["display_name"], app_id),
            )
            federation_id = conn.execute(
                """SELECT federation_id FROM federations
                   WHERE app_id = %s AND disabled_at IS NULL
                   ORDER BY federation_id LIMIT 1""",
                (app_id,),
            ).fetchone()["federation_id"]
            conn.execute(
                """INSERT INTO federation_agents
                   (app_id, federation_id, core_plugin_id, core_plugin_version, config,
                    algorithm_plugin_id, algorithm_plugin_version, algorithm_config)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (app_id, federation_id) DO NOTHING""",
                (
                    app_id,
                    federation_id,
                    agent_binding["core_plugin_id"],
                    agent_binding["core_plugin_version"],
                    Jsonb(agent_binding["config"]),
                    manifest["federation"]["algorithm"]["plugin_id"]
                    if manifest["federation"]["algorithm"]
                    else None,
                    manifest["federation"]["algorithm"]["plugin_version"]
                    if manifest["federation"]["algorithm"]
                    else None,
                    Jsonb(
                        manifest["federation"]["algorithm"]["config"]
                        if manifest["federation"]["algorithm"]
                        else {}
                    ),
                ),
            )

            for item in manifest["artifact_types"]:
                row = conn.execute(
                    """INSERT INTO artifact_types
                       (app_id, type_name, format_version, media_type, purpose,
                        schema_digest, metadata_schema)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (app_id, type_name, format_version) DO NOTHING
                       RETURNING type_name""",
                    (
                        app_id,
                        item["type"],
                        item["format_version"],
                        item["media_type"],
                        item["purpose"],
                        item["schema_digest"],
                        Jsonb(item["metadata_schema"]),
                    ),
                ).fetchone()
                if not row:
                    current = conn.execute(
                        """SELECT media_type, purpose, schema_digest FROM artifact_types
                           WHERE app_id = %s AND type_name = %s AND format_version = %s""",
                        (app_id, item["type"], item["format_version"]),
                    ).fetchone()
                    if current != {
                        "media_type": item["media_type"],
                        "purpose": item["purpose"],
                        "schema_digest": item["schema_digest"],
                    }:
                        raise ConflictError("an artifact type version cannot change semantics")

            for item in manifest["task_types"]:
                row = conn.execute(
                    """INSERT INTO task_types
                       (app_id, type_name, version, input_schema_digest, output_schema_digest,
                        input_schema, output_schema)
                       VALUES (%s, %s, %s, %s, %s, %s, %s)
                       ON CONFLICT (app_id, type_name, version) DO NOTHING
                       RETURNING type_name""",
                    (
                        app_id,
                        item["type"],
                        item["version"],
                        item["input_schema_digest"],
                        item["output_schema_digest"],
                        Jsonb(item["input_schema"]),
                        Jsonb(item["output_schema"]),
                    ),
                ).fetchone()
                if not row:
                    current = conn.execute(
                        """SELECT input_schema_digest, output_schema_digest FROM task_types
                           WHERE app_id = %s AND type_name = %s AND version = %s""",
                        (app_id, item["type"], item["version"]),
                    ).fetchone()
                    if current != {
                        "input_schema_digest": item["input_schema_digest"],
                        "output_schema_digest": item["output_schema_digest"],
                    }:
                        raise ConflictError("a task type version cannot change semantics")

            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'application.registered', %s, 'application', %s, %s)""",
                (app_id, app_id, Jsonb({"app_version": app_version})),
            )
        return True

    def list_applications(self, *, after: str | None, limit: int) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT a.app_id, a.display_name, a.current_version, a.status,
                          fa.status AS agent_status, fa.core_plugin_id, fa.core_plugin_version,
                          count(DISTINCT f.federation_id) AS federation_count,
                          count(DISTINCT m.site_id) AS site_count
                   FROM applications a
                   JOIN federations f ON f.app_id = a.app_id AND f.disabled_at IS NULL
                   JOIN federation_agents fa
                     ON fa.app_id = f.app_id AND fa.federation_id = f.federation_id
                   LEFT JOIN memberships m
                     ON m.app_id = f.app_id AND m.federation_id = f.federation_id
                    AND m.ended_at IS NULL
                   WHERE (%s::text IS NULL OR a.app_id > %s)
                   GROUP BY a.app_id, fa.status, fa.core_plugin_id, fa.core_plugin_version
                   ORDER BY a.app_id
                   LIMIT %s""",
                (after, after, limit),
            ).fetchall()

    def get_agent_configuration(self, app_id: str, federation_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT app_id, federation_id, core_plugin_id, core_plugin_version, status,
                          config, algorithm_plugin_id, algorithm_plugin_version,
                          algorithm_config, revision, state_revision,
                          algorithm_state_revision, updated_at
                   FROM federation_agents WHERE app_id = %s AND federation_id = %s""",
                (app_id, federation_id),
            ).fetchone()
            if not row:
                raise NotFoundError("application agent not found")
            return row

    def update_algorithm_configuration(
        self,
        app_id: str,
        federation_id: str,
        plugin_id: str,
        plugin_version: str,
        config: dict[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(
                """UPDATE federation_agents
                   SET algorithm_plugin_id = %s, algorithm_plugin_version = %s,
                       algorithm_config = %s, algorithm_state = '{}'::jsonb,
                       algorithm_state_revision = algorithm_state_revision + 1,
                       state = '{}'::jsonb, state_revision = state_revision + 1,
                       revision = revision + 1, status = 'idle', updated_at = now()
                   WHERE app_id = %s AND federation_id = %s AND revision = %s
                   RETURNING app_id, federation_id, core_plugin_id, core_plugin_version,
                             status, config, algorithm_plugin_id, algorithm_plugin_version,
                             algorithm_config, revision, state_revision,
                             algorithm_state_revision, updated_at""",
                (
                    plugin_id,
                    plugin_version,
                    Jsonb(config),
                    app_id,
                    federation_id,
                    expected_revision,
                ),
            ).fetchone()
            if not row:
                if not conn.execute(
                    """SELECT 1 FROM federation_agents
                       WHERE app_id = %s AND federation_id = %s""",
                    (app_id, federation_id),
                ).fetchone():
                    raise NotFoundError("federation agent not found")
                raise ConflictError("agent configuration revision changed")
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'agent.algorithm.configured', %s, %s,
                           'agent', %s, %s)""",
                (
                    app_id,
                    federation_id,
                    f"{app_id}/{federation_id}",
                    Jsonb(
                        {
                            "algorithm_plugin_id": plugin_id,
                            "algorithm_plugin_version": plugin_version,
                            "revision": row["revision"],
                        }
                    ),
                ),
            )
            return row

    def update_agent_configuration(
        self,
        app_id: str,
        federation_id: str,
        core_plugin_id: str,
        core_plugin_version: str,
        config: dict[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            current = conn.execute(
                """SELECT core_plugin_id, core_plugin_version
                   FROM federation_agents
                   WHERE app_id = %s AND federation_id = %s FOR UPDATE""",
                (app_id, federation_id),
            ).fetchone()
            if not current:
                raise NotFoundError("application agent not found")
            reset_state = (
                current["core_plugin_id"] != core_plugin_id
                or current["core_plugin_version"] != core_plugin_version
            )
            row = conn.execute(
                """UPDATE federation_agents
                   SET core_plugin_id = %s, core_plugin_version = %s, config = %s,
                       revision = revision + 1,
                       state = CASE WHEN %s THEN '{}'::jsonb ELSE state END,
                       state_revision = state_revision + CASE WHEN %s THEN 1 ELSE 0 END,
                       status = 'idle', updated_at = now()
                   WHERE app_id = %s AND federation_id = %s AND revision = %s
                   RETURNING app_id, federation_id, core_plugin_id, core_plugin_version,
                             status, config, algorithm_plugin_id, algorithm_plugin_version,
                             algorithm_config, revision, state_revision,
                             algorithm_state_revision, updated_at""",
                (
                    core_plugin_id,
                    core_plugin_version,
                    Jsonb(config),
                    reset_state,
                    reset_state,
                    app_id,
                    federation_id,
                    expected_revision,
                ),
            ).fetchone()
            if not row:
                raise ConflictError("agent configuration revision changed")
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'agent.configured', %s, %s,
                           'agent', %s, %s)""",
                (
                    app_id,
                    federation_id,
                    f"{app_id}/{federation_id}",
                    Jsonb(
                        {
                            "core_plugin_id": core_plugin_id,
                            "core_plugin_version": core_plugin_version,
                            "revision": row["revision"],
                        }
                    ),
                ),
            )
            return row

    def issue_app_site_key(
        self,
        app_id: str,
        site_id: str,
        display_name: str,
        token_prefix: str,
        key_hash: str,
    ) -> None:
        with self.connection() as conn:
            if not conn.execute(
                "SELECT 1 FROM applications WHERE app_id = %s AND status = 'active'",
                (app_id,),
            ).fetchone():
                raise NotFoundError("application not found")
            conn.execute(
                """UPDATE app_site_credentials SET revoked_at = now()
                   WHERE app_id = %s AND site_id = %s AND revoked_at IS NULL""",
                (app_id, site_id),
            )
            conn.execute(
                """INSERT INTO app_site_credentials
                   (credential_id, app_id, site_id, display_name, token_prefix, key_hash)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (uuid.uuid4(), app_id, site_id, display_name, token_prefix, key_hash),
            )
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, site_id, target_type, target_id)
                   VALUES ('admin', 'admin', 'site.key.issued', %s, %s, 'site', %s)""",
                (app_id, site_id, site_id),
            )

    def authenticate_app_site(self, app_id: str, key_hash: str) -> dict[str, str]:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT site_id, display_name
                   FROM app_site_credentials
                   WHERE app_id = %s AND key_hash = %s
                     AND revoked_at IS NULL
                     AND (expires_at IS NULL OR expires_at > now())""",
                (app_id, key_hash),
            ).fetchone()
            if not row:
                raise ForbiddenError("invalid application site credential")
            return row

    def submission_policy(
        self,
        app_id: str,
        app_version: str,
        type_name: str,
        format_version: int,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            if not conn.execute(
                """SELECT 1 FROM application_versions
                   WHERE app_id = %s AND app_version = %s""",
                (app_id, app_version),
            ).fetchone():
                raise ConflictError("site application version is not registered")
            federation_id = self._app_federation(conn, app_id)
            return {
                **self._artifact_policy(conn, app_id, federation_id, type_name, format_version),
                "federation_id": federation_id,
            }

    def report_site_status(
        self,
        *,
        app_id: str,
        site_id: str,
        display_name: str,
        app_version: str,
        active_release_id: uuid.UUID | None,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            if not conn.execute(
                """SELECT 1 FROM application_versions
                   WHERE app_id = %s AND app_version = %s""",
                (app_id, app_version),
            ).fetchone():
                raise ConflictError("site application version is not registered")
            federation_id = self._app_federation(conn, app_id)
            previous = conn.execute(
                """SELECT reported_release_id FROM memberships
                   WHERE app_id = %s AND federation_id = %s AND site_id = %s
                     AND ended_at IS NULL""",
                (app_id, federation_id, site_id),
            ).fetchone()
            if not previous:
                raise NotFoundError("site membership is created by its first artifact upload")
            if active_release_id and not conn.execute(
                """SELECT 1 FROM releases
                   WHERE release_id = %s AND app_id = %s AND federation_id = %s""",
                (active_release_id, app_id, federation_id),
            ).fetchone():
                raise ConflictError("active release does not belong to this application")
            conn.execute(
                """UPDATE sites SET display_name = %s, last_seen_at = now()
                   WHERE site_id = %s""",
                (display_name, site_id),
            )
            membership = conn.execute(
                """UPDATE memberships
                   SET app_version = %s, last_seen_at = now(),
                       reported_release_id = %s,
                       federation_version_reported_at = now()
                   WHERE app_id = %s AND federation_id = %s AND site_id = %s
                   RETURNING app_version, reported_release_id,
                             federation_version_reported_at""",
                (app_version, active_release_id, app_id, federation_id, site_id),
            ).fetchone()
            if previous["reported_release_id"] != active_release_id:
                conn.execute(
                    """INSERT INTO audit_log
                       (actor_type, actor_id, action, app_id, federation_id, site_id,
                        target_type, target_id, detail)
                       VALUES ('site', %s, 'site.version.reported', %s, %s, %s,
                               'release', %s, %s)""",
                    (
                        site_id,
                        app_id,
                        federation_id,
                        site_id,
                        str(active_release_id) if active_release_id else "none",
                        Jsonb({
                            "previous_release_id": (
                                str(previous["reported_release_id"])
                                if previous["reported_release_id"] else None
                            ),
                            "reported_release_id": (
                                str(active_release_id) if active_release_id else None
                            ),
                        }),
                    ),
                )
            return {
                "app_id": app_id,
                "federation_id": federation_id,
                "site_id": site_id,
                "app_version": membership["app_version"],
                "active_release_id": (
                    str(membership["reported_release_id"])
                    if membership["reported_release_id"] else None
                ),
                "reported_at": membership["federation_version_reported_at"],
            }

    @staticmethod
    def _app_federation(conn: psycopg.Connection, app_id: str) -> str:
        rows = conn.execute(
            """SELECT federation_id FROM federations
               WHERE app_id = %s AND disabled_at IS NULL""",
            (app_id,),
        ).fetchall()
        if not rows:
            raise NotFoundError("application federation not found")
        if len(rows) > 1:
            raise ConflictError("application has more than one active federation")
        return rows[0]["federation_id"]

    def artifact_policy(
        self,
        app_id: str,
        federation_id: str,
        type_name: str,
        format_version: int,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            return self._artifact_policy(conn, app_id, federation_id, type_name, format_version)

    @staticmethod
    def _artifact_policy(
        conn: psycopg.Connection,
        app_id: str,
        federation_id: str,
        type_name: str,
        format_version: int,
    ) -> dict[str, Any]:
        artifact_type = conn.execute(
            """SELECT at.media_type, at.purpose, at.schema_digest, at.metadata_schema
               FROM artifact_types at
               JOIN federations f ON f.app_id = at.app_id
               WHERE at.app_id = %s AND f.federation_id = %s
                 AND f.disabled_at IS NULL
                 AND at.type_name = %s AND at.format_version = %s""",
            (app_id, federation_id, type_name, format_version),
        ).fetchone()
        if not artifact_type:
            raise NotFoundError("federation or artifact type not registered")
        return artifact_type

    @staticmethod
    def _upsert_artifact(
        conn: psycopg.Connection,
        app_id: str,
        federation_id: str,
        descriptor: dict[str, Any],
        storage_key: str,
    ) -> tuple[dict[str, Any], bool]:
        artifact = conn.execute(
            """INSERT INTO artifacts
               (app_id, federation_id, digest, type_name, format_version,
                media_type, size_bytes, metadata, storage_key)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (app_id, federation_id, digest) DO NOTHING
               RETURNING digest, type_name, format_version, media_type, size_bytes,
                         metadata, storage_key, created_at""",
            (
                app_id,
                federation_id,
                descriptor["digest"],
                descriptor["type"],
                descriptor["format_version"],
                descriptor["media_type"],
                descriptor["size_bytes"],
                Jsonb(descriptor["metadata"]),
                storage_key,
            ),
        ).fetchone()
        if artifact:
            return artifact, True
        artifact = conn.execute(
            """SELECT digest, type_name, format_version, media_type, size_bytes,
                      metadata, storage_key, created_at
               FROM artifacts
               WHERE app_id = %s AND federation_id = %s AND digest = %s""",
            (app_id, federation_id, descriptor["digest"]),
        ).fetchone()
        expected = {
            "type_name": descriptor["type"],
            "format_version": descriptor["format_version"],
            "media_type": descriptor["media_type"],
            "size_bytes": descriptor["size_bytes"],
            "metadata": descriptor["metadata"],
        }
        if {key: artifact[key] for key in expected} != expected:
            raise ConflictError("artifact digest already has another descriptor")
        return artifact, False

    def create_artifact(
        self,
        *,
        app_id: str,
        federation_id: str,
        descriptor: dict[str, Any],
        storage_key: str,
        actor_type: str = "admin",
        actor_id: str = "admin",
    ) -> tuple[dict[str, Any], bool]:
        with self.connection() as conn:
            self._artifact_policy(
                conn,
                app_id,
                federation_id,
                descriptor["type"],
                descriptor["format_version"],
            )
            artifact, created = self._upsert_artifact(
                conn, app_id, federation_id, descriptor, storage_key
            )
            if created:
                conn.execute(
                    """INSERT INTO audit_log
                       (actor_type, actor_id, action, app_id, federation_id,
                        target_type, target_id, detail)
                       VALUES (%s, %s, 'artifact.created', %s, %s,
                               'artifact', %s, %s)""",
                    (
                        actor_type,
                        actor_id,
                        app_id,
                        federation_id,
                        descriptor["digest"],
                        Jsonb({"type": descriptor["type"]}),
                    ),
                )
            return artifact, created

    def get_algorithm_inputs(
        self, app_id: str, federation_id: str, submission_ids: list[str]
    ) -> list[dict[str, Any]]:
        if len(submission_ids) != len(set(submission_ids)):
            raise ConflictError("algorithm input submission IDs must be unique")
        with self.connection() as conn:
            rows = conn.execute(
                """SELECT s.submission_id, s.site_id, a.digest, a.type_name,
                          a.format_version, a.media_type, a.size_bytes, a.metadata,
                          a.storage_key
                   FROM submissions s
                   JOIN artifacts a
                     ON a.app_id = s.app_id AND a.federation_id = s.federation_id
                    AND a.digest = s.artifact_digest
                   JOIN artifact_types at
                     ON at.app_id = a.app_id AND at.type_name = a.type_name
                    AND at.format_version = a.format_version
                   WHERE s.app_id = %s AND s.federation_id = %s
                     AND s.submission_id = ANY(%s::uuid[])
                     AND s.status = 'accepted' AND at.purpose = 'contribution'
                   ORDER BY s.site_id, s.created_at""",
                (app_id, federation_id, submission_ids),
            ).fetchall()
            if len(rows) != len(submission_ids):
                raise NotFoundError("one or more algorithm inputs are unavailable in this federation")
            return rows

    def request_generation(
        self,
        app_id: str,
        federation_id: str,
        round_id: str,
        submission_ids: list[str],
    ) -> tuple[dict[str, Any], bool]:
        self.get_algorithm_inputs(app_id, federation_id, submission_ids)
        with self.connection() as conn:
            agent = conn.execute(
                """SELECT revision FROM federation_agents
                   WHERE app_id = %s AND federation_id = %s
                     AND algorithm_plugin_id IS NOT NULL""",
                (app_id, federation_id),
            ).fetchone()
            if not agent:
                raise ConflictError("federation domain has no algorithm binding")
            dedupe_key = hashlib.sha256(
                (
                    round_id
                    + f"\nrevision:{agent['revision']}\n"
                    + "\n".join(sorted(submission_ids))
                ).encode()
            ).hexdigest()
            payload = {
                "round_id": round_id,
                "submission_ids": submission_ids,
                "agent_config_revision": agent["revision"],
            }
            job = conn.execute(
                """INSERT INTO agent_jobs
                   (job_id, app_id, federation_id, kind, dedupe_key, payload)
                   VALUES (%s, %s, %s, 'generation.requested', %s, %s)
                   ON CONFLICT (app_id, federation_id, kind, dedupe_key) DO NOTHING
                   RETURNING job_id, status, created_at""",
                (
                    uuid.uuid4(),
                    app_id,
                    federation_id,
                    dedupe_key,
                    Jsonb(payload),
                ),
            ).fetchone()
            if not job:
                return (
                    conn.execute(
                        """SELECT job_id, status, created_at FROM agent_jobs
                           WHERE app_id = %s AND federation_id = %s
                             AND kind = 'generation.requested' AND dedupe_key = %s""",
                        (app_id, federation_id, dedupe_key),
                    ).fetchone(),
                    False,
                )
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'generation.requested', %s, %s,
                           'agent_job', %s, %s)""",
                (
                    app_id,
                    federation_id,
                    str(job["job_id"]),
                    Jsonb(payload),
                ),
            )
            return job, True

    def get_agent_job(
        self, app_id: str, federation_id: str, job_id: uuid.UUID
    ) -> dict[str, Any]:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT job_id, kind, status, attempts, result, last_error,
                          created_at, updated_at
                   FROM agent_jobs
                   WHERE app_id = %s AND federation_id = %s AND job_id = %s""",
                (app_id, federation_id, job_id),
            ).fetchone()
            if not row:
                raise NotFoundError("agent job not found")
            return row

    def get_artifact(
        self, app_id: str, federation_id: str, digest: str
    ) -> dict[str, Any]:
        with self.connection() as conn:
            artifact = conn.execute(
                """SELECT digest, type_name, format_version, media_type, size_bytes,
                          metadata, storage_key, created_at
                   FROM artifacts
                   WHERE app_id = %s AND federation_id = %s AND digest = %s""",
                (app_id, federation_id, digest),
            ).fetchone()
            if not artifact:
                raise NotFoundError("artifact not found")
            return artifact

    def create_submission(
        self,
        *,
        app_id: str,
        federation_id: str,
        site_id: str,
        display_name: str,
        app_version: str,
        descriptor: dict[str, Any],
        artifact_purpose: str,
        storage_key: str,
        idempotency_key: str,
    ) -> tuple[dict[str, Any], bool]:
        with self.connection() as conn:
            if not conn.execute(
                """SELECT 1 FROM application_versions
                   WHERE app_id = %s AND app_version = %s""",
                (app_id, app_version),
            ).fetchone():
                raise ConflictError("site application version is not registered")
            if self._app_federation(conn, app_id) != federation_id:
                raise ConflictError("application federation changed during upload")

            conn.execute(
                """INSERT INTO sites (site_id, display_name, last_seen_at)
                   VALUES (%s, %s, now())
                   ON CONFLICT (site_id) DO UPDATE
                   SET display_name = EXCLUDED.display_name,
                       last_seen_at = now(), disabled_at = NULL""",
                (site_id, display_name),
            )
            membership = conn.execute(
                """SELECT 1 FROM memberships
                   WHERE app_id = %s AND federation_id = %s AND site_id = %s""",
                (app_id, federation_id, site_id),
            ).fetchone()
            conn.execute(
                """INSERT INTO memberships
                   (app_id, federation_id, site_id, can_submit, can_receive,
                    can_execute_task, app_version, last_seen_at)
                   VALUES (%s, %s, %s, true, true, false, %s, now())
                   ON CONFLICT (app_id, federation_id, site_id) DO UPDATE
                   SET can_submit = true, can_receive = true,
                       app_version = EXCLUDED.app_version,
                       last_seen_at = now(), ended_at = NULL""",
                (app_id, federation_id, site_id, app_version),
            )
            if not membership:
                conn.execute(
                    """INSERT INTO audit_log
                       (actor_type, actor_id, action, app_id, federation_id, site_id,
                        target_type, target_id, detail)
                       VALUES ('site', %s, 'site.enrolled', %s, %s, %s,
                               'membership', %s, %s)""",
                    (
                        site_id,
                        app_id,
                        federation_id,
                        site_id,
                        site_id,
                        Jsonb({"app_version": app_version, "reported_release_id": None}),
                    ),
                )

            self._upsert_artifact(conn, app_id, federation_id, descriptor, storage_key)

            submission_id = uuid.uuid4()
            submission = conn.execute(
                """INSERT INTO submissions
                   (submission_id, app_id, federation_id, site_id, artifact_digest, idempotency_key)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (app_id, federation_id, site_id, idempotency_key) DO NOTHING
                   RETURNING submission_id, artifact_digest, created_at""",
                (submission_id, app_id, federation_id, site_id, descriptor["digest"], idempotency_key),
            ).fetchone()
            if not submission:
                existing = conn.execute(
                    """SELECT submission_id, artifact_digest, created_at FROM submissions
                       WHERE app_id = %s AND federation_id = %s AND site_id = %s
                         AND idempotency_key = %s""",
                    (app_id, federation_id, site_id, idempotency_key),
                ).fetchone()
                if existing["artifact_digest"] != descriptor["digest"]:
                    raise ConflictError("idempotency key already belongs to another artifact")
                return existing, False

            event_type = (
                "evaluation.received"
                if artifact_purpose == "evaluation"
                else "submission.accepted"
            )
            event_payload = {
                "submission_id": str(submission_id),
                "artifact_digest": descriptor["digest"],
                "artifact_type": descriptor["type"],
                "artifact_purpose": artifact_purpose,
                "artifact_metadata": descriptor["metadata"],
            }
            conn.execute(
                """INSERT INTO events
                   (event_id, app_id, federation_id, site_id, event_type,
                    entity_type, entity_id, payload, occurred_at)
                   VALUES (%s, %s, %s, %s, %s,
                           'submission', %s, %s, now())""",
                (
                    uuid.uuid4(),
                    app_id,
                    federation_id,
                    site_id,
                    event_type,
                    str(submission_id),
                    Jsonb(event_payload),
                ),
            )
            conn.execute(
                """INSERT INTO agent_jobs
                   (job_id, app_id, federation_id, kind, dedupe_key, payload)
                   VALUES (%s, %s, %s, %s, %s, %s)""",
                (
                    uuid.uuid4(),
                    app_id,
                    federation_id,
                    event_type,
                    str(submission_id),
                    Jsonb(event_payload),
                ),
            )
            return submission, True

    def topology(self, app_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            application = conn.execute(
                """SELECT a.app_id, a.display_name, a.current_version, a.status,
                          fa.status AS agent_status, fa.core_plugin_id,
                          fa.core_plugin_version, fa.revision AS agent_config_revision,
                          fa.state_revision AS agent_state_revision,
                          fa.algorithm_plugin_id, fa.algorithm_plugin_version, av.manifest
                   FROM applications a
                   JOIN federations f ON f.app_id = a.app_id AND f.disabled_at IS NULL
                   JOIN federation_agents fa
                     ON fa.app_id = f.app_id AND fa.federation_id = f.federation_id
                   JOIN application_versions av
                     ON av.app_id = a.app_id AND av.app_version = a.current_version
                   WHERE a.app_id = %s""",
                (app_id,),
            ).fetchone()
            if not application:
                raise NotFoundError("application not found")
            federations = conn.execute(
                """SELECT app_id, federation_id, display_name, status
                   FROM federations
                   WHERE app_id = %s AND disabled_at IS NULL
                   ORDER BY federation_id""",
                (app_id,),
            ).fetchall()
            memberships = conn.execute(
                """SELECT m.federation_id, m.site_id, s.display_name,
                          m.can_submit, m.can_receive, m.can_execute_task,
                          m.app_version, m.last_seen_at, m.reported_release_id,
                          m.federation_version_reported_at
                   FROM memberships m JOIN sites s USING (site_id)
                   WHERE m.app_id = %s AND m.ended_at IS NULL
                     AND s.disabled_at IS NULL
                   ORDER BY m.federation_id, m.site_id""",
                (app_id,),
            ).fetchall()
            return {"application": application, "federations": federations, "memberships": memberships}

    def list_submissions(
        self, app_id: str, federation_id: str, limit: int
    ) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT s.submission_id, s.site_id, s.artifact_digest, s.status, s.created_at,
                          a.type_name, a.format_version, a.media_type, a.size_bytes, a.metadata,
                          at.purpose
                   FROM submissions s
                   JOIN artifacts a
                     ON a.app_id = s.app_id AND a.federation_id = s.federation_id
                    AND a.digest = s.artifact_digest
                   JOIN artifact_types at
                     ON at.app_id = a.app_id AND at.type_name = a.type_name
                    AND at.format_version = a.format_version
                   WHERE s.app_id = %s AND s.federation_id = %s
                   ORDER BY s.created_at DESC
                   LIMIT %s""",
                (app_id, federation_id, limit),
            ).fetchall()

    def list_evaluations(
        self, app_id: str, federation_id: str, limit: int
    ) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT s.submission_id, s.site_id, s.artifact_digest, s.status,
                          s.created_at, a.type_name, a.format_version, a.media_type,
                          a.size_bytes, a.metadata, at.purpose
                   FROM submissions s
                   JOIN artifacts a
                     ON a.app_id = s.app_id AND a.federation_id = s.federation_id
                    AND a.digest = s.artifact_digest
                   JOIN artifact_types at
                     ON at.app_id = a.app_id AND at.type_name = a.type_name
                    AND at.format_version = a.format_version
                   WHERE s.app_id = %s AND s.federation_id = %s
                     AND at.purpose = 'evaluation'
                   ORDER BY s.created_at DESC
                   LIMIT %s""",
                (app_id, federation_id, limit),
            ).fetchall()

    def list_sites(self, limit: int) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT s.site_id, s.display_name, s.node_version, s.last_seen_at,
                          s.created_at, count(DISTINCT m.app_id) AS application_count,
                          count(DISTINCT (m.app_id, m.federation_id)) AS membership_count,
                          count(DISTINCT c.command_id) FILTER (WHERE c.status = 'pending') AS pending_commands
                   FROM sites s
                   LEFT JOIN memberships m ON m.site_id = s.site_id AND m.ended_at IS NULL
                   LEFT JOIN commands c ON c.site_id = s.site_id AND c.status = 'pending'
                   WHERE s.disabled_at IS NULL
                   GROUP BY s.site_id
                   ORDER BY s.site_id
                   LIMIT %s""",
                (limit,),
            ).fetchall()

    def list_activity(self, limit: int, app_id: str | None = None) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT * FROM (
                     SELECT created_at, 'audit' AS source, action,
                            app_id, federation_id, site_id, target_type, target_id,
                            detail, result
                     FROM audit_log
                     UNION ALL
                     SELECT received_at AS created_at, 'event' AS source, event_type AS action,
                            app_id, federation_id, site_id, entity_type AS target_type,
                            entity_id AS target_id, payload AS detail, 'success' AS result
                     FROM events
                   ) activity
                   WHERE (%s::text IS NULL OR app_id = %s)
                   ORDER BY created_at DESC
                   LIMIT %s""",
                (app_id, app_id, limit),
            ).fetchall()

    def create_release(
        self,
        app_id: str,
        federation_id: str,
        artifact_digests: list[str],
        target_site_ids: list[str],
    ) -> dict[str, Any]:
        release_id = uuid.uuid4()
        with self.connection() as conn:
            if not conn.execute(
                """SELECT 1 FROM federations
                   WHERE app_id = %s AND federation_id = %s AND disabled_at IS NULL""",
                (app_id, federation_id),
            ).fetchone():
                raise NotFoundError("federation not found")

            found_artifacts = conn.execute(
                """SELECT a.digest FROM artifacts a
                   JOIN artifact_types at
                     ON at.app_id = a.app_id AND at.type_name = a.type_name
                    AND at.format_version = a.format_version
                   WHERE a.app_id = %s AND a.federation_id = %s
                     AND a.digest = ANY(%s) AND at.purpose = 'release'""",
                (app_id, federation_id, artifact_digests),
            ).fetchall()
            if {row["digest"] for row in found_artifacts} != set(artifact_digests):
                raise NotFoundError("one or more release artifacts were not found in this federation")

            params: list[Any] = [app_id, federation_id]
            target_filter = ""
            if target_site_ids:
                target_filter = " AND site_id = ANY(%s)"
                params.append(target_site_ids)
            targets = conn.execute(
                f"""SELECT site_id FROM memberships
                    WHERE app_id = %s AND federation_id = %s
                      AND ended_at IS NULL AND can_receive = true{target_filter}
                    ORDER BY site_id""",
                params,
            ).fetchall()
            target_ids = [row["site_id"] for row in targets]
            if target_site_ids and set(target_ids) != set(target_site_ids):
                raise ForbiddenError("every target site must have receive permission")
            if not target_ids:
                raise ConflictError("the federation has no receiving sites")

            release = conn.execute(
                """INSERT INTO releases
                   (release_id, app_id, federation_id, created_by)
                   VALUES (%s, %s, %s, 'admin')
                   RETURNING release_id, app_id, federation_id, created_by, created_at""",
                (release_id, app_id, federation_id),
            ).fetchone()
            with conn.cursor() as cursor:
                cursor.executemany(
                    """INSERT INTO release_artifacts
                       (release_id, app_id, federation_id, artifact_digest)
                       VALUES (%s, %s, %s, %s)""",
                    [(release_id, app_id, federation_id, digest) for digest in artifact_digests],
                )
                cursor.executemany(
                    """INSERT INTO deliveries
                       (delivery_id, release_id, app_id, federation_id, site_id)
                       VALUES (%s, %s, %s, %s, %s)""",
                    [
                        (uuid.uuid4(), release_id, app_id, federation_id, site_id)
                        for site_id in target_ids
                    ],
                )
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'release.created', %s, %s,
                           'release', %s, %s)""",
                (
                    app_id,
                    federation_id,
                    str(release_id),
                    Jsonb({"artifact_digests": artifact_digests, "site_ids": target_ids}),
                ),
            )
            return {**release, "artifact_digests": artifact_digests, "site_ids": target_ids}

    def next_unreleased_release_artifact(
        self, app_id: str, federation_id: str
    ) -> str:
        with self.connection() as conn:
            artifact = conn.execute(
                """SELECT a.digest
                   FROM artifacts a
                   JOIN artifact_types at
                     ON at.app_id = a.app_id AND at.type_name = a.type_name
                    AND at.format_version = a.format_version
                   WHERE a.app_id = %s AND a.federation_id = %s
                     AND at.purpose = 'release'
                     AND NOT EXISTS (
                       SELECT 1 FROM release_artifacts ra
                       WHERE ra.app_id = a.app_id
                         AND ra.federation_id = a.federation_id
                         AND ra.artifact_digest = a.digest
                     )
                   ORDER BY a.created_at DESC
                   LIMIT 1""",
                (app_id, federation_id),
            ).fetchone()
            if not artifact:
                raise ConflictError("the federation agent has not produced a new result")
            return artifact["digest"]

    def list_releases(
        self, app_id: str, federation_id: str, limit: int
    ) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT r.release_id, r.created_by, r.created_at,
                          array_agg(DISTINCT ra.artifact_digest) AS artifact_digests,
                          max(a.metadata ->> 'round_id') AS version_label,
                          max(a.metadata ->> 'algorithm_id') AS algorithm_id,
                          count(DISTINCT d.delivery_id) AS delivery_count,
                          count(DISTINCT d.delivery_id) FILTER (WHERE d.state = 'pending') AS pending,
                          count(DISTINCT d.delivery_id) FILTER (WHERE d.state = 'staged') AS staged,
                          count(DISTINCT d.delivery_id) FILTER (WHERE d.state = 'active') AS active,
                          count(DISTINCT d.delivery_id) FILTER (WHERE d.state = 'failed') AS failed,
                          count(DISTINCT d.delivery_id) FILTER (WHERE d.state = 'rolled_back') AS rolled_back,
                          jsonb_agg(DISTINCT jsonb_build_object(
                            'delivery_id', d.delivery_id,
                            'site_id', d.site_id,
                            'state', d.state,
                            'failed_action', d.failed_action,
                            'last_error', d.last_error,
                            'updated_at', d.updated_at
                          )) AS deliveries
                   FROM releases r
                   JOIN release_artifacts ra USING (release_id)
                   JOIN artifacts a
                     ON a.app_id = ra.app_id AND a.federation_id = ra.federation_id
                    AND a.digest = ra.artifact_digest
                   JOIN deliveries d USING (release_id)
                   WHERE r.app_id = %s AND r.federation_id = %s
                   GROUP BY r.release_id
                   ORDER BY r.created_at DESC
                   LIMIT %s""",
                (app_id, federation_id, limit),
            ).fetchall()

    def release_detail(
        self, app_id: str, federation_id: str, release_id: uuid.UUID
    ) -> dict[str, Any]:
        with self.connection() as conn:
            release = conn.execute(
                """SELECT release_id, app_id, federation_id, created_by, created_at
                   FROM releases
                   WHERE app_id = %s AND federation_id = %s AND release_id = %s""",
                (app_id, federation_id, release_id),
            ).fetchone()
            if not release:
                raise NotFoundError("release not found")
            artifacts = conn.execute(
                """SELECT a.digest, a.type_name, a.format_version, a.media_type,
                          a.size_bytes, a.metadata
                   FROM release_artifacts ra
                   JOIN artifacts a
                     ON a.app_id = ra.app_id AND a.federation_id = ra.federation_id
                    AND a.digest = ra.artifact_digest
                   WHERE ra.release_id = %s ORDER BY a.digest""",
                (release_id,),
            ).fetchall()
            deliveries = conn.execute(
                """SELECT delivery_id, site_id, state, failed_action, last_error,
                          updated_at, created_at
                   FROM deliveries WHERE release_id = %s ORDER BY site_id""",
                (release_id,),
            ).fetchall()
            return {**release, "artifacts": artifacts, "deliveries": deliveries}

    def create_delivery_commands(
        self,
        app_id: str,
        federation_id: str,
        release_id: uuid.UUID,
        action: str,
        site_ids: list[str],
    ) -> list[dict[str, Any]]:
        allowed_state = {"stage": "pending", "activate": "staged", "rollback": "active"}[action]
        command_type = f"release.{action}"
        with self.connection() as conn:
            if not conn.execute(
                """SELECT 1 FROM releases
                   WHERE app_id = %s AND federation_id = %s AND release_id = %s""",
                (app_id, federation_id, release_id),
            ).fetchone():
                raise NotFoundError("release not found")
            params: list[Any] = [release_id]
            target_filter = ""
            if site_ids:
                target_filter = " AND site_id = ANY(%s)"
                params.append(site_ids)
            deliveries = conn.execute(
                f"""SELECT delivery_id, site_id, state, failed_action
                    FROM deliveries WHERE release_id = %s{target_filter}
                    ORDER BY site_id FOR UPDATE""",
                params,
            ).fetchall()
            if site_ids and {row["site_id"] for row in deliveries} != set(site_ids):
                raise NotFoundError("one or more target deliveries were not found")
            if not deliveries:
                raise NotFoundError("no target deliveries found")

            commands = []
            for delivery in deliveries:
                retrying = (
                    delivery["state"] == "failed" and delivery["failed_action"] == action
                )
                if delivery["state"] != allowed_state and not retrying:
                    raise ConflictError(
                        f"site {delivery['site_id']} cannot {action} from {delivery['state']}"
                    )
                pending = conn.execute(
                    """SELECT command_id, command_cursor, site_id, command_type, attempt, status,
                              created_at
                       FROM commands
                       WHERE delivery_id = %s AND command_type = %s AND status = 'pending'""",
                    (delivery["delivery_id"], command_type),
                ).fetchone()
                if pending:
                    commands.append(pending)
                    continue
                attempt = conn.execute(
                    """SELECT coalesce(max(attempt), 0) + 1 AS attempt FROM commands
                       WHERE delivery_id = %s AND command_type = %s""",
                    (delivery["delivery_id"], command_type),
                ).fetchone()["attempt"]
                command = conn.execute(
                    """INSERT INTO commands
                       (command_id, delivery_id, app_id, federation_id, site_id,
                        command_type, attempt, payload)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                       RETURNING command_id, command_cursor, site_id, command_type,
                                 attempt, status, created_at""",
                    (
                        uuid.uuid4(),
                        delivery["delivery_id"],
                        app_id,
                        federation_id,
                        delivery["site_id"],
                        command_type,
                        attempt,
                        Jsonb({"release_id": str(release_id)}),
                    ),
                ).fetchone()
                commands.append(command)
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', %s, %s, %s, 'release', %s, %s)""",
                (
                    f"release.{action}.requested",
                    app_id,
                    federation_id,
                    str(release_id),
                    Jsonb({"site_ids": [row["site_id"] for row in deliveries]}),
                ),
            )
            return commands

    def site_commands(
        self, app_id: str, site_id: str, after: int, limit: int
    ) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT command_id, command_cursor, app_id, federation_id,
                          command_type, attempt, payload, created_at
                   FROM commands
                   WHERE app_id = %s AND site_id = %s
                     AND command_cursor > %s AND status = 'pending'
                   ORDER BY command_cursor LIMIT %s""",
                (app_id, site_id, after, limit),
            ).fetchall()

    def command_artifacts(self, command_id: uuid.UUID) -> list[dict[str, Any]]:
        with self.connection() as conn:
            return conn.execute(
                """SELECT a.digest, a.type_name, a.format_version, a.media_type,
                          a.size_bytes, a.metadata, a.storage_key
                   FROM commands c
                   JOIN deliveries d USING (delivery_id)
                   JOIN release_artifacts ra ON ra.release_id = d.release_id
                   JOIN artifacts a
                     ON a.app_id = ra.app_id AND a.federation_id = ra.federation_id
                    AND a.digest = ra.artifact_digest
                   WHERE c.command_id = %s ORDER BY a.digest""",
                (command_id,),
            ).fetchall()

    def acknowledge_command(
        self,
        app_id: str,
        site_id: str,
        command_id: uuid.UUID,
        result: str,
        error: str | None,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            command = conn.execute(
                """SELECT command_id, delivery_id, app_id, federation_id, command_type, status
                   FROM commands
                   WHERE command_id = %s AND app_id = %s AND site_id = %s FOR UPDATE""",
                (command_id, app_id, site_id),
            ).fetchone()
            if not command:
                raise NotFoundError("command not found")
            delivery = conn.execute(
                """SELECT delivery_id, state FROM deliveries
                   WHERE delivery_id = %s FOR UPDATE""",
                (command["delivery_id"],),
            ).fetchone()
            if command["status"] != "pending":
                return {"command_id": command_id, "delivery_state": delivery["state"]}

            action = command["command_type"].removeprefix("release.")
            if result == "failed":
                state = "failed"
                command_status = "failed"
                failed_action = action
            else:
                state = {"stage": "staged", "activate": "active", "rollback": "rolled_back"}[action]
                command_status = "acked"
                failed_action = None
            conn.execute(
                """UPDATE commands SET status = %s, error = %s, acknowledged_at = now()
                   WHERE command_id = %s""",
                (command_status, error, command_id),
            )
            conn.execute(
                """UPDATE deliveries
                   SET state = %s, failed_action = %s, last_error = %s, updated_at = now()
                   WHERE delivery_id = %s""",
                (state, failed_action, error, command["delivery_id"]),
            )
            conn.execute(
                """INSERT INTO events
                   (event_id, app_id, federation_id, site_id, event_type,
                    entity_type, entity_id, payload, occurred_at)
                   VALUES (%s, %s, %s, %s, %s, 'delivery', %s, %s, now())""",
                (
                    uuid.uuid4(),
                    command["app_id"],
                    command["federation_id"],
                    site_id,
                    f"delivery.{state}",
                    str(command["delivery_id"]),
                    Jsonb({"command_id": str(command_id), "error": error}),
                ),
            )
            return {"command_id": command_id, "delivery_state": state}

    def claim_agent_job(
        self,
        worker_id: str,
        algorithm_plugin_ids: list[str] | None = None,
        *,
        process_agent_events: bool = True,
    ) -> dict[str, Any] | None:
        algorithm_plugin_ids = algorithm_plugin_ids or []
        with self.connection() as conn:
            job = conn.execute(
                """WITH picked AS (
                     SELECT j.job_id FROM agent_jobs j
                     JOIN federation_agents fa
                       ON fa.app_id = j.app_id AND fa.federation_id = j.federation_id
                     WHERE j.status IN ('pending', 'retry') AND j.available_at <= now()
                       AND (
                         (j.kind <> 'generation.requested' AND %s)
                         OR (
                           j.kind = 'generation.requested'
                           AND fa.algorithm_plugin_id = ANY(%s::text[])
                         )
                       )
                       AND (j.leased_until IS NULL OR j.leased_until < now())
                       AND NOT EXISTS (
                         SELECT 1 FROM agent_jobs active
                         WHERE active.app_id = j.app_id
                           AND active.federation_id = j.federation_id
                           AND active.status = 'running'
                           AND active.leased_until > now()
                       )
                     ORDER BY j.available_at, j.created_at
                     FOR UPDATE OF j, fa SKIP LOCKED LIMIT 1
                   ), claimed AS (
                     UPDATE agent_jobs j
                     SET status = 'running', attempts = attempts + 1, leased_by = %s,
                         leased_until = now() + interval '15 minutes', updated_at = now()
                     FROM picked WHERE j.job_id = picked.job_id
                     RETURNING j.*
                   )
                   SELECT claimed.*, fa.core_plugin_id, fa.core_plugin_version,
                          fa.config, fa.revision AS config_revision,
                          fa.state, fa.state_revision, fa.algorithm_plugin_id,
                          fa.algorithm_plugin_version, fa.algorithm_config,
                          fa.algorithm_state, fa.algorithm_state_revision
                   FROM claimed JOIN federation_agents fa
                     ON fa.app_id = claimed.app_id
                    AND fa.federation_id = claimed.federation_id""",
                (process_agent_events, algorithm_plugin_ids, worker_id),
            ).fetchone()
            if job:
                conn.execute(
                    """UPDATE federation_agents SET status = 'running', updated_at = now()
                       WHERE app_id = %s AND federation_id = %s""",
                    (job["app_id"], job["federation_id"]),
                )
            return job

    def finish_agent_job(
        self,
        job_id: uuid.UUID,
        app_id: str,
        federation_id: str,
        error: str | None = None,
        *,
        result: dict[str, Any] | None = None,
        new_state: dict[str, Any] | None = None,
        new_algorithm_state: dict[str, Any] | None = None,
        expected_config_revision: int | None = None,
        expected_state_revision: int | None = None,
        expected_algorithm_state_revision: int | None = None,
    ) -> None:
        with self.connection() as conn:
            if error:
                failed = conn.execute(
                    """UPDATE agent_jobs
                       SET status = CASE WHEN attempts < 3 THEN 'retry' ELSE 'failed' END,
                           available_at = CASE WHEN attempts < 3
                             THEN now() + interval '15 seconds' ELSE available_at END,
                           last_error = %s, leased_by = NULL, leased_until = NULL,
                           updated_at = now()
                       WHERE job_id = %s RETURNING status""",
                    (error, job_id),
                ).fetchone()
                agent_status = "failed" if failed and failed["status"] == "failed" else "idle"
            else:
                conn.execute(
                    """UPDATE agent_jobs SET status = 'succeeded', result = %s,
                              leased_by = NULL, leased_until = NULL, last_error = NULL,
                              updated_at = now()
                       WHERE job_id = %s""",
                    (Jsonb(result) if result is not None else None, job_id),
                )
                if new_state is not None:
                    updated = conn.execute(
                        """UPDATE federation_agents
                           SET state = %s, state_revision = state_revision + 1, updated_at = now()
                           WHERE app_id = %s AND federation_id = %s
                             AND (%s::bigint IS NULL OR revision = %s)
                             AND (%s::bigint IS NULL OR state_revision = %s)
                           RETURNING state_revision""",
                        (
                            Jsonb(new_state),
                            app_id,
                            federation_id,
                            expected_config_revision,
                            expected_config_revision,
                            expected_state_revision,
                            expected_state_revision,
                        ),
                    ).fetchone()
                    if not updated:
                        raise ConflictError("agent configuration or state revision changed")
                if new_algorithm_state is not None:
                    updated = conn.execute(
                        """UPDATE federation_agents
                           SET algorithm_state = %s,
                               algorithm_state_revision = algorithm_state_revision + 1,
                               updated_at = now()
                           WHERE app_id = %s AND federation_id = %s
                             AND (%s::bigint IS NULL OR revision = %s)
                             AND (%s::bigint IS NULL OR algorithm_state_revision = %s)
                           RETURNING algorithm_state_revision""",
                        (
                            Jsonb(new_algorithm_state),
                            app_id,
                            federation_id,
                            expected_config_revision,
                            expected_config_revision,
                            expected_algorithm_state_revision,
                            expected_algorithm_state_revision,
                        ),
                    ).fetchone()
                    if not updated:
                        raise ConflictError("algorithm configuration or state revision changed")
                if result is not None:
                    conn.execute(
                        """INSERT INTO audit_log
                           (actor_type, actor_id, action, app_id, federation_id,
                            target_type, target_id, detail)
                           VALUES ('agent', %s, 'agent.job.completed', %s, %s,
                                   'agent_job', %s, %s)""",
                        (
                            f"{app_id}/{federation_id}",
                            app_id,
                            federation_id,
                            str(job_id),
                            Jsonb(
                                {
                                    "intents": [item["kind"] for item in result.get("intents", [])],
                                    "core_plugin_id": result.get("core_plugin_id"),
                                }
                            ),
                        ),
                    )
                agent_status = "idle"
            conn.execute(
                """UPDATE federation_agents SET status = %s, updated_at = now()
                   WHERE app_id = %s AND federation_id = %s""",
                (agent_status, app_id, federation_id),
            )
