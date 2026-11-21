"""The visitor-arrival workflow.

One execution per person at the door:

1. describe the snapshot with the vision model;
2. match the face result the concierge app sent in (face-api.js descriptors,
   opted-in residents only);
3. transcribe what the visitor said at the intercom with Voxtral;
4. ask Le Chonk who it is for and what to say;
5. post the visit so the API pushes it to the resident over WS /live;
6. wait for the resident's decision signal, declining on timeout;
7. speak the reply at the door and log the outcome.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from pydantic import BaseModel, Field

from ..config import DEFAULT_DECISION_TIMEOUT_SECONDS, load_settings
from ..shared import api, mistral_ai


class VisitorArrivalInput(BaseModel):
    """Everything the Node API knows when MediaPipe fires."""

    visit_id: str
    snapshot_url: str
    flat: str | None = None
    audio_url: str | None = None
    face: dict[str, Any] = Field(
        default_factory=dict,
        description="Face result from the concierge app: descriptors and the "
        "opted-in resident the descriptor matched, if any.",
    )
    decision_timeout_seconds: float | None = None


def _execution_id() -> str | None:
    """The current execution id, when running inside the platform."""

    try:
        return workflows.get_execution_id()
    except Exception:  # pragma: no cover - outside a workflow context
        return None


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def describe_snapshot(snapshot_url: str) -> dict[str, Any]:
    """Vision: describe the door. This never identifies anyone."""

    return await mistral_ai.describe_scene(load_settings(), snapshot_url)


@workflows.activity(start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=3)
async def match_face(face: dict[str, Any]) -> dict[str, Any]:
    """Store the face result and resolve it against the descriptor store.

    The descriptor itself is produced on the concierge device by face-api.js.
    The API only holds descriptors of residents who tapped "that was me".
    """

    settings = load_settings()
    if not face or not face.get("descriptor"):
        return {"matched": False, "resident_id": None, "distance": None}
    return await api.match_resident(settings, face)


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def transcribe_intercom_audio(audio_url: str | None) -> dict[str, Any]:
    """Voxtral: the visitor's words."""

    if not audio_url:
        return {"text": ""}
    return await mistral_ai.transcribe_intercom_audio(load_settings(), audio_url)


@workflows.activity(start_to_close_timeout=timedelta(seconds=120), retry_policy_max_attempts=3)
async def decide_visit(context: dict[str, Any]) -> dict[str, Any]:
    """Le Chonk: who it is for, and what the intercom should say."""

    return await mistral_ai.chonk_decide(load_settings(), context)


@workflows.activity(start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def post_visit(visit: dict[str, Any]) -> dict[str, Any]:
    """Hand the visit to the API, which notifies the resident over WS /live."""

    return await api.post_visit(load_settings(), visit)


@workflows.activity(name="speak_reply", start_to_close_timeout=timedelta(seconds=60), retry_policy_max_attempts=3)
async def speak_reply(reply: dict[str, Any]) -> dict[str, Any]:
    """Voxtral text to speech, played at the door.

    Returns the TTS facts (model, voice, audio_bytes) next to the playback
    result, so an execution output shows whether Voxtral actually ran.
    """

    settings = load_settings()
    audio = await mistral_ai.synthesize_reply(settings, reply["text"])
    played = await api.speak_at_intercom(settings, audio)
    return {
        "text": audio.get("text"),
        "model": audio.get("model"),
        "voice_id": audio.get("voice_id"),
        # "realtime" when the audio arrived as deltas over the websocket,
        # "batch" when the fallback answered. Never guessed.
        "transport": audio.get("transport"),
        "streaming_mode": audio.get("streaming_mode"),
        "chunks": audio.get("chunks"),
        "first_chunk_ms": audio.get("first_chunk_ms"),
        "audio_bytes": audio.get("audio_bytes", 0),
        "played": played.get("played"),
        "duration_ms": played.get("duration_ms"),
    }


@workflows.activity(name="visitor_log_event", start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def log_event(event: dict[str, Any]) -> dict[str, Any]:
    return await api.log_event(load_settings(), event)


@workflows.workflow.define(
    name="visitor-arrival",
    workflow_display_name="Visitor arrival",
    workflow_description=(
        "Describes the snapshot, matches the opted-in resident, transcribes the "
        "intercom, lets Le Chonk decide, waits for the resident's decision "
        "signal, then speaks and logs the reply."
    ),
)
class VisitorArrivalWorkflow:
    def __init__(self) -> None:
        self._decision: dict[str, Any] | None = None

    @workflows.workflow.signal(name="resident-decision")
    async def on_resident_decision(
        self,
        decision: str,
        resident_id: str | None = None,
        note: str | None = None,
    ) -> None:
        """Sent by POST /visits/{id}/decision."""

        self._decision = {
            "decision": str(decision).lower(),
            "resident_id": resident_id,
            "note": note,
        }

    @workflows.workflow.entrypoint
    async def run(self, input: VisitorArrivalInput) -> dict[str, Any]:
        # Workflow code stays deterministic: no env reads, no file I/O. The
        # timeout default is a constant, and every side effect is an activity.
        timeout_seconds = input.decision_timeout_seconds or DEFAULT_DECISION_TIMEOUT_SECONDS
        execution_id = _execution_id()

        scene = await describe_snapshot(input.snapshot_url)
        face = await match_face(input.face)
        transcript = await transcribe_intercom_audio(input.audio_url)

        context = {
            "visit_id": input.visit_id,
            "flat_hint": input.flat,
            "scene": scene,
            "face": face,
            "transcript": transcript,
            "fixture_key": "chonk_visitor",
        }
        choice = await decide_visit(context)

        visit = {
            "visit_id": input.visit_id,
            "execution_id": execution_id,
            "flat": choice.get("flat") or input.flat,
            "resident_id": choice.get("resident_id") or face.get("resident_id"),
            "scene": scene,
            "transcript": transcript,
            "face_matched": bool(face.get("matched")),
            "proposed_reply": choice.get("reply_text", ""),
            "recognition": "face-api.js descriptor match, opted-in residents only",
        }
        await post_visit(visit)

        outcome: dict[str, Any]
        try:
            await workflows.workflow.wait_condition(
                lambda: self._decision is not None,
                timeout=timedelta(seconds=timeout_seconds),
                timeout_summary="resident-decision",
            )
            outcome = dict(self._decision or {})
        except asyncio.TimeoutError:
            outcome = {"decision": "decline", "note": "timed out", "automatic": True}

        approved = outcome.get("decision") == "approve"
        reply_text = (
            f"Come in, {choice.get('flat') or 'please'}. The door is open."
            if approved
            else "Sorry, no answer right now. Please try again later."
        )
        await speak_reply({"text": reply_text, "visit_id": input.visit_id})

        result = {
            "visit_id": input.visit_id,
            "execution_id": execution_id,
            "decision": outcome.get("decision", "decline"),
            "decided_by": outcome.get("resident_id"),
            "flat": visit["flat"],
            "reply": reply_text,
            "confidence": choice.get("confidence"),
            "transcript": transcript.get("text", ""),
        }
        await log_event({"type": "visit.decision", **result})
        return result
