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
    assert choice["model"]  # decide_visit names the decision model in Studio

    visited = await visitor_arrival.post_visit({"visit_id": "visit_0001"})
    assert visited["status"] == "pending_resident"

    spoken = await visitor_arrival.speak_reply({"text": "Come in, 12."})
    assert spoken["played"] is True
    # The output names the model, the transport and how much audio it made:
    # that is what proves which Voxtral path ran, rather than a fixture.
    assert spoken["model"].startswith("voxtral-mini-tts")
    assert spoken["transport"] == "realtime"
    assert spoken["audio_bytes"] > 0
    assert spoken["chunks"] >= 1

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


class _FakeTranscriptions:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    def complete(self, **kwargs):
        self.calls.append(kwargs)
        return type("Response", (), {"text": "parcel for flat twelve"})()


def _fake_client(monkeypatch: pytest.MonkeyPatch) -> _FakeTranscriptions:
    from worker.shared import mistral_ai

    transcriptions = _FakeTranscriptions()
    client = type("Client", (), {})()
    client.audio = type("Audio", (), {"transcriptions": transcriptions})()
    monkeypatch.setattr(mistral_ai, "_client", lambda settings: client)
    return transcriptions


@pytest.mark.parametrize(
    ("mime", "extension"),
    [
        ("audio/webm;codecs=opus", "webm"),
        ("audio/ogg;codecs=opus", "ogg"),
        ("audio/wav", "wav"),
        ("audio/mp4", "mp4"),
    ],
)
async def test_transcribe_uploads_data_url_audio(
    monkeypatch: pytest.MonkeyPatch, mime: str, extension: str
) -> None:
    import base64

    from worker.shared import mistral_ai

    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    transcriptions = _fake_client(monkeypatch)
    audio = b"\x1aE\xdf\xa3fake-recording"
    url = f"data:{mime};base64," + base64.b64encode(audio).decode("ascii")

    settings = config.load_settings()
    result = await mistral_ai.transcribe_intercom_audio(settings, url)

    assert result == {"text": "parcel for flat twelve"}
    (call,) = transcriptions.calls
    assert call["model"] == settings.transcription_model
    assert "file_url" not in call
    assert call["file"]["content"] == audio
    assert call["file"]["file_name"] == f"intercom.{extension}"
    assert call["file"]["content_type"] == mime.split(";")[0]


@pytest.mark.parametrize("url", ["data:audio/webm;base64,", "data:audio/webm;base64,@@@", "data:audio/webm,raw"])
async def test_transcribe_empty_or_bad_data_url_returns_empty(
    monkeypatch: pytest.MonkeyPatch, url: str
) -> None:
    from worker.shared import mistral_ai

    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    transcriptions = _fake_client(monkeypatch)

    result = await mistral_ai.transcribe_intercom_audio(config.load_settings(), url)

    assert result == {"text": ""}
    assert transcriptions.calls == []


async def test_transcribe_keeps_http_urls(monkeypatch: pytest.MonkeyPatch) -> None:
    from worker.shared import mistral_ai

    monkeypatch.setenv("WORKFLOWS_REPLAY", "0")
    transcriptions = _fake_client(monkeypatch)

    await mistral_ai.transcribe_intercom_audio(config.load_settings(), "https://example.invalid/a.webm")

    (call,) = transcriptions.calls
    assert call["file_url"] == "https://example.invalid/a.webm"
    assert "file" not in call
