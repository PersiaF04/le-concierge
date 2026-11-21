"""Le Chonk (Mistral Large 4) on every step where latency does not matter.

The door decision stays on ``DECISION_MODEL`` (Small); the digest, the parcel
notice and the CCTV review run on ``CHONK_MODEL`` with low reasoning effort.
"""

from __future__ import annotations

import datetime as dt
import inspect
from pathlib import Path

import pytest

from worker import config
from worker.shared import api, cctv_ai, mistral_ai
from worker.workflows import cctv_event, nightly_digest, parcel_arrival, visitor_arrival

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture(autouse=True)
def replay_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKFLOWS_REPLAY", "1")
    monkeypatch.setenv("WORKFLOWS_FIXTURES_DIR", str(FIXTURES))
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)
    for name in ("DECISION_MODEL", "CHONK_MODEL", "CHONK_REASONING_EFFORT"):
        monkeypatch.delenv(name, raising=False)


def test_door_stays_on_small_and_chonk_is_large() -> None:
    settings = config.load_settings()
    assert settings.decision_model == "mistral-small-latest"
    assert settings.chonk_model == "mistral-large-latest"
    assert settings.chonk_reasoning_effort == "low"


def test_chonk_settings_read_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CHONK_MODEL", "mistral-large-4-0")
    monkeypatch.setenv("CHONK_REASONING_EFFORT", "")
    settings = config.load_settings()
    assert settings.chonk_model == "mistral-large-4-0"
    assert settings.chonk_reasoning_effort is None


async def test_door_decision_names_the_small_model() -> None:
    decided = await visitor_arrival.decide_visit({})
    assert decided["model"] == "mistral-small-latest"


class _FakeChat:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls: list[dict] = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        message = type("Message", (), {"content": self.content})()
        choice = type("Choice", (), {"message": message})()
        return type("Response", (), {"choices": [choice], "model": kwargs["model"]})()


def _real_mode(monkeypatch: pytest.MonkeyPatch, content: str) -> _FakeChat:
    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    chat = _FakeChat(content)
    client = type("Client", (), {"chat": chat})()
    monkeypatch.setattr(mistral_ai, "_client", lambda settings: client)
    return chat


async def test_chonk_write_calls_large_with_low_reasoning(monkeypatch: pytest.MonkeyPatch) -> None:
    chat = _real_mode(monkeypatch, "Your parcel is at the desk.")
    notice = await parcel_arrival.write_notice({"flat": {"flat": "12"}})
    assert notice == {
        "text": "Your parcel is at the desk.",
        "model": "mistral-large-latest",
        "reasoning_effort": "low",
    }
    assert chat.calls[0]["model"] == "mistral-large-latest"
    assert chat.calls[0]["reasoning_effort"] == "low"


async def test_chonk_review_calls_large_with_json(monkeypatch: pytest.MonkeyPatch) -> None:
    chat = _real_mode(monkeypatch, '{"flag": "yes", "severity": "HIGH", "note": "tailgate"}')
    review = await cctv_event.chonk_review_event({"text": "x", "recent_events": []})
    assert review == {
        "flag": True,
        "severity": "high",
        "note": "tailgate",
        "model": "mistral-large-latest",
        "reasoning_effort": "low",
    }
    call = chat.calls[0]
    assert call["model"] == "mistral-large-latest"
    assert call["reasoning_effort"] == "low"
    assert call["response_format"] == {"type": "json_object"}


async def test_chonk_review_cleans_a_bad_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    _real_mode(monkeypatch, "not json at all")
    review = await cctv_ai.chonk_review_event(config.load_settings(), {})
    assert review["flag"] is False
    assert review["severity"] == "low"
    assert review["model"] == "mistral-large-latest"


async def test_chonk_review_replay_names_the_model() -> None:
    review = await cctv_event.chonk_review_event({})
    assert review["flag"] is True
    assert review["severity"] == "high"
    assert "tailgated" in review["note"]
    assert review["model"] == "mistral-large-latest"
    assert review["replay"] is True


async def test_cctv_event_logs_the_chonk_review(monkeypatch: pytest.MonkeyPatch) -> None:
    logged: list[dict] = []
    real = api.log_event

    async def spy(settings, event):
        logged.append(event)
        return await real(settings, event)

    monkeypatch.setattr(cctv_event.api, "log_event", spy)
    segment = cctv_event.CctvEventInput.model_validate_json(
        (FIXTURES / "cctv_input.json").read_text(encoding="utf-8")
    )
    result = (await cctv_event.CctvEventWorkflow().run(segment))["result"]

    review = result["event"]["review"]
    assert review["flag"] is True and review["severity"] == "high" and review["note"]
    assert result["model"]["chonk"] == "mistral-large-latest"
    assert logged[0]["review"] == review
    assert logged[0]["model"]["chonk"] == "mistral-large-latest"


def test_yesterday_comes_from_the_workflow_clock() -> None:
    now = dt.datetime(2026, 11, 21, 19, 0, tzinfo=dt.timezone.utc)
    assert nightly_digest._yesterday(now) == "2026-11-20"


def test_nightly_digest_never_reads_the_wall_clock() -> None:
    source = inspect.getsource(nightly_digest)
    assert "date.today" not in source
    assert "datetime.now" not in source


async def test_nightly_digest_without_a_day_uses_workflow_now(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed = dt.datetime(2026, 11, 21, 19, 0, tzinfo=dt.timezone.utc)
    monkeypatch.setattr(nightly_digest.workflows.workflow, "now", lambda: fixed)

    result = (
        await nightly_digest.NightlyDigestWorkflow().run(
            nightly_digest.NightlyDigestInput(flat="12")
        )
    )["result"]

    assert result["day"] == "2026-11-20"
    assert "DPD" in result["digest"]
    assert result["model"] == {"chonk": "mistral-large-latest"}


async def test_parcel_arrival_names_le_chonk() -> None:
    result = (
        await parcel_arrival.ParcelArrivalWorkflow().run(
            parcel_arrival.ParcelArrivalInput(
                parcel_id="parcel_0001", snapshot_url="https://example.invalid/p.jpg"
            )
        )
    )["result"]
    assert "concierge desk" in result["message"]
    assert result["model"] == {"chonk": "mistral-large-latest"}
