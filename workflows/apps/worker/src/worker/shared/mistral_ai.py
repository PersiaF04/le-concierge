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
    """Voxtral text to speech: the audio the intercom plays.

    The reply is spoken over Voxtral's realtime endpoint, so the first audio
    delta reaches the door while the sentence is still being generated. The
    batch endpoint stays as the fallback, and ``transport`` names which one
    answered, so an execution output never has to guess.
    """

    if settings.replay:
        return load_fixture(settings, "speech")

    if settings.speech_realtime:
        try:
            return await _synthesize_realtime(settings, text_value)
        except Exception as exc:  # noqa: BLE001 - the batch endpoint is the fallback
            batched = await _synthesize_batch(settings, text_value)
            batched["fallback_reason"] = f"{type(exc).__name__}: {exc}"[:200]
            return batched
    return await _synthesize_batch(settings, text_value)


async def _synthesize_realtime(settings: Settings, text_value: str) -> dict[str, Any]:
    """Stream the reply over one websocket: text in, audio deltas out."""

    import time

    from mistralai.client import Mistral

    client = Mistral(api_key=require_api_key(settings))
    started = time.perf_counter()
    connection = await client.audio.realtime_speech.connect(
        model=settings.speech_model,
        voice_id=settings.speech_voice_id,
    )
    session = connection.session
    buffer = bytearray()
    chunks = 0
    first_chunk_ms: float | None = None
    try:
        await connection.send_text(text_value)
        await connection.end()
        async for event in connection:
            kind = getattr(event, "type", None)
            if kind == "speech.audio.delta":
                buffer.extend(base64.b64decode(event.audio_data))
                if first_chunk_ms is None:
                    first_chunk_ms = round((time.perf_counter() - started) * 1000, 1)
                chunks += 1
            elif kind == "speech.audio.done":
                break
            elif kind == "error":
                raise RuntimeError(f"realtime speech error: {getattr(event, 'message', event)}")
    finally:
        await connection.close()

    voice = getattr(session, "voice", None)
    result = {
        "text": text_value,
        "model": getattr(session, "model", None) or settings.speech_model,
        "voice_id": voice if isinstance(voice, str) and voice else settings.speech_voice_id,
        "transport": "realtime",
        "streaming_mode": str(getattr(session, "streaming_mode", "responsive")),
        "response_format": str(getattr(session, "response_format", "wav")),
        "chunks": chunks,
        "first_chunk_ms": first_chunk_ms,
        "audio_base64": base64.b64encode(bytes(buffer)).decode("ascii") if buffer else "",
        # Bytes of audio actually synthesized: the number that shows, in an
        # activity output, whether the speech model ran or a fixture answered.
        "audio_bytes": len(buffer),
    }
    if _should_record():
        save_fixture(settings, "speech", result)
    return result


async def _synthesize_batch(settings: Settings, text_value: str) -> dict[str, Any]:
    """One request, one file. Used when the realtime socket is unavailable."""

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
    try:
        decoded_bytes = len(base64.b64decode(encoded)) if encoded else 0
    except (ValueError, TypeError):  # pragma: no cover - defensive
        decoded_bytes = 0
    result = {
        "text": text_value,
        "model": settings.speech_model,
        "voice_id": settings.speech_voice_id,
        "transport": "batch",
        "chunks": 1 if encoded else 0,
        "first_chunk_ms": None,
        "audio_base64": encoded,
        "audio_bytes": decoded_bytes,
    }
    if _should_record():
        save_fixture(settings, "speech", result)
    return result
