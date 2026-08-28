from __future__ import annotations

import os
import socket
import time

from fedplat.agent_core import run_agent_core
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
            decision = run_agent_core(job)
            result = {
                **decision.model_dump(mode="json"),
                "core_plugin_id": job["core_plugin_id"],
                "core_plugin_version": job["core_plugin_version"],
            }
            db.finish_agent_job(
                job["job_id"],
                job["app_id"],
                result=result,
                new_state=decision.new_state,
                expected_config_revision=job["config_revision"],
                expected_state_revision=job["state_revision"],
            )
        except Exception as exc:
            db.finish_agent_job(job["job_id"], job["app_id"], str(exc))


if __name__ == "__main__":
    main()
