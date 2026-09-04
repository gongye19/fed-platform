from __future__ import annotations

import hashlib
import os
import secrets
import uuid
from functools import lru_cache
from typing import Annotated, Any

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, Response, UploadFile
from jsonschema import Draft202012Validator
from jsonschema.exceptions import SchemaError, ValidationError as JsonSchemaValidationError
from pydantic import ValidationError
from starlette.requests import Request
from starlette.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from fedplat.agent_core import (
    AgentCoreError,
    core_version,
    default_agent_binding,
    validate_core_config,
)
from fedplat.artifact_store import ArtifactStoreError, S3ArtifactStore
from fedplat.protocol import (
    AgentConfigurationUpdate,
    AlgorithmConfigurationUpdate,
    AppSiteKeyCreate,
    ArtifactDescriptor,
    CommandAck,
    DeliveryAction,
    Digest,
    FedAppManifest,
    FederationGenerationRequest,
    GeneratedReleaseCreate,
    ReleaseCreate,
    SiteStatusReport,
    StableId,
    Version,
    json_digest,
)
from fedplat.settings import Settings, get_settings
from fedplat.store import ConflictError, Database, ForbiddenError, NotFoundError


app = FastAPI(title="FedAgent Platform", version="0.7.0")
cors_origins = [
    origin.strip()
    for origin in os.environ.get("FEDPLAT_CORS_ORIGINS", "").split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_methods=["GET", "POST", "PUT", "OPTIONS"],
    allow_headers=[
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-App-Version",
        "X-Federation-Version",
    ],
)


@app.middleware("http")
async def limit_artifact_upload(request: Request, call_next):
    if (
        request.method == "POST"
        and "/v1/apps/" in request.url.path
        and request.url.path.endswith("/artifacts")
    ):
        raw_length = request.headers.get("content-length")
        if raw_length is None:
            return JSONResponse(
                status_code=411,
                content={"detail": {"code": "E_LENGTH_REQUIRED", "message": "Content-Length is required"}},
            )
        try:
            content_length = int(raw_length)
        except ValueError:
            return JSONResponse(
                status_code=400,
                content={"detail": {"code": "E_BAD_LENGTH", "message": "invalid Content-Length"}},
            )
        configured_limit = getattr(app.state, "max_artifact_bytes", None)
        max_artifact_bytes = configured_limit or get_settings().max_artifact_bytes
        if content_length > max_artifact_bytes + 1024 * 1024:
            return JSONResponse(
                status_code=413,
                content={
                    "detail": {
                        "code": "E_ARTIFACT_TOO_LARGE",
                        "message": "artifact exceeds configured upload limit",
                    }
                },
            )
    return await call_next(request)


@lru_cache
def get_database() -> Database:
    return Database(get_settings().database_url)


@lru_cache
def get_artifact_store() -> S3ArtifactStore:
    return S3ArtifactStore(get_settings())


def fail(status: int, code: str, message: str) -> None:
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        fail(401, "E_AUTH", "missing bearer token")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        fail(401, "E_AUTH", "missing bearer token")
    return token


def require_admin(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    if settings.admin_auth_disabled:
        return
    token = bearer_token(authorization)
    if not secrets.compare_digest(token, settings.admin_token):
        fail(401, "E_AUTH", "invalid admin credential")


def authenticate_app_site(
    app_id: StableId,
    db: Annotated[Database, Depends(get_database)],
    authorization: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    try:
        return db.authenticate_app_site(app_id, token_hash(bearer_token(authorization)))
    except ForbiddenError as exc:
        fail(401, "E_AUTH", str(exc))


def map_store_error(exc: RuntimeError) -> None:
    if isinstance(exc, ConflictError):
        fail(409, "E_CONFLICT", str(exc))
    if isinstance(exc, NotFoundError):
        fail(404, "E_NOT_FOUND", str(exc))
    if isinstance(exc, ForbiddenError):
        fail(403, "E_FORBIDDEN", str(exc))
    raise exc


def store_artifact_upload(
    *,
    app_id: str,
    federation_id: str,
    descriptor: ArtifactDescriptor,
    content: UploadFile,
    policy: dict[str, Any],
    settings: Settings,
    artifacts: S3ArtifactStore,
) -> str:
    if descriptor.media_type != policy["media_type"]:
        fail(400, "E_MEDIA_TYPE", "descriptor media_type does not match ArtifactType")
    if content.content_type and content.content_type != descriptor.media_type:
        fail(400, "E_MEDIA_TYPE", "upload content type does not match descriptor")
    try:
        Draft202012Validator(policy["metadata_schema"]).validate(descriptor.metadata)
    except JsonSchemaValidationError as exc:
        fail(400, "E_BAD_METADATA", exc.message)

    if descriptor.size_bytes > settings.max_artifact_bytes:
        fail(413, "E_ARTIFACT_TOO_LARGE", "artifact exceeds configured upload limit")
    digest = hashlib.sha256()
    actual_size = 0
    content.file.seek(0)
    while chunk := content.file.read(1024 * 1024):
        actual_size += len(chunk)
        if actual_size > settings.max_artifact_bytes:
            fail(413, "E_ARTIFACT_TOO_LARGE", "artifact exceeds configured upload limit")
        digest.update(chunk)
    if actual_size != descriptor.size_bytes or "sha256:" + digest.hexdigest() != descriptor.digest:
        fail(400, "E_DIGEST", "artifact size or digest verification failed")

    try:
        return artifacts.put_file(
            app_id=app_id,
            federation_id=federation_id,
            digest=descriptor.digest,
            size_bytes=descriptor.size_bytes,
            media_type=descriptor.media_type,
            file=content.file,
        )
    except ArtifactStoreError as exc:
        fail(502, "E_ARTIFACT_STORE", str(exc))


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/ready")
def ready(
    db: Annotated[Database, Depends(get_database)],
    artifacts: Annotated[S3ArtifactStore, Depends(get_artifact_store)],
) -> dict[str, bool]:
    try:
        db.health()
        artifacts.health()
    except Exception:
        fail(503, "E_NOT_READY", "database or object storage is unavailable")
    return {"ok": True}


@app.post("/admin/v1/apps", dependencies=[Depends(require_admin)])
def register_application(
    body: FedAppManifest,
    response: Response,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        for artifact_type in body.artifact_types:
            Draft202012Validator.check_schema(artifact_type.metadata_schema)
        for task_type in body.task_types:
            Draft202012Validator.check_schema(task_type.input_schema)
            Draft202012Validator.check_schema(task_type.output_schema)
    except SchemaError as exc:
        fail(400, "E_BAD_SCHEMA", exc.message)

    manifest = body.model_dump(by_alias=True, mode="json")
    try:
        created = db.register_application(manifest, json_digest(manifest), default_agent_binding())
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    response.status_code = 201 if created else 200
    return {"app_id": body.app_id, "app_version": body.app_version, "created": created}


@app.get("/admin/v1/apps", dependencies=[Depends(require_admin)])
def list_applications(
    db: Annotated[Database, Depends(get_database)],
    after: StableId | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    items = db.list_applications(after=after, limit=limit)
    return {"items": items, "next": items[-1]["app_id"] if len(items) == limit else None}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/agent",
    dependencies=[Depends(require_admin)],
)
def get_agent_configuration(
    app_id: StableId,
    federation_id: StableId,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.get_agent_configuration(app_id, federation_id)
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.put(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/agent",
    dependencies=[Depends(require_admin)],
)
def update_agent_configuration(
    app_id: StableId,
    federation_id: StableId,
    body: AgentConfigurationUpdate,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        config = validate_core_config(body.core_plugin_id, body.config)
        return db.update_agent_configuration(
            app_id,
            federation_id,
            body.core_plugin_id,
            core_version(body.core_plugin_id),
            config,
            body.expected_revision,
        )
    except AgentCoreError as exc:
        fail(400, "E_BAD_AGENT_CONFIG", str(exc))
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.put(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/agent/algorithm",
    dependencies=[Depends(require_admin)],
)
def update_algorithm_configuration(
    app_id: StableId,
    federation_id: StableId,
    body: AlgorithmConfigurationUpdate,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.update_algorithm_configuration(
            app_id,
            federation_id,
            body.plugin_id,
            body.plugin_version,
            body.config,
            body.expected_revision,
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.post(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/agent/generations",
    dependencies=[Depends(require_admin)],
)
def request_federation_generation(
    app_id: StableId,
    federation_id: StableId,
    body: FederationGenerationRequest,
    response: Response,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        job, created = db.request_generation(
            app_id,
            federation_id,
            body.round_id,
            [str(item) for item in body.submission_ids],
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    response.status_code = 202 if created else 200
    return {**job, "created": created}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/agent/jobs/{job_id}",
    dependencies=[Depends(require_admin)],
)
def get_federation_agent_job(
    app_id: StableId,
    federation_id: StableId,
    job_id: uuid.UUID,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.get_agent_job(app_id, federation_id, job_id)
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.get("/admin/v1/apps/{app_id}/topology", dependencies=[Depends(require_admin)])
def application_topology(
    app_id: StableId,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.topology(app_id)
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.post(
    "/admin/v1/apps/{app_id}/site-keys",
    status_code=201,
    dependencies=[Depends(require_admin)],
)
def issue_app_site_key(
    app_id: StableId,
    body: AppSiteKeyCreate,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    api_key = secrets.token_urlsafe(32)
    try:
        db.issue_app_site_key(
            app_id,
            body.site_id,
            body.display_name,
            api_key[:12],
            token_hash(api_key),
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    return {"app_id": app_id, "site_id": body.site_id, "api_key": api_key}


@app.get("/admin/v1/sites", dependencies=[Depends(require_admin)])
def list_sites(
    db: Annotated[Database, Depends(get_database)],
    limit: int = Query(default=100, ge=1, le=100),
) -> dict[str, Any]:
    return {"items": db.list_sites(limit)}


@app.get("/admin/v1/activity", dependencies=[Depends(require_admin)])
def list_activity(
    db: Annotated[Database, Depends(get_database)],
    app_id: StableId | None = Query(default=None),
    limit: int = Query(default=100, ge=1, le=100),
) -> dict[str, Any]:
    return {"items": db.list_activity(limit, app_id)}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/submissions",
    dependencies=[Depends(require_admin)],
)
def list_submissions(
    app_id: StableId,
    federation_id: StableId,
    db: Annotated[Database, Depends(get_database)],
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    return {"items": db.list_submissions(app_id, federation_id, limit)}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/evaluations",
    dependencies=[Depends(require_admin)],
)
def list_evaluations(
    app_id: StableId,
    federation_id: StableId,
    db: Annotated[Database, Depends(get_database)],
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    return {"items": db.list_evaluations(app_id, federation_id, limit)}


@app.post(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/artifacts",
    status_code=201,
    dependencies=[Depends(require_admin)],
)
def create_artifact(
    app_id: StableId,
    federation_id: StableId,
    response: Response,
    descriptor_json: Annotated[str, Form(alias="descriptor")],
    content: Annotated[UploadFile, File()],
    settings: Annotated[Settings, Depends(get_settings)],
    db: Annotated[Database, Depends(get_database)],
    artifacts: Annotated[S3ArtifactStore, Depends(get_artifact_store)],
) -> dict[str, Any]:
    try:
        descriptor = ArtifactDescriptor.model_validate_json(descriptor_json)
        policy = db.artifact_policy(
            app_id, federation_id, descriptor.type_name, descriptor.format_version
        )
    except ValidationError as exc:
        fail(400, "E_BAD_DESCRIPTOR", str(exc))
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    storage_key = store_artifact_upload(
        app_id=app_id,
        federation_id=federation_id,
        descriptor=descriptor,
        content=content,
        policy=policy,
        settings=settings,
        artifacts=artifacts,
    )
    try:
        artifact, created = db.create_artifact(
            app_id=app_id,
            federation_id=federation_id,
            descriptor=descriptor.model_dump(by_alias=True, mode="json"),
            storage_key=storage_key,
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    response.status_code = 201 if created else 200
    artifact.pop("storage_key", None)
    return {**artifact, "created": created}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/artifacts/{digest}",
    dependencies=[Depends(require_admin)],
)
def get_artifact(
    app_id: StableId,
    federation_id: StableId,
    digest: Digest,
    db: Annotated[Database, Depends(get_database)],
    artifacts: Annotated[S3ArtifactStore, Depends(get_artifact_store)],
) -> dict[str, Any]:
    try:
        artifact = db.get_artifact(app_id, federation_id, digest)
        artifact["download_url"] = artifacts.download_url(artifact.pop("storage_key"))
        return artifact
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    except ArtifactStoreError as exc:
        fail(502, "E_ARTIFACT_STORE", str(exc))


@app.post(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/releases",
    status_code=201,
    dependencies=[Depends(require_admin)],
)
def create_release(
    app_id: StableId,
    federation_id: StableId,
    body: ReleaseCreate,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.create_release(
            app_id, federation_id, body.artifact_digests, body.target_site_ids
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.post(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/releases/generate",
    status_code=201,
    dependencies=[Depends(require_admin)],
)
def generate_release(
    app_id: StableId,
    federation_id: StableId,
    db: Annotated[Database, Depends(get_database)],
    body: GeneratedReleaseCreate | None = None,
) -> dict[str, Any]:
    try:
        source = db.next_unreleased_release(
            app_id,
            federation_id,
            body.generation_job_id if body else None,
        )
        return db.create_release(
            app_id,
            federation_id,
            source["artifact_digests"],
            None,
            generation_job_id=source.get("generation_job_id"),
            input_submission_ids=source.get("submission_ids", []),
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/releases",
    dependencies=[Depends(require_admin)],
)
def list_releases(
    app_id: StableId,
    federation_id: StableId,
    db: Annotated[Database, Depends(get_database)],
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    return {"items": db.list_releases(app_id, federation_id, limit)}


@app.get(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/releases/{release_id}",
    dependencies=[Depends(require_admin)],
)
def release_detail(
    app_id: StableId,
    federation_id: StableId,
    release_id: uuid.UUID,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.release_detail(app_id, federation_id, release_id)
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.post(
    "/admin/v1/apps/{app_id}/federations/{federation_id}/releases/{release_id}/{action}",
    dependencies=[Depends(require_admin)],
)
def request_delivery_action(
    app_id: StableId,
    federation_id: StableId,
    release_id: uuid.UUID,
    action: str,
    body: DeliveryAction,
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    if action not in {"stage", "activate", "rollback"}:
        fail(404, "E_NOT_FOUND", "delivery action not found")
    try:
        return {
            "items": db.create_delivery_commands(
                app_id, federation_id, release_id, action, body.site_ids
            )
        }
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.get("/site/v1/apps/{app_id}/commands")
def list_site_commands(
    app_id: StableId,
    site: Annotated[dict[str, str], Depends(authenticate_app_site)],
    db: Annotated[Database, Depends(get_database)],
    artifacts: Annotated[S3ArtifactStore, Depends(get_artifact_store)],
    after: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=100),
) -> dict[str, Any]:
    items = db.site_commands(app_id, site["site_id"], after, limit)
    for item in items:
        if item["command_type"] != "release.stage":
            continue
        try:
            artifact_items = db.command_artifacts(item["command_id"])
            for artifact in artifact_items:
                artifact["download_url"] = artifacts.download_url(artifact.pop("storage_key"))
            item["payload"] = {**item["payload"], "artifacts": artifact_items}
        except ArtifactStoreError as exc:
            fail(502, "E_ARTIFACT_STORE", str(exc))
    return {
        "items": items,
        "next": items[-1]["command_cursor"] if len(items) == limit else None,
    }


@app.post("/site/v1/apps/{app_id}/commands/{command_id}/ack")
def acknowledge_site_command(
    app_id: StableId,
    command_id: uuid.UUID,
    body: CommandAck,
    site: Annotated[dict[str, str], Depends(authenticate_app_site)],
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.acknowledge_command(
            app_id, site["site_id"], command_id, body.result, body.error
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.put("/site/v1/apps/{app_id}/status")
def report_site_status(
    app_id: StableId,
    body: SiteStatusReport,
    site: Annotated[dict[str, str], Depends(authenticate_app_site)],
    db: Annotated[Database, Depends(get_database)],
) -> dict[str, Any]:
    try:
        return db.report_site_status(
            app_id=app_id,
            site_id=site["site_id"],
            display_name=site["display_name"],
            app_version=body.app_version,
            active_release_id=body.active_release_id,
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)


@app.post("/site/v1/apps/{app_id}/artifacts", status_code=201)
def submit_artifact(
    app_id: StableId,
    response: Response,
    descriptor_json: Annotated[str, Form(alias="descriptor")],
    content: Annotated[UploadFile, File()],
    idempotency_key: Annotated[
        str,
        Header(alias="Idempotency-Key", min_length=1, max_length=160),
    ],
    app_version: Annotated[Version, Header(alias="X-App-Version")],
    site: Annotated[dict[str, str], Depends(authenticate_app_site)],
    settings: Annotated[Settings, Depends(get_settings)],
    db: Annotated[Database, Depends(get_database)],
    artifacts: Annotated[S3ArtifactStore, Depends(get_artifact_store)],
) -> dict[str, Any]:
    try:
        descriptor = ArtifactDescriptor.model_validate_json(descriptor_json)
    except ValidationError as exc:
        fail(400, "E_BAD_DESCRIPTOR", str(exc))

    try:
        policy = db.submission_policy(
            app_id,
            app_version,
            descriptor.type_name,
            descriptor.format_version,
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)

    federation_id = policy["federation_id"]
    storage_key = store_artifact_upload(
        app_id=app_id,
        federation_id=federation_id,
        descriptor=descriptor,
        content=content,
        policy=policy,
        settings=settings,
        artifacts=artifacts,
    )

    descriptor_data = descriptor.model_dump(by_alias=True, mode="json")
    try:
        submission, created = db.create_submission(
            app_id=app_id,
            federation_id=federation_id,
            site_id=site["site_id"],
            display_name=site["display_name"],
            app_version=app_version,
            descriptor=descriptor_data,
            artifact_purpose=policy["purpose"],
            storage_key=storage_key,
            idempotency_key=idempotency_key,
        )
    except (ConflictError, NotFoundError, ForbiddenError) as exc:
        map_store_error(exc)
    response.status_code = 201 if created else 200
    return {
        "submission_id": submission["submission_id"],
        "submission_number": submission["submission_number"],
        "artifact_digest": submission["artifact_digest"],
        "created_at": submission["created_at"],
        "created": created,
    }
