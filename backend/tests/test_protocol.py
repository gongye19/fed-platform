import pytest
from pydantic import ValidationError

from fedplat.app import require_admin
from fedplat.protocol import CommandAck, FedAppManifest, ReleaseCreate, json_digest
from fedplat.settings import Settings


def test_manifest_derives_and_checks_schema_digest():
    manifest = FedAppManifest.model_validate(
        {
            "schema_version": "fedapp/v1",
            "app_id": "com.example.agent",
            "app_version": "1.0.0",
            "display_name": "Example Agent",
            "adapter_protocol": ">=1.0 <2.0",
            "artifact_types": [
                {
                    "type": "com.example.memory",
                    "format_version": 1,
                    "media_type": "application/json",
                    "metadata_schema": {"type": "object"},
                }
            ],
        }
    )
    assert manifest.artifact_types[0].schema_digest == json_digest({"type": "object"})

    raw = manifest.model_dump(by_alias=True, mode="json")
    raw["artifact_types"][0]["schema_digest"] = "sha256:" + "0" * 64
    with pytest.raises(ValidationError):
        FedAppManifest.model_validate(raw)


def test_release_and_ack_boundaries():
    digest = "sha256:" + "a" * 64
    release = ReleaseCreate(artifact_digests=[digest], target_site_ids=["site-a"])
    assert release.artifact_digests == [digest]
    with pytest.raises(ValidationError):
        ReleaseCreate(artifact_digests=[digest, digest])
    with pytest.raises(ValidationError):
        CommandAck(result="failed")


def test_admin_auth_can_be_disabled_explicitly():
    settings = Settings(
        database_url="postgresql://unused",
        admin_token="x" * 24,
        s3_endpoint="https://example.invalid",
        s3_bucket="unused",
        s3_region="auto",
        s3_access_key_id="unused",
        s3_secret_access_key="unused",
        s3_url_style="virtual",
        max_artifact_bytes=1,
        admin_auth_disabled=True,
    )

    assert require_admin(settings, None) is None
