"""Model calls used by the activities.

Four jobs:

* the vision model describes the door and reads parcel labels - it never
  identifies anyone;
* Voxtral transcribes the intercom audio and speaks the reply at the door;
* the decision model (``DECISION_MODEL``, Small by default) makes the live
  door decision, where a visitor is waiting;
* Le Chonk (``CHONK_MODEL``, Mistral Large 4) writes the parcel notice and
  the digest, and reviews CCTV events, where latency does not matter.

Every function falls back to a recorded fixture when ``WORKFLOWS_REPLAY=1``.
"""

from __future__ import annotations

import base64
import json
import math
import struct
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
    """Pull plain text out of a chat completion, whatever the SDK shape.

    Content is either a string or a list of typed parts, depending on the model
    and on whether the answer was written by the SDK or typed by hand.
    """

    try:
        content = response.choices[0].message.content
    except (AttributeError, IndexError, TypeError):  # pragma: no cover - defensive
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, (list, tuple)):
        parts: list[str] = []
        for chunk in content:
            if isinstance(chunk, str):
                parts.append(chunk)
            elif isinstance(chunk, dict):
                parts.append(str(chunk.get("text") or chunk.get("content") or ""))
            else:
                parts.append(str(getattr(chunk, "text", "") or ""))
        return "".join(parts)
    return str(content or "")


def _parse_json(text: Any) -> dict[str, Any]:
    if not isinstance(text, str):
        text = json.dumps(text) if isinstance(text, (dict, list)) else str(text)
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


_AUDIO_EXTENSIONS = {
    "audio/webm": "webm",
    "video/webm": "webm",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
    "audio/mp4": "mp4",
    "video/mp4": "mp4",
}


def _decode_data_url(audio_url: str) -> dict[str, Any] | None:
    """Turn a browser recording sent as ``data:<mime>;base64,...`` into an upload.

    Mistral cannot fetch a ``data:`` URL, so the bytes go up as a file. Returns
    ``None`` when the URL is malformed or carries no audio.
    """

    header, sep, body = audio_url.partition(",")
    if not sep or ";base64" not in header:
        return None
    mime = header[len("data:"):].split(";", 1)[0].strip().lower()
    try:
        content = base64.b64decode(body)
    except (ValueError, TypeError):
        return None
    if not content:
        return None
    extension = _AUDIO_EXTENSIONS.get(mime, "webm")
    return {
        "file_name": f"intercom.{extension}",
        "content": content,
        "content_type": mime or f"audio/{extension}",
    }


async def transcribe_intercom_audio(
    settings: Settings,
    audio_url: str,
) -> dict[str, Any]:
    """Voxtral: what the visitor said at the intercom."""

    if settings.replay:
        return load_fixture(settings, "transcribe")

    if audio_url.startswith("data:"):
        upload = _decode_data_url(audio_url)
        if upload is None:
            return {"text": ""}
        response = _client(settings).audio.transcriptions.complete(
            model=settings.transcription_model,
            file=upload,
        )
    else:
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
    """The live door decision (DECISION_MODEL): who the visitor is for, what to say."""

    fixture_key = context.get("fixture_key", "chonk_visitor")
    if settings.replay:
        # Studio shows the activity output, so name the model on replays too.
        return {**load_fixture(settings, fixture_key), "model": settings.decision_model, "replay": True}

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
    # The model that answered, as Mistral reports it, so decide_visit shows it in Studio.
    return {**result, "model": getattr(response, "model", None) or settings.decision_model}


def chonk_complete(settings: Settings, **kwargs: Any) -> Any:
    """One chat call to Le Chonk, with reasoning limited when configured."""

    if settings.chonk_reasoning_effort:
        kwargs["reasoning_effort"] = settings.chonk_reasoning_effort
    return _client(settings).chat.complete(model=settings.chonk_model, **kwargs)


def chonk_facts(settings: Settings, response: Any = None) -> dict[str, Any]:
    """The model and reasoning effort, so Studio shows Le Chonk on the step."""

    return {
        "model": getattr(response, "model", None) or settings.chonk_model,
        "reasoning_effort": settings.chonk_reasoning_effort,
    }


async def chonk_write(
    settings: Settings,
    instruction: str,
    context: dict[str, Any],
    fixture_key: str,
) -> dict[str, Any]:
    """Le Chonk: write resident-facing copy (parcel notice, digest).

    Returns ``{text, model, reasoning_effort}``; a replay adds ``replay: True``.
    """

    if settings.replay:
        text_value = load_fixture(settings, fixture_key)["text"]
        return {"text": text_value, **chonk_facts(settings), "replay": True}

    response = chonk_complete(
        settings,
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
    return {"text": text_value, **chonk_facts(settings, response)}


def _peak_dbfs(samples: list[int]) -> float | None:
    """The loudest sample in dBFS. Silence has no peak, so it has no number."""

    peak = max((abs(value) for value in samples), default=0)
    if not peak:
        return None
    return round(20 * math.log10(peak / 32768), 1)


def normalise_wav(raw: bytes, target_peak_dbfs: float) -> tuple[bytes, dict[str, Any]]:
    """Raise a 16-bit wav to a target peak, and report what it did.

    A realtime Voxtral stream is a wav whose header chunks arrive as deltas, so
    the headers are walked rather than trusted: only the samples inside the data
    chunk are touched, and the gain is capped at +18 dB so a quiet tail does not
    become hiss. Every number returned here is measured, never assumed.
    """

    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WAVE":
        return raw, {"normalised": False, "reason": "not a wav"}

    pos = 12
    data_start: int | None = None
    data_size = 0
    bits = 16
    while pos + 8 <= len(raw):
        chunk_id = raw[pos : pos + 4]
        size = int.from_bytes(raw[pos + 4 : pos + 8], "little")
        if chunk_id == b"fmt " and pos + 24 <= len(raw):
            bits = int.from_bytes(raw[pos + 22 : pos + 24], "little")
        if chunk_id == b"data":
            data_start = pos + 8
            # A streamed wav often declares 0xFFFFFFFF: the data runs to the end.
            data_size = (
                len(raw) - data_start
                if size in (0, 0xFFFFFFFF)
                else min(size, len(raw) - data_start)
            )
            break
        pos += 8 + size + (size & 1)

    if data_start is None or bits != 16 or data_size < 2:
        return raw, {"normalised": False, "reason": "no 16-bit data chunk"}

    count = data_size // 2
    samples = list(struct.unpack_from(f"<{count}h", raw, data_start))
    before = _peak_dbfs(samples)
    if before is None:
        return raw, {"normalised": False, "reason": "silence"}

    peak = max(abs(sample) for sample in samples)
    gain = min((10 ** (target_peak_dbfs / 20)) * 32768 / peak, 10 ** (18 / 20))
    if gain <= 1.01:
        return raw, {"normalised": False, "peak_dbfs": before, "gain_db": 0.0}

    scaled = [max(-32768, min(32767, round(sample * gain))) for sample in samples]
    out = bytearray(raw)
    struct.pack_into(f"<{count}h", out, data_start, *scaled)
    return bytes(out), {
        "normalised": True,
        "peak_dbfs_before": before,
        "peak_dbfs": _peak_dbfs(scaled),
        "gain_db": round(20 * math.log10(gain), 1),
    }


def _apply_loudness(settings: Settings, result: dict[str, Any]) -> dict[str, Any]:
    """Peak-normalise the wav in place and return the loudness facts."""

    encoded = result.get("audio_base64") or ""
    if not encoded:
        return {}
    raw = base64.b64decode(encoded)
    boosted, facts = normalise_wav(raw, settings.speech_target_peak_dbfs)
    if facts.get("normalised"):
        result["audio_base64"] = base64.b64encode(boosted).decode("ascii")
        result["audio_bytes"] = len(boosted)
    return facts


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
    result.update(_apply_loudness(settings, result))
    if _should_record():
        # The wav is a hundred kilobytes of base64: the fixture keeps the facts
        # (model, voice, chunk timings, gain) and drops the audio itself.
        save_fixture(settings, "speech", {**result, "audio_base64": ""})
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
    result.update(_apply_loudness(settings, result))
    if _should_record():
        # The wav is a hundred kilobytes of base64: the fixture keeps the facts
        # (model, voice, chunk timings, gain) and drops the audio itself.
        save_fixture(settings, "speech", {**result, "audio_base64": ""})
    return result
