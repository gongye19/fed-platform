from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any, Callable, Protocol
from uuid import UUID

from jsonschema import Draft202012Validator
from pydantic import BaseModel, ConfigDict, Field

from fedplat.artifact_store import S3ArtifactStore
from fedplat.store import Database


ENTRY_POINT_GROUP = "fedplat.federation_algorithms"
_HIDDEN_ENV = (
    "DATABASE_URL",
    "DEEPSEEK_API_KEY",
    "FEDPLAT_ADMIN_TOKEN",
    "FEDPLAT_DATABASE_URL",
    "FEDPLAT_S3_ACCESS_KEY_ID",
    "FEDPLAT_S3_SECRET_ACCESS_KEY",
    "OPENAI_API_KEY",
    "PGPASSWORD",
)


class AlgorithmError(RuntimeError):
    pass


class RunAlgorithmIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    submission_ids: list[UUID] = Field(min_length=1, max_length=10_000)
    round_id: str = Field(min_length=1, max_length=128)
    agent_config_revision: int = Field(ge=1)


@dataclass(frozen=True)
class AlgorithmInput:
    submission_id: str
    site_id: str
    digest: str
    type_name: str
    format_version: int
    media_type: str
    metadata: dict[str, Any]
    content: bytes


@dataclass(frozen=True)
class AlgorithmOutput:
    type_name: str
    format_version: int
    media_type: str
    metadata: dict[str, Any]
    content: bytes


@dataclass(frozen=True)
class AlgorithmResult:
    outputs: list[AlgorithmOutput]
    new_state: dict[str, Any] = field(default_factory=dict)
    evidence: dict[str, Any] = field(default_factory=dict)


class FederationAlgorithm(Protocol):
    plugin_id: str
    plugin_version: str

    def run(
        self,
        *,
        inputs: list[AlgorithmInput],
        config: dict[str, Any],
        state: dict[str, Any],
        round_id: str,
    ) -> AlgorithmResult: ...


def load_algorithm(plugin_id: str, plugin_version: str) -> FederationAlgorithm:
    matches = [item for item in entry_points(group=ENTRY_POINT_GROUP) if item.name == plugin_id]
    if len(matches) != 1:
        raise AlgorithmError(f"federation algorithm is not installed: {plugin_id}")
    plugin = matches[0].load()
    if isinstance(plugin, type):
        plugin = plugin()
    if (
        getattr(plugin, "plugin_id", None) != plugin_id
        or getattr(plugin, "plugin_version", None) != plugin_version
    ):
        raise AlgorithmError("installed federation algorithm version does not match its binding")
    return plugin


def installed_algorithm_ids() -> list[str]:
    return sorted({item.name for item in entry_points(group=ENTRY_POINT_GROUP)})


def run_isolated_algorithm(
    plugin_id: str,
    plugin_version: str,
    *,
    inputs: list[AlgorithmInput],
    config: dict[str, Any],
    state: dict[str, Any],
    round_id: str,
) -> AlgorithmResult:
    # ponytail: process isolation hides platform secrets; move untrusted plugins to containers.
    with TemporaryDirectory(prefix="fedplat-algorithm-") as temporary:
        root = Path(temporary).resolve()
        input_dir = root / "inputs"
        input_dir.mkdir()
        request_inputs = []
        for index, item in enumerate(inputs):
            path = input_dir / str(index)
            path.write_bytes(item.content)
            request_inputs.append(
                {
                    "submission_id": item.submission_id,
                    "site_id": item.site_id,
                    "digest": item.digest,
                    "type_name": item.type_name,
                    "format_version": item.format_version,
                    "media_type": item.media_type,
                    "metadata": item.metadata,
                    "content_path": str(path),
                }
            )
        request_path = root / "request.json"
        result_path = root / "result.json"
        request_path.write_text(
            json.dumps(
                {
                    "plugin_id": plugin_id,
                    "plugin_version": plugin_version,
                    "round_id": round_id,
                    "config": config,
                    "state": state,
                    "inputs": request_inputs,
                    "output_dir": str(root / "outputs"),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        environment = {**os.environ, **dict.fromkeys(_HIDDEN_ENV, "")}
        completed = subprocess.run(
            [
                sys.executable,
                "-m",
                "fedplat.algorithm_host",
                str(request_path),
                str(result_path),
            ],
            cwd=root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.strip()[-2000:]
            raise AlgorithmError(f"federation algorithm process failed: {detail}")
        try:
            payload = json.loads(result_path.read_text(encoding="utf-8"))
            outputs = []
            for item in payload["outputs"]:
                output_path = Path(item["content_path"]).resolve()
                if not output_path.is_relative_to(root):
                    raise ValueError("algorithm output escaped its workspace")
                outputs.append(
                    AlgorithmOutput(
                        type_name=item["type_name"],
                        format_version=int(item["format_version"]),
                        media_type=item["media_type"],
                        metadata=item["metadata"],
                        content=output_path.read_bytes(),
                    )
                )
            return AlgorithmResult(
                outputs=outputs,
                new_state=payload.get("new_state") or {},
                evidence=payload.get("evidence") or {},
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
            raise AlgorithmError("federation algorithm process returned an invalid result") from exc


def execute_run_algorithm(
    *,
    job: dict[str, Any],
    payload: dict[str, Any],
    db: Database,
    artifacts: S3ArtifactStore,
    max_artifact_bytes: int,
    loader: Callable[[str, str], FederationAlgorithm] | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    intent = RunAlgorithmIntent.model_validate(payload)
    plugin_id = job.get("algorithm_plugin_id")
    plugin_version = job.get("algorithm_plugin_version")
    if not plugin_id or not plugin_version:
        raise AlgorithmError("federation domain has no algorithm binding")
    if intent.agent_config_revision != job["config_revision"]:
        raise AlgorithmError("federation agent configuration changed after generation was requested")

    rows = db.get_algorithm_inputs(
        job["app_id"], job["federation_id"], [str(item) for item in intent.submission_ids]
    )
    inputs = []
    for row in rows:
        content = artifacts.read_bytes(row["storage_key"], row["size_bytes"])
        if "sha256:" + hashlib.sha256(content).hexdigest() != row["digest"]:
            raise AlgorithmError("federation algorithm input failed digest verification")
        inputs.append(
            AlgorithmInput(
                submission_id=str(row["submission_id"]),
                site_id=row["site_id"],
                digest=row["digest"],
                type_name=row["type_name"],
                format_version=row["format_version"],
                media_type=row["media_type"],
                metadata=row["metadata"],
                content=content,
            )
        )
    kwargs = {
        "inputs": inputs,
        "config": job.get("algorithm_config") or {},
        "state": job.get("algorithm_state") or {},
        "round_id": intent.round_id,
    }
    result = (
        loader(plugin_id, plugin_version).run(**kwargs)
        if loader is not None
        else run_isolated_algorithm(plugin_id, plugin_version, **kwargs)
    )
    if not isinstance(result, AlgorithmResult) or not 1 <= len(result.outputs) <= 100:
        raise AlgorithmError("federation algorithm returned an invalid result")
    if len(json.dumps(result.new_state, separators=(",", ":"), ensure_ascii=False).encode()) > 1024 * 1024:
        raise AlgorithmError("federation algorithm state exceeds the 1 MiB limit")

    output_digests: list[str] = []
    for output in result.outputs:
        if not isinstance(output.content, bytes):
            raise AlgorithmError("federation algorithm output content must be bytes")
        if len(output.content) > max_artifact_bytes:
            raise AlgorithmError("federation algorithm output exceeds the artifact limit")
        policy = db.artifact_policy(
            job["app_id"], job["federation_id"], output.type_name, output.format_version
        )
        if policy["purpose"] != "release":
            raise AlgorithmError("federation algorithm outputs must use a release ArtifactType")
        if output.media_type != policy["media_type"]:
            raise AlgorithmError("federation algorithm output media type is not registered")
        Draft202012Validator(policy["metadata_schema"]).validate(output.metadata)
        digest = "sha256:" + hashlib.sha256(output.content).hexdigest()
        descriptor = {
            "digest": digest,
            "type": output.type_name,
            "format_version": output.format_version,
            "media_type": output.media_type,
            "size_bytes": len(output.content),
            "metadata": output.metadata,
        }
        storage_key = artifacts.put_file(
            app_id=job["app_id"],
            federation_id=job["federation_id"],
            digest=digest,
            size_bytes=len(output.content),
            media_type=output.media_type,
            file=BytesIO(output.content),
        )
        db.create_artifact(
            app_id=job["app_id"],
            federation_id=job["federation_id"],
            descriptor=descriptor,
            storage_key=storage_key,
            actor_type="algorithm",
            actor_id=f"{plugin_id}@{plugin_version}",
        )
        output_digests.append(digest)

    return (
        {
            "kind": "run_algorithm",
            "status": "succeeded",
            "plugin_id": plugin_id,
            "plugin_version": plugin_version,
            "output_digests": output_digests,
            "evidence": result.evidence,
        },
        result.new_state,
    )
