from __future__ import annotations

import os
import socket
import time

from fedplat.artifact_store import S3ArtifactStore
from fedplat.agent_core import run_agent_core
from fedplat.federation_algorithm import execute_run_algorithm, installed_algorithm_ids
from fedplat.settings import Settings
from fedplat.store import Database


def execute_intents(job, decision, db):
    results = []
    algorithm_state = None
    run_intents = [intent for intent in decision.intents if intent.kind == "run_algorithm"]
    if len(run_intents) > 1:
        raise RuntimeError("an agent decision may run at most one federation algorithm")
    for intent in decision.intents:
        if intent.kind != "run_algorithm":
            results.append({"kind": intent.kind, "status": "recorded"})
            continue
        settings = Settings.from_env()
        result, algorithm_state = execute_run_algorithm(
            job=job,
            payload=intent.payload,
            db=db,
            artifacts=S3ArtifactStore(settings),
            max_artifact_bytes=settings.max_artifact_bytes,
        )
        results.append(result)
    return results, algorithm_state


def main() -> None:
    database_url = os.environ.get("FEDPLAT_DATABASE_URL", "").strip()
    if not database_url:
        raise RuntimeError("missing required environment variable: FEDPLAT_DATABASE_URL")
    db = Database(database_url)
    worker_id = os.environ.get("FEDPLAT_WORKER_ID", socket.gethostname())
    algorithm_plugin_ids = installed_algorithm_ids()
    process_agent_events = os.environ.get("FEDPLAT_PROCESS_AGENT_EVENTS", "true").lower() == "true"
    while True:
        job = db.claim_agent_job(
            worker_id,
            algorithm_plugin_ids,
            process_agent_events=process_agent_events,
        )
        if not job:
            time.sleep(1)
            continue
        try:
            decision = run_agent_core(job)
            intent_results, algorithm_state = execute_intents(job, decision, db)
            result = {
                **decision.model_dump(mode="json"),
                "core_plugin_id": job["core_plugin_id"],
                "core_plugin_version": job["core_plugin_version"],
                "intent_results": intent_results,
            }
            db.finish_agent_job(
                job["job_id"],
                job["app_id"],
                job["federation_id"],
                result=result,
                new_state=decision.new_state,
                new_algorithm_state=algorithm_state,
                expected_config_revision=job["config_revision"],
                expected_state_revision=job["state_revision"],
                expected_algorithm_state_revision=job["algorithm_state_revision"],
            )
        except Exception as exc:
            db.finish_agent_job(
                job["job_id"], job["app_id"], job["federation_id"], str(exc)
            )


if __name__ == "__main__":
    main()
