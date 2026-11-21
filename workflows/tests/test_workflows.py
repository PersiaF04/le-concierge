"""Tests for the Le Concierge workflows.

Everything runs with ``WORKFLOWS_REPLAY=1``: activities read the recorded
fixtures, so there is no network and no API key involved.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from worker import config
from worker.shared import api, replay
from worker.workflows import nightly_digest, parcel_arrival, visitor_arrival

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


@pytest.fixture(autouse=True)
def replay_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WORKFLOWS_REPLAY", "1")
    monkeypatch.setenv("WORKFLOWS_FIXTURES_DIR", str(FIXTURES))
    monkeypatch.delenv("MISTRAL_API_KEY", raising=False)


def test_discovery_finds_the_three_workflows() -> None:
    import mistralai.workflows as workflows

    classes = workflows.discover_all_workflows_in_package("worker.workflows")
    names = {workflows.get_workflow_definition(cls).name for cls in classes}
    assert names == {"visitor-arrival", "parcel-arrival", "nightly-digest"}


def test_settings_read_the_replay_switch(monkeypatch: pytest.MonkeyPatch) -> None:
    settings = config.load_settings()
    assert settings.replay is True
    assert settings.api_base_url == "http://localhost:3000"
    assert settings.fixtures_dir == FIXTURES

    monkeypatch.setenv("LE_CONCIERGE_API_URL", "http://api.test:8080/")
    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    assert config.load_settings().replay is False
    assert config.load_settings().api_base_url == "http://api.test:8080"


def test_require_api_key_explains_replay() -> None:
    with pytest.raises(config.ConfigurationError) as excinfo:
        config.require_api_key(config.load_settings())
    assert "WORKFLOWS_REPLAY=1" in str(excinfo.value)


async def test_visitor_activities_use_fixtures() -> None:
    scene = await visitor_arrival.describe_snapshot("https://example.invalid/door.jpg")
    assert scene["people_visible"] == 1
    assert "door" in scene["scene"]

    face = await visitor_arrival.match_face(
        {"descriptor": [0.01, -0.02], "model": "face-api.js/ssd_mobilenetv1"}
    )
    assert face["matched"] is True
    assert face["resident_id"] == "res_12_persia"

    transcript = await visitor_arrival.transcribe_intercom_audio(
        "https://example.invalid/audio.wav"
    )
    assert "flat twelve" in transcript["text"]

    choice = await visitor_arrival.decide_visit({"flat_hint": None})
    assert choice["flat"] == "12"
    assert choice["action"] == "ask"

    visited = await visitor_arrival.post_visit({"visit_id": "visit_0001"})
    assert visited["status"] == "pending_resident"

    spoken = await visitor_arrival.speak_reply({"text": "Come in, 12."})
    assert spoken["played"] is True

    logged = await visitor_arrival.log_event({"type": "test"})
    assert logged["stored"] is True


async def test_visitor_activities_skip_face_match_without_descriptor() -> None:
    result = await visitor_arrival.match_face({})
    assert result == {"matched": False, "resident_id": None, "distance": None}


async def test_visitor_activities_handle_missing_audio() -> None:
    result = await visitor_arrival.transcribe_intercom_audio(None)
    assert result == {"text": ""}


async def test_parcel_activities_use_fixtures() -> None:
    scene = await parcel_arrival.read_label("https://example.invalid/parcel.jpg")
    assert scene["parcels"][0]["courier"] == "DPD"

    flat = await parcel_arrival.match_flat("FLAT 12 - HANDLE WITH CARE", None)
    assert flat == {"flat": "12", "source": "label"}

    fallback = await parcel_arrival.match_flat(None, "7")
    assert fallback == {"flat": "7", "source": "input"}

    message = await parcel_arrival.write_notice({"flat": {"flat": "12"}})
    assert "concierge desk" in message

    delivered = await parcel_arrival.notify({"parcel_id": "parcel_0001"})
    assert delivered["delivered"] is True


def test_match_flat_prefers_the_label_number() -> None:
    assert asyncio.run(parcel_arrival.match_flat("Apt. 14B please", "99")) == {
        "flat": "14B",
        "source": "label",
    }


async def test_digest_activities_use_fixtures() -> None:
    events = await nightly_digest.fetch_day_events("2026-11-20", "12")
    assert len(events["events"]) == 3

    text = await nightly_digest.write_digest({"day": "2026-11-20"})
    assert "DPD" in text

    delivered = await nightly_digest.send_digest({"flat": "12"})
    assert delivered["delivered"] is True


async def test_visitor_signal_records_the_decision() -> None:
    workflow = visitor_arrival.VisitorArrivalWorkflow()
    assert workflow._decision is None
    # Signals arrive as a payload dict; the SDK validates it against the handler.
    await workflow.on_resident_decision(
        {"decision": "approve", "resident_id": "res_12_persia"}
    )
    assert workflow._decision == {
        "decision": "approve",
        "resident_id": "res_12_persia",
        "note": None,
    }


def _patch_wait_condition(monkeypatch: pytest.MonkeyPatch, decision: str | None) -> None:
    async def fake_wait_condition(*_args, **_kwargs) -> None:
        if decision is None:
            raise asyncio.TimeoutError
        return None

    monkeypatch.setattr(
        visitor_arrival.workflows.workflow, "wait_condition", fake_wait_condition
    )
    monkeypatch.setattr(visitor_arrival, "_execution_id", lambda: "exec_test")


async def test_visitor_arrival_declines_on_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_wait_condition(monkeypatch, decision=None)
    workflow = visitor_arrival.VisitorArrivalWorkflow()

    # The entrypoint wraps the return value as {"result": ...}.
    result = (
        await workflow.run(
            visitor_arrival.VisitorArrivalInput(
                visit_id="visit_0001",
                snapshot_url="https://example.invalid/door.jpg",
                audio_url="https://example.invalid/audio.wav",
                decision_timeout_seconds=1,
            )
        )
    )["result"]

    assert result["decision"] == "decline"
    assert result["execution_id"] == "exec_test"
    assert result["flat"] == "12"
    assert "try again" in result["reply"]


async def test_visitor_arrival_opens_the_door_on_approval(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_wait_condition(monkeypatch, decision="approve")
    workflow = visitor_arrival.VisitorArrivalWorkflow()
    workflow._decision = {
        "decision": "approve",
        "resident_id": "res_12_persia",
        "note": None,
    }

    result = (
        await workflow.run(
            visitor_arrival.VisitorArrivalInput(
                visit_id="visit_0001",
                snapshot_url="https://example.invalid/door.jpg",
            )
        )
    )["result"]

    assert result["decision"] == "approve"
    assert "door is open" in result["reply"]


async def test_missing_fixture_is_actionable() -> None:
    settings = config.load_settings()
    with pytest.raises(replay.FixtureMissing) as excinfo:
        replay.load_fixture(settings, "does-not-exist")
    assert "does-not-exist" in str(excinfo.value)


def test_every_fixture_is_valid_json() -> None:
    files = sorted(FIXTURES.glob("*.json"))
    assert files, "fixtures directory should not be empty"
    for path in files:
        json.loads(path.read_text(encoding="utf-8"))


async def test_api_client_refuses_real_calls_without_a_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    with pytest.raises(Exception):
        await api.notify_resident(config.load_settings(), {"flat": "12"})
