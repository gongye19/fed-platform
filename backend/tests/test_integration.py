from __future__ import annotations

import hashlib
import json
import os
import uuid
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql

from fedplat.app import app, get_artifact_store, get_database
from fedplat.artifact_store import S3ArtifactStore
from fedplat.migrate import migrate
from fedplat.settings import Settings, get_settings
from fedplat.store import Database


ADMIN_TOKEN = "integration-admin-token-32-characters"


def _database_url(base_url: str, database: str) -> str:
    parsed = urlsplit(base_url)
    return urlunsplit(parsed._replace(path=f"/{database}"))


@pytest.fixture
def live_stack():
    required = [
        "FEDPLAT_TEST_DATABASE_URL",
        "FEDPLAT_S3_ENDPOINT",
        "FEDPLAT_S3_BUCKET",
        "FEDPLAT_S3_ACCESS_KEY_ID",
        "FEDPLAT_S3_SECRET_ACCESS_KEY",
    ]
    if any(not os.environ.get(name) for name in required):
        pytest.skip("live PostgreSQL/S3 integration environment is not configured")

    base_url = os.environ["FEDPLAT_TEST_DATABASE_URL"]
    database_name = "fedplat_test_" + uuid.uuid4().hex
    with psycopg.connect(base_url, autocommit=True) as conn:
        conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))

    test_url = _database_url(base_url, database_name)
    migrate(test_url)
    settings = Settings(
        database_url=test_url,
        admin_token=ADMIN_TOKEN,
        s3_endpoint=os.environ["FEDPLAT_S3_ENDPOINT"],
        s3_bucket=os.environ["FEDPLAT_S3_BUCKET"],
        s3_region=os.environ.get("FEDPLAT_S3_REGION", "auto"),
        s3_access_key_id=os.environ["FEDPLAT_S3_ACCESS_KEY_ID"],
        s3_secret_access_key=os.environ["FEDPLAT_S3_SECRET_ACCESS_KEY"],
        s3_url_style=os.environ.get("FEDPLAT_S3_URL_STYLE", "virtual"),
        max_artifact_bytes=1024 * 1024,
    )
    database = Database(test_url)
    artifacts = S3ArtifactStore(settings)
    app.dependency_overrides[get_settings] = lambda: settings
    app.dependency_overrides[get_database] = lambda: database
    app.dependency_overrides[get_artifact_store] = lambda: artifacts
    app.state.max_artifact_bytes = settings.max_artifact_bytes

    with TestClient(app) as client:
        yield client, database, artifacts

    with database.connection() as conn:
        keys = [row["storage_key"] for row in conn.execute("SELECT storage_key FROM artifacts").fetchall()]
    for key in keys:
        artifacts.delete(key)
    app.dependency_overrides.clear()
    del app.state.max_artifact_bytes
    with psycopg.connect(base_url, autocommit=True) as conn:
        conn.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = %s",
            (database_name,),
        )
        conn.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(database_name)))


def test_registry_and_artifact_submission(live_stack):
    client, database, _ = live_stack
    suffix = uuid.uuid4().hex[:10]
    app_id = f"test.app.{suffix}"
    site_id = f"site-{suffix}"
    admin = {"Authorization": f"Bearer {ADMIN_TOKEN}"}
    metadata_schema = {
        "type": "object",
        "properties": {"kind": {"type": "string"}},
        "required": ["kind"],
        "additionalProperties": False,
    }
    manifest = {
        "schema_version": "fedapp/v1",
        "app_id": app_id,
        "app_version": "1.0.0",
        "display_name": "Integration App",
        "adapter_protocol": ">=1.0 <2.0",
        "artifact_types": [
            {
                "type": "test.observation",
                "format_version": 1,
                "media_type": "application/json",
                "purpose": "evaluation",
                "metadata_schema": metadata_schema,
            },
            {
                "type": "test.release",
                "format_version": 1,
                "media_type": "application/json",
                "purpose": "release",
                "metadata_schema": metadata_schema,
            }
        ],
    }

    assert client.post("/admin/v1/apps", json=manifest).status_code == 401
    first_app = client.post("/admin/v1/apps", json=manifest, headers=admin)
    assert first_app.status_code == 201 and first_app.json()["created"] is True
    repeated_app = client.post("/admin/v1/apps", json=manifest, headers=admin)
    assert repeated_app.status_code == 200 and repeated_app.json()["created"] is False

    legacy_manifest = {**manifest, "app_id": f"{app_id}.legacy"}
    assert client.post("/admin/v1/apps", json=legacy_manifest, headers=admin).status_code == 201
    with database.connection() as conn:
        conn.execute(
            "INSERT INTO federations (app_id, federation_id, display_name) VALUES (%s, 'custom', 'Custom')",
            (legacy_manifest["app_id"],),
        )
        conn.execute(
            "UPDATE federation_agents SET federation_id = 'custom' WHERE app_id = %s",
            (legacy_manifest["app_id"],),
        )
        conn.execute(
            "DELETE FROM federations WHERE app_id = %s AND federation_id = 'default'",
            (legacy_manifest["app_id"],),
        )
    legacy_v2 = {**legacy_manifest, "app_version": "2.0.0"}
    assert client.post("/admin/v1/apps", json=legacy_v2, headers=admin).status_code == 201
    assert client.get(
        f"/admin/v1/apps/{legacy_manifest['app_id']}/federations/custom/agent", headers=admin
    ).status_code == 200

    apps = client.get("/admin/v1/apps", headers=admin)
    assert apps.status_code == 200 and {item["app_id"] for item in apps.json()["items"]} >= {
        app_id,
        legacy_manifest["app_id"],
    }
    agent = client.get(
        f"/admin/v1/apps/{app_id}/federations/default/agent", headers=admin
    )
    assert agent.status_code == 200 and agent.json()["core_plugin_id"] == "manual"
    configured = client.put(
        f"/admin/v1/apps/{app_id}/federations/default/agent",
        json={"core_plugin_id": "deepseek-harness", "config": {}, "expected_revision": 1},
        headers=admin,
    )
    assert configured.status_code == 200 and configured.json()["revision"] == 2
    stale = client.put(
        f"/admin/v1/apps/{app_id}/federations/default/agent",
        json={"core_plugin_id": "deepseek-harness", "config": {}, "expected_revision": 1},
        headers=admin,
    )
    assert stale.status_code == 409
    configured = client.put(
        f"/admin/v1/apps/{app_id}/federations/default/agent",
        json={"core_plugin_id": "manual", "config": {}, "expected_revision": 2},
        headers=admin,
    )
    assert configured.status_code == 200 and configured.json()["revision"] == 3

    topology = client.get(f"/admin/v1/apps/{app_id}/topology", headers=admin)
    assert topology.status_code == 200
    assert topology.json()["federations"][0]["federation_id"] == "default"
    assert topology.json()["memberships"] == []

    site = client.post(
        f"/admin/v1/apps/{app_id}/site-keys",
        json={"site_id": site_id, "display_name": "Integration Site"},
        headers=admin,
    )
    assert site.status_code == 201
    site_auth = {"Authorization": f"Bearer {site.json()['api_key']}"}
    assert client.get("/admin/v1/sites", headers=admin).json()["items"] == []

    other_manifest = {**manifest, "app_id": f"{app_id}.other"}
    assert client.post("/admin/v1/apps", json=other_manifest, headers=admin).status_code == 201

    content = b'{"text":"hello federation"}'
    digest = "sha256:" + hashlib.sha256(content).hexdigest()
    descriptor = {
        "digest": digest,
        "type": "test.observation",
        "format_version": 1,
        "media_type": "application/json",
        "size_bytes": len(content),
        "metadata": {"kind": "demo"},
    }

    cross_app = client.post(
        f"/site/v1/apps/{other_manifest['app_id']}/artifacts",
        data={"descriptor": json.dumps(descriptor)},
        files={"content": ("artifact.json", content, "application/json")},
        headers={
            **site_auth,
            "Idempotency-Key": "wrong-app",
            "X-App-Version": "1.0.0",
        },
    )
    assert cross_app.status_code == 401

    unregistered_version = client.post(
        f"/site/v1/apps/{app_id}/artifacts",
        data={"descriptor": json.dumps(descriptor)},
        files={"content": ("artifact.json", content, "application/json")},
        headers={
            **site_auth,
            "Idempotency-Key": "bad-version",
            "X-App-Version": "9.9.9",
        },
    )
    assert unregistered_version.status_code == 409
    assert client.get("/admin/v1/sites", headers=admin).json()["items"] == []

    def upload(idempotency_key: str):
        return client.post(
            f"/site/v1/apps/{app_id}/artifacts",
            data={"descriptor": json.dumps(descriptor)},
            files={"content": ("artifact.json", content, "application/json")},
            headers={
                **site_auth,
                "Idempotency-Key": idempotency_key,
                "X-App-Version": "1.0.0",
            },
        )

    submitted = upload("submission-1")
    assert submitted.status_code == 201 and submitted.json()["created"] is True
    repeated = upload("submission-1")
    assert repeated.status_code == 200 and repeated.json()["created"] is False
    assert repeated.json()["submission_id"] == submitted.json()["submission_id"]

    topology = client.get(f"/admin/v1/apps/{app_id}/topology", headers=admin)
    assert topology.status_code == 200
    assert topology.json()["memberships"][0]["site_id"] == site_id
    assert topology.json()["memberships"][0]["app_version"] == "1.0.0"
    assert topology.json()["memberships"][0]["last_seen_at"]
    assert topology.json()["memberships"][0]["reported_release_id"] is None
    assert topology.json()["memberships"][0]["federation_version_reported_at"]

    submissions = client.get(
        f"/admin/v1/apps/{app_id}/federations/default/submissions", headers=admin
    )
    assert len(submissions.json()["items"]) == 1
    assert submissions.json()["items"][0]["purpose"] == "evaluation"
    evaluations = client.get(
        f"/admin/v1/apps/{app_id}/federations/default/evaluations", headers=admin
    )
    assert len(evaluations.json()["items"]) == 1
    assert evaluations.json()["items"][0]["metadata"] == {"kind": "demo"}

    release_content = b'{"entries":[]}'
    release_digest = "sha256:" + hashlib.sha256(release_content).hexdigest()
    release_descriptor = {
        "digest": release_digest,
        "type": "test.release",
        "format_version": 1,
        "media_type": "application/json",
        "size_bytes": len(release_content),
        "metadata": {"kind": "demo"},
    }
    imported = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/artifacts",
        data={"descriptor": json.dumps(release_descriptor)},
        files={"content": ("release.json", release_content, "application/json")},
        headers=admin,
    )
    assert imported.status_code == 201 and imported.json()["created"] is True
    repeated_import = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/artifacts",
        data={"descriptor": json.dumps(release_descriptor)},
        files={"content": ("release.json", release_content, "application/json")},
        headers=admin,
    )
    assert repeated_import.status_code == 200 and repeated_import.json()["created"] is False
    artifact = client.get(
        f"/admin/v1/apps/{app_id}/federations/default/artifacts/{release_digest}",
        headers=admin,
    )
    assert artifact.status_code == 200
    assert artifact.json()["download_url"].startswith("http")

    release = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/generate",
        headers=admin,
    )
    assert release.status_code == 201
    release_id = release.json()["release_id"]
    assert client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/generate",
        headers=admin,
    ).status_code == 409
    stage = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/{release_id}/stage",
        json={},
        headers=admin,
    )
    assert stage.status_code == 200 and len(stage.json()["items"]) == 1

    commands = client.get(f"/site/v1/apps/{app_id}/commands", headers=site_auth)
    stage_command = commands.json()["items"][0]
    assert stage_command["command_type"] == "release.stage"
    assert stage_command["payload"]["artifacts"][0]["digest"] == release_digest
    assert stage_command["payload"]["artifacts"][0]["download_url"].startswith("http")
    acknowledged = client.post(
        f"/site/v1/apps/{app_id}/commands/{stage_command['command_id']}/ack",
        json={"result": "succeeded"},
        headers=site_auth,
    )
    assert acknowledged.json()["delivery_state"] == "staged"

    activate = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/{release_id}/activate",
        json={},
        headers=admin,
    ).json()["items"][0]
    failed = client.post(
        f"/site/v1/apps/{app_id}/commands/{activate['command_id']}/ack",
        json={"result": "failed", "error": "local validation failed"},
        headers=site_auth,
    )
    assert failed.json()["delivery_state"] == "failed"
    retry = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/{release_id}/activate",
        json={},
        headers=admin,
    ).json()["items"][0]
    assert retry["attempt"] == 2
    assert client.post(
        f"/site/v1/apps/{app_id}/commands/{retry['command_id']}/ack",
        json={"result": "succeeded"},
        headers=site_auth,
    ).json()["delivery_state"] == "active"

    reported = client.put(
        f"/site/v1/apps/{app_id}/status",
        json={"app_version": "1.0.0", "active_release_id": release_id},
        headers=site_auth,
    )
    assert reported.status_code == 200
    assert reported.json()["active_release_id"] == release_id
    topology = client.get(f"/admin/v1/apps/{app_id}/topology", headers=admin).json()
    assert topology["memberships"][0]["reported_release_id"] == release_id
    assert topology["memberships"][0]["federation_version_reported_at"]

    assert upload("post-status-evaluation").status_code == 201
    topology = client.get(f"/admin/v1/apps/{app_id}/topology", headers=admin).json()
    assert topology["memberships"][0]["reported_release_id"] == release_id

    rollback = client.post(
        f"/admin/v1/apps/{app_id}/federations/default/releases/{release_id}/rollback",
        json={},
        headers=admin,
    ).json()["items"][0]
    assert client.post(
        f"/site/v1/apps/{app_id}/commands/{rollback['command_id']}/ack",
        json={"result": "succeeded"},
        headers=site_auth,
    ).json()["delivery_state"] == "rolled_back"
    detail = client.get(
        f"/admin/v1/apps/{app_id}/federations/default/releases/{release_id}", headers=admin
    )
    assert detail.json()["deliveries"][0]["state"] == "rolled_back"
    assert client.get("/admin/v1/sites", headers=admin).json()["items"][0]["site_id"] == site_id
    assert client.get("/admin/v1/activity", headers=admin).json()["items"]
    assert all(
        item["app_id"] == app_id
        for item in client.get(f"/admin/v1/activity?app_id={app_id}", headers=admin).json()["items"]
    )

    job = database.claim_agent_job("integration-worker")
    assert job and job["app_id"] == app_id and job["core_plugin_id"] == "manual"
    assert job["kind"] == "evaluation.received"
    assert job["payload"]["artifact_purpose"] == "evaluation"
    result = {
        "new_state": {"handled": 1},
        "intents": [{"kind": "wait", "payload": {}}],
        "evidence": {},
        "core_plugin_id": "manual",
        "core_plugin_version": "1.0.0",
    }
    database.finish_agent_job(
        job["job_id"],
        app_id,
        "default",
        result=result,
        new_state=result["new_state"],
        expected_config_revision=job["config_revision"],
        expected_state_revision=job["state_revision"],
    )
    with database.connection() as conn:
        assert conn.execute("SELECT count(*) AS n FROM events").fetchone()["n"] == 6
        stored_job = conn.execute(
            "SELECT status, result FROM agent_jobs WHERE job_id = %s", (job["job_id"],)
        ).fetchone()
        assert stored_job == {"status": "succeeded", "result": result}
        stored_agent = conn.execute(
            """SELECT state, state_revision FROM federation_agents
               WHERE app_id = %s AND federation_id = 'default'""",
            (app_id,),
        ).fetchone()
        assert stored_agent == {"state": {"handled": 1}, "state_revision": 3}
