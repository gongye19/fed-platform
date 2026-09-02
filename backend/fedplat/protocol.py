from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator


StableId = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"),
]
Version = Annotated[
    str,
    StringConstraints(pattern=r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$"),
]
Digest = Annotated[str, StringConstraints(pattern=r"^sha256:[0-9a-f]{64}$")]


def json_digest(value: Any) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return "sha256:" + hashlib.sha256(canonical.encode()).hexdigest()


class ArtifactTypeSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type_name: StableId = Field(alias="type")
    format_version: int = Field(ge=1)
    media_type: str = Field(min_length=3, max_length=255)
    purpose: Literal["contribution", "release", "evaluation"] = "contribution"
    metadata_schema: dict[str, Any] = Field(default_factory=dict)
    schema_digest: Digest | None = None

    @model_validator(mode="after")
    def set_schema_digest(self) -> ArtifactTypeSpec:
        computed = json_digest(self.metadata_schema)
        if self.schema_digest is not None and self.schema_digest != computed:
            raise ValueError("schema_digest does not match metadata_schema")
        self.schema_digest = computed
        return self


class TaskTypeSpec(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    type_name: StableId = Field(alias="type")
    version: int = Field(ge=1)
    input_schema: dict[str, Any] = Field(default_factory=dict)
    output_schema: dict[str, Any] = Field(default_factory=dict)
    input_schema_digest: Digest | None = None
    output_schema_digest: Digest | None = None

    @model_validator(mode="after")
    def set_schema_digests(self) -> TaskTypeSpec:
        input_digest = json_digest(self.input_schema)
        output_digest = json_digest(self.output_schema)
        if self.input_schema_digest is not None and self.input_schema_digest != input_digest:
            raise ValueError("input_schema_digest does not match input_schema")
        if self.output_schema_digest is not None and self.output_schema_digest != output_digest:
            raise ValueError("output_schema_digest does not match output_schema")
        self.input_schema_digest = input_digest
        self.output_schema_digest = output_digest
        return self


class FederationAlgorithmSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugin_id: StableId
    plugin_version: Version
    config: dict[str, Any] = Field(default_factory=dict)


class FederationSpec(BaseModel):
    model_config = ConfigDict(extra="forbid")

    algorithm: FederationAlgorithmSpec | None = None


class FedAppManifest(BaseModel):
    schema_version: Literal["fedapp/v1"]
    app_id: StableId
    app_version: Version
    display_name: str = Field(min_length=1, max_length=160)
    adapter_protocol: str = Field(min_length=1, max_length=64)
    federation: FederationSpec = Field(default_factory=FederationSpec)
    artifact_types: list[ArtifactTypeSpec] = Field(default_factory=list)
    task_types: list[TaskTypeSpec] = Field(default_factory=list)

    @model_validator(mode="after")
    def unique_types(self) -> FedAppManifest:
        artifact_keys = [(item.type_name, item.format_version) for item in self.artifact_types]
        task_keys = [(item.type_name, item.version) for item in self.task_types]
        if len(artifact_keys) != len(set(artifact_keys)):
            raise ValueError("artifact type/version pairs must be unique")
        if len(task_keys) != len(set(task_keys)):
            raise ValueError("task type/version pairs must be unique")
        return self


class AppSiteKeyCreate(BaseModel):
    site_id: StableId
    display_name: str = Field(min_length=1, max_length=160)


class SiteStatusReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    app_version: Version
    active_release_id: UUID | None = None


class AgentConfigurationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    core_plugin_id: StableId
    config: dict[str, Any] = Field(default_factory=dict)
    expected_revision: int = Field(ge=1)


class AlgorithmConfigurationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    plugin_id: StableId
    plugin_version: Version
    config: dict[str, Any] = Field(default_factory=dict)
    expected_revision: int = Field(ge=1)


class FederationGenerationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    round_id: StableId
    submission_ids: list[UUID] = Field(min_length=1, max_length=10_000)

    @model_validator(mode="after")
    def unique_submissions(self) -> FederationGenerationRequest:
        if len(self.submission_ids) != len(set(self.submission_ids)):
            raise ValueError("submission_ids must be unique")
        return self


class ArtifactDescriptor(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    digest: Digest
    type_name: StableId = Field(alias="type")
    format_version: int = Field(ge=1)
    media_type: str = Field(min_length=3, max_length=255)
    size_bytes: int = Field(ge=0)
    metadata: dict[str, Any] = Field(default_factory=dict)


class ReleaseCreate(BaseModel):
    artifact_digests: list[Digest] = Field(min_length=1, max_length=100)
    target_site_ids: list[StableId] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_references(self) -> ReleaseCreate:
        if len(self.artifact_digests) != len(set(self.artifact_digests)):
            raise ValueError("artifact_digests must be unique")
        if len(self.target_site_ids) != len(set(self.target_site_ids)):
            raise ValueError("target_site_ids must be unique")
        return self


class DeliveryAction(BaseModel):
    site_ids: list[StableId] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def unique_sites(self) -> DeliveryAction:
        if len(self.site_ids) != len(set(self.site_ids)):
            raise ValueError("site_ids must be unique")
        return self


class CommandAck(BaseModel):
    result: Literal["succeeded", "failed"]
    error: str | None = Field(default=None, max_length=1000)

    @model_validator(mode="after")
    def require_error_for_failure(self) -> CommandAck:
        if self.result == "failed" and not self.error:
            raise ValueError("error is required when result is failed")
        return self
