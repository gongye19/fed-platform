from __future__ import annotations

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

    def register_application(self, manifest: dict[str, Any], manifest_digest: str) -> bool:
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
                """INSERT INTO app_agents (app_id, core_plugin_id)
                   VALUES (%s, 'manual-channel')
                   ON CONFLICT (app_id) DO NOTHING""",
                (app_id,),
            )

            for item in manifest["artifact_types"]:
                row = conn.execute(
                    """INSERT INTO artifact_types
                       (app_id, type_name, format_version, media_type, schema_digest, metadata_schema)
                       VALUES (%s, %s, %s, %s, %s, %s)
                       ON CONFLICT (app_id, type_name, format_version) DO NOTHING
                       RETURNING type_name""",
                    (
                        app_id,
                        item["type"],
                        item["format_version"],
                        item["media_type"],
                        item["schema_digest"],
                        Jsonb(item["metadata_schema"]),
                    ),
                ).fetchone()
                if not row:
                    current = conn.execute(
                        """SELECT media_type, schema_digest FROM artifact_types
                           WHERE app_id = %s AND type_name = %s AND format_version = %s""",
                        (app_id, item["type"], item["format_version"]),
                    ).fetchone()
                    if current != {
                        "media_type": item["media_type"],
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
                          aa.status AS agent_status, aa.core_plugin_id,
                          count(DISTINCT f.federation_id) AS federation_count,
                          count(DISTINCT m.site_id) AS site_count
                   FROM applications a
                   JOIN app_agents aa USING (app_id)
                   LEFT JOIN federations f ON f.app_id = a.app_id AND f.disabled_at IS NULL
                   LEFT JOIN memberships m
                     ON m.app_id = f.app_id AND m.federation_id = f.federation_id
                    AND m.ended_at IS NULL
                   WHERE (%s::text IS NULL OR a.app_id > %s)
                   GROUP BY a.app_id, aa.status, aa.core_plugin_id
                   ORDER BY a.app_id
                   LIMIT %s""",
                (after, after, limit),
            ).fetchall()

    def register_site(self, site_id: str, display_name: str, token_prefix: str, key_hash: str) -> None:
        with self.connection() as conn:
            created = conn.execute(
                """INSERT INTO sites (site_id, display_name)
                   VALUES (%s, %s)
                   ON CONFLICT (site_id) DO NOTHING
                   RETURNING site_id""",
                (site_id, display_name),
            ).fetchone()
            if not created:
                raise ConflictError("site_id is already registered")
            conn.execute(
                """INSERT INTO site_credentials
                   (credential_id, site_id, token_prefix, key_hash)
                   VALUES (%s, %s, %s, %s)""",
                (uuid.uuid4(), site_id, token_prefix, key_hash),
            )
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, site_id, target_type, target_id)
                   VALUES ('admin', 'admin', 'site.registered', %s, 'site', %s)""",
                (site_id, site_id),
            )

    def authenticate_site(self, key_hash: str) -> str:
        with self.connection() as conn:
            row = conn.execute(
                """SELECT s.site_id
                   FROM site_credentials c
                   JOIN sites s USING (site_id)
                   WHERE c.key_hash = %s
                     AND c.revoked_at IS NULL
                     AND (c.expires_at IS NULL OR c.expires_at > now())
                     AND s.disabled_at IS NULL""",
                (key_hash,),
            ).fetchone()
            if not row:
                raise ForbiddenError("invalid site credential")
            conn.execute("UPDATE sites SET last_seen_at = now() WHERE site_id = %s", (row["site_id"],))
            return row["site_id"]

    def create_federation(self, app_id: str, federation_id: str, display_name: str) -> bool:
        with self.connection() as conn:
            if not conn.execute("SELECT 1 FROM applications WHERE app_id = %s", (app_id,)).fetchone():
                raise NotFoundError("application not found")
            row = conn.execute(
                """INSERT INTO federations (app_id, federation_id, display_name)
                   VALUES (%s, %s, %s)
                   ON CONFLICT (app_id, federation_id) DO NOTHING
                   RETURNING federation_id""",
                (app_id, federation_id, display_name),
            ).fetchone()
            if not row:
                current = conn.execute(
                    """SELECT display_name FROM federations
                       WHERE app_id = %s AND federation_id = %s""",
                    (app_id, federation_id),
                ).fetchone()
                if current["display_name"] != display_name:
                    raise ConflictError("federation_id is already registered with another name")
                return False
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id, target_type, target_id)
                   VALUES ('admin', 'admin', 'federation.created', %s, %s, 'federation', %s)""",
                (app_id, federation_id, federation_id),
            )
            return True

    def put_membership(
        self,
        app_id: str,
        federation_id: str,
        site_id: str,
        permissions: dict[str, bool],
    ) -> None:
        with self.connection() as conn:
            if not conn.execute(
                "SELECT 1 FROM federations WHERE app_id = %s AND federation_id = %s AND disabled_at IS NULL",
                (app_id, federation_id),
            ).fetchone():
                raise NotFoundError("federation not found")
            if not conn.execute(
                "SELECT 1 FROM sites WHERE site_id = %s AND disabled_at IS NULL", (site_id,)
            ).fetchone():
                raise NotFoundError("site not found")
            conn.execute(
                """INSERT INTO memberships
                   (app_id, federation_id, site_id, can_submit, can_receive, can_execute_task)
                   VALUES (%s, %s, %s, %s, %s, %s)
                   ON CONFLICT (app_id, federation_id, site_id) DO UPDATE
                   SET can_submit = EXCLUDED.can_submit,
                       can_receive = EXCLUDED.can_receive,
                       can_execute_task = EXCLUDED.can_execute_task,
                       ended_at = NULL""",
                (
                    app_id,
                    federation_id,
                    site_id,
                    permissions["can_submit"],
                    permissions["can_receive"],
                    permissions["can_execute_task"],
                ),
            )
            conn.execute(
                """INSERT INTO audit_log
                   (actor_type, actor_id, action, app_id, federation_id, site_id,
                    target_type, target_id, detail)
                   VALUES ('admin', 'admin', 'membership.updated', %s, %s, %s,
                           'membership', %s, %s)""",
                (app_id, federation_id, site_id, site_id, Jsonb(permissions)),
            )

    def submission_policy(
        self,
        app_id: str,
        federation_id: str,
        site_id: str,
        type_name: str,
        format_version: int,
    ) -> dict[str, Any]:
        with self.connection() as conn:
            membership = conn.execute(
                """SELECT can_submit FROM memberships
                   WHERE app_id = %s AND federation_id = %s AND site_id = %s
                     AND ended_at IS NULL""",
                (app_id, federation_id, site_id),
            ).fetchone()
            if not membership or not membership["can_submit"]:
                raise ForbiddenError("site cannot submit to this federation")
            artifact_type = conn.execute(
                """SELECT media_type, schema_digest, metadata_schema
                   FROM artifact_types
                   WHERE app_id = %s AND type_name = %s AND format_version = %s""",
                (app_id, type_name, format_version),
            ).fetchone()
            if not artifact_type:
                raise NotFoundError("artifact type not registered")
            return artifact_type

    def create_submission(
        self,
        *,
        app_id: str,
        federation_id: str,
        site_id: str,
        descriptor: dict[str, Any],
        storage_key: str,
        idempotency_key: str,
    ) -> tuple[dict[str, Any], bool]:
        with self.connection() as conn:
            membership = conn.execute(
                """SELECT can_submit FROM memberships
                   WHERE app_id = %s AND federation_id = %s AND site_id = %s
                     AND ended_at IS NULL
                   FOR SHARE""",
                (app_id, federation_id, site_id),
            ).fetchone()
            if not membership or not membership["can_submit"]:
                raise ForbiddenError("site cannot submit to this federation")

            inserted_artifact = conn.execute(
                """INSERT INTO artifacts
                   (app_id, federation_id, digest, type_name, format_version,
                    media_type, size_bytes, metadata, storage_key)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (app_id, federation_id, digest) DO NOTHING
                   RETURNING digest""",
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
            if not inserted_artifact:
                existing = conn.execute(
                    """SELECT type_name, format_version, media_type, size_bytes, metadata
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
                if existing != expected:
                    raise ConflictError("artifact digest already has another descriptor")

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

            conn.execute(
                """INSERT INTO events
                   (event_id, app_id, federation_id, site_id, event_type,
                    entity_type, entity_id, payload, occurred_at)
                   VALUES (%s, %s, %s, %s, 'submission.accepted',
                           'submission', %s, %s, now())""",
                (
                    uuid.uuid4(), app_id, federation_id, site_id, str(submission_id),
                    Jsonb({"artifact_digest": descriptor["digest"]}),
                ),
            )
            conn.execute(
                """INSERT INTO agent_jobs
                   (job_id, app_id, federation_id, kind, dedupe_key, payload)
                   VALUES (%s, %s, %s, 'submission.accepted', %s, %s)""",
                (
                    uuid.uuid4(), app_id, federation_id, str(submission_id),
                    Jsonb({"submission_id": str(submission_id)}),
                ),
            )
            return submission, True

    def topology(self, app_id: str) -> dict[str, Any]:
        with self.connection() as conn:
            application = conn.execute(
                """SELECT a.app_id, a.display_name, a.current_version, a.status,
                          aa.status AS agent_status, aa.core_plugin_id
                   FROM applications a JOIN app_agents aa USING (app_id)
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
                          m.can_submit, m.can_receive, m.can_execute_task, s.last_seen_at
                   FROM memberships m JOIN sites s USING (site_id)
                   WHERE m.app_id = %s AND m.ended_at IS NULL
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
                          a.type_name, a.format_version, a.media_type, a.size_bytes, a.metadata
                   FROM submissions s
                   JOIN artifacts a
                     ON a.app_id = s.app_id AND a.federation_id = s.federation_id
                    AND a.digest = s.artifact_digest
                   WHERE s.app_id = %s AND s.federation_id = %s
                   ORDER BY s.created_at DESC
                   LIMIT %s""",
                (app_id, federation_id, limit),
            ).fetchall()
