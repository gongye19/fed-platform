from __future__ import annotations

import os
import socket
import time

from fedplat.store import Database


def main() -> None:
    database_url = os.environ.get("FEDPLAT_DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("missing required environment variable: FEDPLAT_DATABASE_URL")
    db = Database(database_url)
    worker_id = os.environ.get("FEDPLAT_WORKER_ID", socket.gethostname())
    while True:
        job = db.claim_agent_job(worker_id)
        if not job:
            time.sleep(1)
            continue
        try:
            # manual-channel persists submissions; a configured plugin can replace this decision later.
            db.finish_agent_job(job["job_id"], job["app_id"])
        except Exception as exc:
            db.finish_agent_job(job["job_id"], job["app_id"], str(exc))


if __name__ == "__main__":
    main()
