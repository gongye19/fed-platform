from __future__ import annotations

import hashlib
import os
from importlib.resources import files

import psycopg

LOCK_ID = 7_710_238_901


def migrate(database_url: str) -> list[str]:
    migrations = sorted(files("fedplat").joinpath("migrations").iterdir(), key=lambda item: item.name)
    applied: list[str] = []
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(%s)", (LOCK_ID,))
        try:
            conn.execute(
                """CREATE TABLE IF NOT EXISTS schema_migrations (
                     version text PRIMARY KEY,
                     checksum text NOT NULL,
                     applied_at timestamptz NOT NULL DEFAULT now()
                   )"""
            )
            for path in migrations:
                if path.name.startswith("_") or not path.name.endswith(".sql"):
                    continue
                sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(sql.encode()).hexdigest()
                current = conn.execute(
                    "SELECT checksum FROM schema_migrations WHERE version = %s", (path.name,)
                ).fetchone()
                if current:
                    if current[0] != checksum:
                        raise RuntimeError(f"migration changed after apply: {path.name}")
                    continue
                with conn.transaction():
                    conn.execute(sql, prepare=False)
                    conn.execute(
                        "INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)",
                        (path.name, checksum),
                    )
                applied.append(path.name)
        finally:
            conn.execute("SELECT pg_advisory_unlock(%s)", (LOCK_ID,))
    return applied


def main() -> None:
    database_url = os.environ.get("FEDPLAT_DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("missing required environment variable: FEDPLAT_DATABASE_URL")
    applied = migrate(database_url)
    print("migrations applied: " + (", ".join(applied) if applied else "none"))


if __name__ == "__main__":
    main()
