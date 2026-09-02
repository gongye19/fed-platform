from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest

from fedplat.agent_core import (
    AgentDecision,
    AgentCoreError,
    DeepSeekHarnessCore,
    DeepSeekHarnessCoreConfig,
    default_agent_binding,
    validate_core_config,
    run_agent_core,
)


class FakeHarness:
    options = None

    def __init__(self, **options):
        FakeHarness.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def run(self, prompt, session_id):
        assert "submission.accepted" in prompt
        assert session_id == "agent-job-job-1"
        return SimpleNamespace(
            final_response='```json\n{"new_state":{"seen":1},"intents":[{"kind":"wait","payload":{}}],"evidence":{}}\n```',
            finish_reason="completed",
        )


def test_restricted_deepseek_core_returns_a_validated_decision():
    assert default_agent_binding()["core_plugin_id"] == "manual"
    config = DeepSeekHarnessCoreConfig()
    decision = DeepSeekHarnessCore(FakeHarness).handle(
        {
            "job_id": "job-1",
            "app_id": "example.app",
            "federation_id": "main",
            "kind": "submission.accepted",
            "payload": {"submission_id": "sub-1"},
            "state": {},
        },
        config,
    )

    assert decision.new_state == {"seen": 1}
    assert FakeHarness.options["env"]["DSH_SYSTEM_PROMPT"]
    assert FakeHarness.options["env"]["FEDPLAT_DATABASE_URL"] == ""
    cordis = FakeHarness.options["cordis"]
    assert cordis.endswith("cordis.yml")
    composition = Path(cordis).read_text()
    assert "toolBash: false" in composition
    assert "toolJobs: false" in composition
    assert "enabled: false" in composition
    assert "dsh-subprocess" not in composition
    assert "dsh-fs-local" not in composition


def test_agent_core_configuration_and_state_are_bounded():
    with pytest.raises(AgentCoreError, match="unsupported"):
        validate_core_config("unknown", {})
    with pytest.raises(AgentCoreError, match="max_state_bytes"):
        validate_core_config("deepseek-harness", {"memory": {"max_state_bytes": 1}})


def test_explicit_generation_request_runs_the_domain_algorithm_without_llm():
    submissions = [str(uuid.uuid4()), str(uuid.uuid4())]
    decision = run_agent_core(
        {
            "core_plugin_id": "manual",
            "kind": "generation.requested",
            "payload": {
                "round_id": "round-1",
                "submission_ids": submissions,
                "agent_config_revision": 1,
            },
            "state": {},
        }
    )

    assert decision.intents[0].kind == "run_algorithm"
    assert decision.intents[0].payload["submission_ids"] == submissions
    assert decision.new_state["last_generation_round"] == "round-1"


def test_explicit_generation_request_reaches_a_configured_agent(monkeypatch):
    seen = []

    def handle(_self, job, _config):
        seen.append(job["kind"])
        return AgentDecision()

    monkeypatch.setattr(DeepSeekHarnessCore, "handle", handle)
    run_agent_core(
        {
            "core_plugin_id": "deepseek-harness",
            "kind": "generation.requested",
            "payload": {"round_id": "round-1", "submission_ids": []},
            "config": {},
        }
    )

    assert seen == ["generation.requested"]


def test_record_only_events_do_not_spend_an_agent_turn(monkeypatch):
    monkeypatch.setattr(
        DeepSeekHarnessCore,
        "handle",
        lambda *_: pytest.fail("record-only events must not call the model"),
    )

    decision = run_agent_core(
        {
            "core_plugin_id": "deepseek-harness",
            "kind": "submission.accepted",
            "state": {"kept": True},
        }
    )

    assert decision.new_state == {"kept": True}
    assert decision.intents[0].kind == "wait"
