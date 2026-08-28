from __future__ import annotations

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS apps (
  app_id TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  plugin TEXT NOT NULL,
  PRIMARY KEY (app_id, payload_type)
);
CREATE TABLE IF NOT EXISTS sites (
  app_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  PRIMARY KEY (app_id, site_id)
);
CREATE TABLE IF NOT EXISTS items (
  app_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  body TEXT NOT NULL,
  quality TEXT NOT NULL,
  produced_at TEXT NOT NULL,
  PRIMARY KEY (app_id, site_id, fingerprint)
);
CREATE TABLE IF NOT EXISTS digests (
  digest_id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL,
  site_id TEXT NOT NULL,
  payload_type TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS digests_latest
  ON digests (app_id, site_id, payload_type, created_at);
"""


class Store:
    def __init__(self, path: str | Path) -> None:
        self.path = str(path)
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def upsert_app(self, app_id: str, payload_type: str, plugin: str) -> None:
        self.conn.execute(
            """INSERT INTO apps (app_id, payload_type, plugin)
               VALUES (?, ?, ?)
               ON CONFLICT(app_id, payload_type) DO UPDATE SET plugin=excluded.plugin""",
            (app_id, payload_type, plugin),
        )
        self.conn.commit()

    def get_app(self, app_id: str, payload_type: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM apps WHERE app_id=? AND payload_type=?",
            (app_id, payload_type),
        ).fetchone()
        return dict(row) if row else None

    def put_site(self, app_id: str, site_id: str, key_hash: str) -> None:
        self.conn.execute(
            """INSERT INTO sites (app_id, site_id, key_hash)
               VALUES (?, ?, ?)
               ON CONFLICT(app_id, site_id) DO UPDATE SET key_hash=excluded.key_hash""",
            (app_id, site_id, key_hash),
        )
        self.conn.commit()

    def get_site(self, app_id: str, site_id: str) -> dict | None:
        row = self.conn.execute(
            "SELECT * FROM sites WHERE app_id=? AND site_id=?",
            (app_id, site_id),
        ).fetchone()
        return dict(row) if row else None

    def upsert_item(self, row: dict) -> bool:
        """Return True if this fingerprint is new for the site."""
        cur = self.conn.execute(
            """INSERT OR IGNORE INTO items
               (app_id, site_id, fingerprint, payload_type, body, quality, produced_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                row["app_id"],
                row["site_id"],
                row["fingerprint"],
                row["payload_type"],
                json.dumps(row["body"], ensure_ascii=False),
                json.dumps(row["quality"], ensure_ascii=False),
                row["produced_at"],
            ),
        )
        self.conn.commit()
        return cur.rowcount == 1

    def list_items(self, app_id: str, payload_type: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT * FROM items WHERE app_id=? AND payload_type=?",
            (app_id, payload_type),
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            d["body"] = json.loads(d["body"])
            d["quality"] = json.loads(d["quality"])
            out.append(d)
        return out

    def put_digest(self, row: dict) -> None:
        self.conn.execute(
            """INSERT INTO digests
               (digest_id, app_id, site_id, payload_type, body, created_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                row["digest_id"],
                row["app_id"],
                row["site_id"],
                row["payload_type"],
                json.dumps(row["body"], ensure_ascii=False),
                row["created_at"],
            ),
        )
        self.conn.commit()

    def latest_digest(self, app_id: str, site_id: str, payload_type: str) -> dict | None:
        row = self.conn.execute(
            """SELECT * FROM digests
               WHERE app_id=? AND site_id=? AND payload_type=?
               ORDER BY created_at DESC LIMIT 1""",
            (app_id, site_id, payload_type),
        ).fetchone()
        if not row:
            return None
        d = dict(row)
        d["body"] = json.loads(d["body"])
        return d
