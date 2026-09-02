import hashlib
import uuid

from fedplat.federation_algorithm import (
    AlgorithmOutput,
    AlgorithmResult,
    execute_run_algorithm,
)


class FakeDatabase:
    created = None

    def get_algorithm_inputs(self, app_id, federation_id, submission_ids):
        content = b'{"site":"a"}'
        return [
            {
                "submission_id": submission_ids[0],
                "site_id": "site-a",
                "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
                "type_name": "example.delta",
                "format_version": 1,
                "media_type": "application/json",
                "metadata": {"round_id": "round-1"},
                "storage_key": "input",
                "size_bytes": len(content),
            }
        ]

    def artifact_policy(self, app_id, federation_id, type_name, format_version):
        return {
            "purpose": "release",
            "media_type": "application/json",
            "metadata_schema": {
                "type": "object",
                "properties": {"round_id": {"type": "string"}},
                "required": ["round_id"],
                "additionalProperties": False,
            },
        }

    def create_artifact(self, **values):
        self.created = values


class FakeArtifacts:
    stored = None

    def read_bytes(self, key, expected_size):
        return b'{"site":"a"}'

    def put_file(self, **values):
        self.stored = values["file"].read()
        return "output"


class FakeAlgorithm:
    plugin_id = "example-merge"
    plugin_version = "1"

    def run(self, *, inputs, config, state, round_id):
        assert inputs[0].site_id == "site-a"
        return AlgorithmResult(
            outputs=[
                AlgorithmOutput(
                    type_name="example.release",
                    format_version=1,
                    media_type="application/json",
                    metadata={"round_id": round_id},
                    content=b'{"global":true}',
                )
            ],
            new_state={"round_id": round_id},
            evidence={"inputs": 1},
        )


def test_bound_algorithm_produces_a_generic_release_artifact():
    database = FakeDatabase()
    artifacts = FakeArtifacts()
    result, state = execute_run_algorithm(
        job={
            "app_id": "example.app",
            "federation_id": "default",
            "algorithm_plugin_id": "example-merge",
            "algorithm_plugin_version": "1",
            "algorithm_config": {},
            "algorithm_state": {},
            "config_revision": 1,
        },
        payload={
            "round_id": "round-1",
            "submission_ids": [str(uuid.uuid4())],
            "agent_config_revision": 1,
        },
        db=database,
        artifacts=artifacts,
        max_artifact_bytes=1024,
        loader=lambda *_: FakeAlgorithm(),
    )

    assert result["output_digests"] == [database.created["descriptor"]["digest"]]
    assert artifacts.stored == b'{"global":true}'
    assert state == {"round_id": "round-1"}
