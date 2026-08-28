from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class Quality(BaseModel):
    model_config = ConfigDict(extra="allow")

    evaluated: bool
    n: int = 0


class Item(BaseModel):
    fingerprint: str
    payload_type: str
    encoding: Literal["json"] = "json"
    body: dict[str, Any]
    quality: Quality
    produced_at: datetime


class Envelope(BaseModel):
    protocol_version: Literal["1"]
    app_id: str
    site_id: str
    consent: bool
    items: list[Item] = Field(min_length=1)


class Digest(BaseModel):
    digest_id: str
    app_id: str
    site_id: str
    payload_type: str
    items: list[Any] = []
    ops: list[Any] = []
