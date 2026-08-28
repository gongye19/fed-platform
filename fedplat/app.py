from __future__ import annotations

import hashlib
import os
import secrets
import uuid
from datetime import datetime, timezone

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, ValidationError

from fedplat.plugin import get_plugin
from fedplat.protocol import Digest, Envelope
from fedplat.store import Store

DB_PATH = os.environ.get("FEDPLAT_DB", "fedplat.db")
_store: Store | None = None


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(DB_PATH)
    return _store


app = FastAPI(title="FedAgent Platform", version="0.1.0")


class AppReg(BaseModel):
    app_id: str
    payload_type: str
    plugin: str = "store_only"


class SiteReg(BaseModel):
    app_id: str
    site_id: str


def fail(status: int, code: str, detail: str) -> None:
    raise HTTPException(status_code=status, detail={"code": code, "message": detail})


def key_hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/v1/registry/apps")
def register_app(body: AppReg, store: Store = Depends(get_store)) -> dict:
    try:
        get_plugin(body.plugin)
    except KeyError:
        fail(400, "E_UNKNOWN_PLUGIN", body.plugin)
    store.upsert_app(body.app_id, body.payload_type, body.plugin)
    return {"ok": True, **body.model_dump()}


@app.post("/v1/registry/sites")
def register_site(body: SiteReg, store: Store = Depends(get_store)) -> dict:
    key = secrets.token_urlsafe(24)
    store.put_site(body.app_id, body.site_id, key_hash(key))
    return {"app_id": body.app_id, "site_id": body.site_id, "api_key": key}


@app.post("/v1/updates")
def post_updates(
    raw: dict,
    store: Store = Depends(get_store),
    authorization: str | None = Header(default=None),
) -> dict:
    try:
        env = Envelope.model_validate(raw)
    except ValidationError as e:
        fail(400, "E_BAD_PROTOCOL", str(e))

    if not env.consent:
        fail(403, "E_NO_CONSENT", "consent must be true")

    types = {it.payload_type for it in env.items}
    if len(types) != 1:
        fail(400, "E_MIXED_TYPE", "one payload_type per update")
    payload_type = types.pop()

    spec = store.get_app(env.app_id, payload_type)
    if not spec:
        fail(404, "E_UNKNOWN_APP", f"{env.app_id}/{payload_type}")

    site = store.get_site(env.app_id, env.site_id)
    if not site:
        fail(404, "E_UNKNOWN_SITE", env.site_id)
    if not authorization or not authorization.startswith("Bearer "):
        fail(401, "E_AUTH", "missing bearer token")
    if key_hash(authorization.removeprefix("Bearer ").strip()) != site["key_hash"]:
        fail(401, "E_AUTH", "bad key")

    try:
        plugin = get_plugin(spec["plugin"])
    except KeyError:
        fail(500, "E_UNKNOWN_PLUGIN", spec["plugin"])

    accepted = 0
    for item in env.items:
        try:
            plugin.validate_item(item)
        except ValueError as e:
            fail(400, "E_VALIDATE", str(e))
        if store.upsert_item(
            {
                "app_id": env.app_id,
                "site_id": env.site_id,
                "fingerprint": item.fingerprint,
                "payload_type": item.payload_type,
                "body": item.body,
                "quality": item.quality.model_dump(),
                "produced_at": item.produced_at.isoformat(),
            }
        ):
            accepted += 1

    items = store.list_items(env.app_id, payload_type)
    state = plugin.aggregate(items, None)
    payload = plugin.render_digest(state, env.site_id)
    digest_id = str(uuid.uuid4())
    store.put_digest(
        {
            "digest_id": digest_id,
            "app_id": env.app_id,
            "site_id": env.site_id,
            "payload_type": payload_type,
            "body": payload,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    return {"ok": True, "accepted_new": accepted, "digest_id": digest_id}


@app.get("/v1/digests/latest")
def latest_digest(
    app_id: str = Query(),
    site_id: str = Query(),
    payload_type: str = Query(),
    store: Store = Depends(get_store),
    authorization: str | None = Header(default=None),
) -> Digest:
    site = store.get_site(app_id, site_id)
    if not site:
        fail(404, "E_UNKNOWN_SITE", site_id)
    if not authorization or not authorization.startswith("Bearer "):
        fail(401, "E_AUTH", "missing bearer token")
    if key_hash(authorization.removeprefix("Bearer ").strip()) != site["key_hash"]:
        fail(401, "E_AUTH", "bad key")

    row = store.latest_digest(app_id, site_id, payload_type)
    if not row:
        return Digest(
            digest_id="empty",
            app_id=app_id,
            site_id=site_id,
            payload_type=payload_type,
        )
    body = row["body"]
    return Digest(
        digest_id=row["digest_id"],
        app_id=app_id,
        site_id=site_id,
        payload_type=payload_type,
        items=body.get("items", []),
        ops=body.get("ops", []),
    )
