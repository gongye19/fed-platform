from fastapi.testclient import TestClient

from fedplat.app import app, get_store
from fedplat.store import Store


def client(tmp_path):
    store = Store(tmp_path / "t.db")
    app.dependency_overrides[get_store] = lambda: store
    return TestClient(app), store


def envelope(site="s1", fp="f1", extra=None):
    item = {
        "fingerprint": fp,
        "payload_type": "card.v1",
        "body": {"text": "drink water"},
        "quality": {"evaluated": False, "n": 0},
        "produced_at": "2026-08-27T00:00:00Z",
    }
    if extra:
        item.update(extra)
    return {
        "protocol_version": "1",
        "app_id": "demo",
        "site_id": site,
        "consent": True,
        "items": [item],
    }


def test_push_pull_and_idempotent(tmp_path):
    c, _ = client(tmp_path)
    assert c.get("/health").json()["ok"]
    assert c.post("/v1/registry/apps", json={"app_id": "demo", "payload_type": "card.v1"}).status_code == 200
    key = c.post("/v1/registry/sites", json={"app_id": "demo", "site_id": "s1"}).json()["api_key"]
    h = {"Authorization": f"Bearer {key}"}

    r1 = c.post("/v1/updates", json=envelope(), headers=h)
    assert r1.status_code == 200 and r1.json()["accepted_new"] == 1
    r2 = c.post("/v1/updates", json=envelope(), headers=h)
    assert r2.json()["accepted_new"] == 0

    d = c.get("/v1/digests/latest", params={"app_id": "demo", "site_id": "s1", "payload_type": "card.v1"}, headers=h)
    assert d.status_code == 200
    body = d.json()
    assert body["items"] == [] and body["ops"] == []
    assert body["digest_id"] != "empty"


def test_rejects(tmp_path):
    c, _ = client(tmp_path)
    c.post("/v1/registry/apps", json={"app_id": "demo", "payload_type": "card.v1"})
    key = c.post("/v1/registry/sites", json={"app_id": "demo", "site_id": "s1"}).json()["api_key"]
    h = {"Authorization": f"Bearer {key}"}

    bad = envelope()
    bad["consent"] = False
    assert c.post("/v1/updates", json=bad, headers=h).json()["detail"]["code"] == "E_NO_CONSENT"

    unknown = envelope()
    unknown["app_id"] = "nope"
    assert c.post("/v1/updates", json=unknown, headers=h).json()["detail"]["code"] == "E_UNKNOWN_APP"

    assert c.post("/v1/updates", json=envelope(), headers={"Authorization": "Bearer x"}).json()["detail"]["code"] == "E_AUTH"

    assert c.post("/v1/registry/apps", json={"app_id": "x", "payload_type": "y", "plugin": "nope"}).json()["detail"]["code"] == "E_UNKNOWN_PLUGIN"
