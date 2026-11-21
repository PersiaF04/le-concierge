"""Model calls for the cctv-event workflow.

Three steps, each one model call:

* the vision model describes who is in a CCTV segment and what they did;
* the decision model gives each person a stable label ("Rob Finean",
  "Unknown person 4", "Delivery courier 5");
* the decision model writes one past-tense log line and picks its kind.

The client helpers come from ``mistral_ai``. Every function falls back to a
recorded fixture when ``WORKFLOWS_REPLAY=1``, and names its model either way so
Studio shows which model answered.
"""

from __future__ import annotations

import json
from typing import Any

from ..config import Settings
from .mistral_ai import _client, _parse_json, _should_record, _text_of
from .replay import load_fixture, save_fixture

MAX_FRAMES = 6
KINDS = ("arrival", "departure", "delivery", "doorbell", "lift", "tailgate", "other")


def _model_of(response: Any, fallback: str) -> str:
    return getattr(response, "model", None) or fallback


def _ask_json(settings: Settings, model: str, content: Any, fixture_key: str) -> dict[str, Any]:
    response = _client(settings).chat.complete(
        model=model,
        messages=[{"role": "user", "content": content}],
        temperature=0,
        response_format={"type": "json_object"},
    )
    result = _parse_json(_text_of(response))
    if not isinstance(result, dict):
        result = {"raw": result}
    if _should_record():
        save_fixture(settings, fixture_key, result)
    return {**result, "model": _model_of(response, model)}


async def describe_frames(settings: Settings, camera: str, frames: list[str]) -> dict[str, Any]:
    """Vision: the people in the frames, what they wore, carried and did."""

    if settings.replay:
        return {**load_fixture(settings, "cctv_describe"), "model": settings.vision_model, "replay": True}

    prompt = (
        f"These are up to {MAX_FRAMES} frames, in time order, from the '{camera}' "
        "CCTV camera of a residential building. Describe every person you can "
        "see for a concierge log. Do not guess names or identities. Return JSON "
        'with the key "people": a list of {"appearance": string (clothing, '
        'build, hair), "carrying": list of strings, "actions": list of strings '
        '(in order), "direction": "in"|"out"|"passing"|"unknown", '
        '"interactions": list of strings (doorbell, fob, lift, package, door, '
        'followed someone in)}. If no person is visible, return {"people": []}.'
    )
    content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    content += [{"type": "image_url", "image_url": {"url": url}} for url in frames[:MAX_FRAMES]]
    return _ask_json(settings, settings.vision_model, content, "cctv_describe")


async def label_people(
    settings: Settings,
    people: list[dict[str, Any]],
    known_people: list[dict[str, Any]],
    recent_events: list[str],
) -> dict[str, Any]:
    """Decision model: one stable label per person seen."""

    if settings.replay:
        return {**load_fixture(settings, "cctv_label"), "model": settings.decision_model, "replay": True}

    prompt = (
        "You keep the CCTV log for a residential concierge. Give each person "
        "seen a stable label. If a person clearly matches a known resident's "
        "description, use the resident's name and resident_id. Otherwise use "
        '"Delivery courier N" for couriers and "Unknown person N" for anyone '
        "else, reusing the exact label from the recent events when the "
        "appearance matches, and otherwise taking the next unused number. "
        'Return JSON with the key "people": a list, in the same order as the '
        'people seen, of {"label": string, "resident_id": string|null, '
        '"reason": string}.\n\n'
        f"People seen:\n{json.dumps(people, indent=2)}\n\n"
        f"Known residents:\n{json.dumps(known_people, indent=2)}\n\n"
        f"Recent events:\n{json.dumps(recent_events, indent=2)}"
    )
    return _ask_json(settings, settings.decision_model, prompt, "cctv_label")


async def write_event(settings: Settings, context: dict[str, Any]) -> dict[str, Any]:
    """Decision model: one concise past-tense log line and its kind."""

    if settings.replay:
        result = {**load_fixture(settings, "cctv_event"), "model": settings.decision_model, "replay": True}
    else:
        prompt = (
            "Write one concise, past-tense CCTV log line for a concierge, using "
            "the labels given. Examples:\n"
            '- "Delivery courier 5 rang 3 doorbells, then was let in and entered"\n'
            '- "Unknown person 4 rang a doorbell, waited 50s and went away again"\n'
            '- "Rob Finean entered the building with a key fob"\n'
            '- "Unknown person 4 tailgated into the building"\n'
            "Pick the kind: one of " + ", ".join(KINDS) + ". Tailgating wins "
            'over arrival. Return JSON {"text": string (max 160 chars), '
            '"kind": string}.\n\n'
            f"Context:\n{json.dumps(context, indent=2, sort_keys=True)}"
        )
        result = _ask_json(settings, settings.decision_model, prompt, "cctv_event")
    if result.get("kind") not in KINDS:
        result["kind"] = "other"
    return result
