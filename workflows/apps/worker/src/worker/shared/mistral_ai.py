"""Model calls used by the activities.

Three jobs, three models:

* the vision model describes the door and reads parcel labels - it never
  identifies anyone;
* Voxtral transcribes the intercom audio and speaks the reply at the door;
* Le Chonk (Mistral Large) makes the access decision and writes the copy.

Every function falls back to a recorded fixture when ``WORKFLOWS_REPLAY=1``.
"""

from __future__ import annotations

import base64
import json
from typing import Any

from ..config import Settings, require_api_key
from .replay import load_fixture, save_fixture

_RECORD = {"1", "true", "yes", "on"}


def _client(settings: Settings) -> Any:
    # Lazy import: the workflow sandbox imports this module but refuses
    # non-deterministic imports (the Mistral client opens sockets) at import time.
    from mistralai.client import Mistral

    return Mistral(api_key=require_api_key(settings))


def _should_record() -> bool:
    import os

    return os.getenv("WORKFLOWS_RECORD", "0").strip().lower() in _RECORD


def _text_of(response: Any) -> str:
    """Pull plain text out of a chat completion, whatever the SDK shape."""

    try:
        return response.choices[0].message.content or ""
    except (AttributeError, IndexError, TypeError):  # pragma: no cover - defensive
        return ""


def _parse_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1].rsplit("```", 1)[0]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        return {"raw": text}


async def describe_scene(
    settings: Settings,
    snapshot_url: str,
    parcels_visible: bool = False,
) -> dict[str, Any]:
    """Mistral vision: what is at the door, and any label it can read."""

    key = "vision_parcel" if parcels_visible else "vision_door"
    if settings.replay:
        return load_fixture(settings, key)

    prompt = (
        "Describe this intercom snapshot for a concierge log: who or what is "
        "in frame, how many people, any uniform or badge, and any parcels. "
        "Do not guess identities. Return JSON with the keys "
        'people_visible (int), scene (string), parcels (list of '
        '{"label_text": string, "courier": string|null}).'
    )
    response = _client(settings).chat.complete(
        model=settings.vision_model,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": snapshot_url}},
                ],
            }
        ],
        temperature=0,
        response_format={"type": "json_object"},
    )
    result = _parse_json(_text_of(response))
    if _should_record():
        save_fixture(settings, key, result)
    return result


async def transcribe_intercom_audio(
    settings: Settings,
    audio_url: str,
) -> dict[str, Any]:
    """Voxtral: what the visitor said at the intercom."""

    if settings.replay:
        return load_fixture(settings, "transcribe")

    response = _client(settings).audio.transcriptions.complete(
        model=settings.transcription_model,
        file_url=audio_url,
    )
    text = getattr(response, "text", "") or ""
    result = {"text": text}
    if _should_record():
        save_fixture(settings, "transcribe", result)
    return result


async def chonk_decide(
    settings: Settings,
    context: dict[str, Any],
) -> dict[str, Any]:
    """Le Chonk: who the visitor is for, and what to say."""

    fixture_key = context.get("fixture_key", "chonk_visitor")
    if settings.replay:
        return load_fixture(settings, fixture_key)

    prompt = (
        "You are Le Chonk, the decision maker for a residential intercom. "
        "Decide who this visitor is for and what the intercom should say. "
        "Use only the context given; never invent a resident. If the flat is "
        "unknown, pick the most likely flat from the transcript and mark "
        "confidence accordingly. Return JSON with the keys "
        "flat (string|null), resident_id (string|null), confidence (0-1), "
        "action (ask|allow|deny), and reply_text (string, at most 160 chars).\n\n"
        f"Context:\n{json.dumps(context, indent=2, sort_keys=True)}"
    )
    response = _client(settings).chat.complete(
        model=settings.decision_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0.2,
        response_format={"type": "json_object"},
    )
    result = _parse_json(_text_of(response))
    if _should_record():
        save_fixture(settings, fixture_key, result)
    return result


async def chonk_write(
    settings: Settings,
    instruction: str,
    context: dict[str, Any],
    fixture_key: str,
) -> str:
    """Le Chonk: write resident-facing copy (parcel notice, digest)."""

    if settings.replay:
        return load_fixture(settings, fixture_key)["text"]

    response = _client(settings).chat.complete(
        model=settings.decision_model,
        messages=[
            {
                "role": "user",
                "content": (
                    f"{instruction}\n\nContext:\n"
                    f"{json.dumps(context, indent=2, sort_keys=True)}"
                ),
            }
        ],
        temperature=0.3,
    )
    text_value = _text_of(response).strip()
    if _should_record():
        save_fixture(settings, fixture_key, {"text": text_value})
    return text_value


async def synthesize_reply(settings: Settings, text_value: str) -> dict[str, Any]:
    """Voxtral text to speech: the audio the intercom plays."""

    if settings.replay:
        return load_fixture(settings, "speech")

    response = _client(settings).audio.speech.complete(
        model=settings.speech_model,
        input=text_value,
        voice_id=settings.speech_voice_id,
    )
    audio = getattr(response, "audio_data", None) or getattr(response, "audio", None)
    if isinstance(audio, str):
        encoded = audio
    elif isinstance(audio, (bytes, bytearray)):
        encoded = base64.b64encode(bytes(audio)).decode("ascii")
    else:  # pragma: no cover - shape depends on the SDK version
        encoded = ""
    result = {"text": text_value, "audio_base64": encoded}
    if _should_record():
        save_fixture(settings, "speech", result)
    return result
