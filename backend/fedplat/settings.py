from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"missing required environment variable: {name}")
    return value


@dataclass(frozen=True)
class Settings:
    database_url: str
    admin_token: str
    s3_endpoint: str
    s3_bucket: str
    s3_region: str
    s3_access_key_id: str
    s3_secret_access_key: str
    s3_url_style: str
    max_artifact_bytes: int
    admin_auth_disabled: bool = False

    @classmethod
    def from_env(cls) -> Settings:
        style = os.environ.get("FEDPLAT_S3_URL_STYLE", "virtual").strip()
        if style == "virtual-host":
            style = "virtual"
        if style not in {"virtual", "path"}:
            raise RuntimeError("FEDPLAT_S3_URL_STYLE must be virtual or path")

        max_bytes = int(os.environ.get("FEDPLAT_MAX_ARTIFACT_BYTES", 512 * 1024 * 1024))
        if max_bytes <= 0:
            raise RuntimeError("FEDPLAT_MAX_ARTIFACT_BYTES must be positive")

        auth_disabled = os.environ.get("FEDPLAT_ADMIN_AUTH_DISABLED", "false").strip().lower()
        if auth_disabled not in {"true", "false"}:
            raise RuntimeError("FEDPLAT_ADMIN_AUTH_DISABLED must be true or false")

        admin_token = _required("FEDPLAT_ADMIN_TOKEN")
        if len(admin_token) < 24:
            raise RuntimeError("FEDPLAT_ADMIN_TOKEN must contain at least 24 characters")

        return cls(
            database_url=_required("FEDPLAT_DATABASE_URL"),
            admin_token=admin_token,
            s3_endpoint=_required("FEDPLAT_S3_ENDPOINT"),
            s3_bucket=_required("FEDPLAT_S3_BUCKET"),
            s3_region=os.environ.get("FEDPLAT_S3_REGION", "auto"),
            s3_access_key_id=_required("FEDPLAT_S3_ACCESS_KEY_ID"),
            s3_secret_access_key=_required("FEDPLAT_S3_SECRET_ACCESS_KEY"),
            s3_url_style=style,
            max_artifact_bytes=max_bytes,
            admin_auth_disabled=auth_disabled == "true",
        )


@lru_cache
def get_settings() -> Settings:
    return Settings.from_env()
