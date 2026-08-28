import pytest
from pydantic import ValidationError

from fedplat.protocol import FedAppManifest, json_digest


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
