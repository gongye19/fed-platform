from pathlib import Path
from types import SimpleNamespace

import pytest

from fedplat.agent_core import (
    AgentCoreError,
    DeepSeekHarnessCore,
    DeepSeekHarnessCoreConfig,
    default_agent_binding,
    validate_core_config,
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
    binding = default_agent_binding()
    config = DeepSeekHarnessCoreConfig.model_validate(binding["config"])
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
