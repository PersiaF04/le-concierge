"""The cctv-event workflow.

One execution per CCTV segment the browser's MediaPipe gate sent in (a person
was in view). It logs one event per meaningful moment, and discards the
segment when the frames show nobody:

1. describe the frames with the vision model;
2. give each person a stable label: a resident's name when the description
   matches, otherwise "Unknown person N" or "Delivery courier N";
3. write one past-tense log line and its kind;
4. Le Chonk (Mistral Large 4) reviews it against the recent events and flags
   anything suspicious: tailgating, loitering, unanswered doorbell rings;
5. log it to the API as ``cctv.<kind>``, review included.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from pydantic import BaseModel, Field

from ..config import load_settings
from ..shared import api, cctv_ai


class KnownPerson(BaseModel):
    name: str
    resident_id: str | None = None
    description: str = ""


class CctvEventInput(BaseModel):
    camera: str = Field(description='Which camera, e.g. "entrance", "lobby", "lift-left".')
    started_at: str
    ended_at: str
    frames: list[str] = Field(
        default_factory=list,
        max_length=cctv_ai.MAX_FRAMES,
        description="Image URLs or data: URLs, in time order.",
    )
    clip_url: str | None = None
    known_people: list[KnownPerson] = Field(default_factory=list)
    recent_events: list[str] = Field(
        default_factory=list,
        description="The last few event lines, so labels carry over.",
    )


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def describe_cctv_frames(camera: str, frames: list[str]) -> dict[str, Any]:
    """Vision: who is in the frames and what they did. Never names anyone."""

    return await cctv_ai.describe_frames(load_settings(), camera, frames)


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def label_people(context: dict[str, Any]) -> dict[str, Any]:
    """Decision model: a stable label per person, reused across events."""

    return await cctv_ai.label_people(
        load_settings(),
        context.get("people") or [],
        context.get("known_people") or [],
        context.get("recent_events") or [],
    )


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def write_event(context: dict[str, Any]) -> dict[str, Any]:
    """Decision model: one concise past-tense log line and its kind."""

    return await cctv_ai.write_event(load_settings(), context)


@workflows.activity(start_to_close_timeout=timedelta(seconds=120), retry_policy_max_attempts=3)
async def chonk_review_event(context: dict[str, Any]) -> dict[str, Any]:
    """Le Chonk: {flag, severity, note} for this event, given the recent ones."""

    return await cctv_ai.chonk_review_event(load_settings(), context)


@workflows.activity(start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def log_cctv_event(event: dict[str, Any]) -> dict[str, Any]:
    return await api.log_event(load_settings(), event)


@workflows.workflow.define(
    name="cctv-event",
    workflow_display_name="CCTV event",
    workflow_description=(
        "Describes a CCTV segment, labels the people in it, writes one "
        "past-tense log line, has Le Chonk flag anything suspicious and logs "
        "it. Discards segments with nobody in them."
    ),
)
class CctvEventWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: CctvEventInput) -> dict[str, Any]:
        segment = {
            "camera": input.camera,
            "started_at": input.started_at,
            "ended_at": input.ended_at,
            "clip_url": input.clip_url,
        }
        if not input.frames:
            return {"discard": True, "reason": "no frames", "event": None, "model": {}}

        seen = await describe_cctv_frames(input.camera, input.frames)
        people = [person for person in seen.get("people") or [] if isinstance(person, dict)]
        models = {"vision": seen.get("model")}
        if not people:
            return {"discard": True, "reason": "no person in frame", "event": None, "model": models}

        labels = await label_people(
            {
                "people": people,
                "known_people": [person.model_dump() for person in input.known_people],
                "recent_events": input.recent_events,
            }
        )
        labelled = labels.get("people") or []
        names = [str(person.get("label")) for person in labelled if person.get("label")]

        written = await write_event(
            {
                **segment,
                "people": [
                    {**seen_person, **label}
                    for seen_person, label in zip(people, labelled)
                ],
                "recent_events": input.recent_events,
            }
        )
        models["decision"] = written.get("model") or labels.get("model")

        event = {
            "text": written.get("text", ""),
            "kind": written.get("kind", "other"),
            "people": names,
            **segment,
        }
        review = await chonk_review_event({**event, "recent_events": input.recent_events})
        models["chonk"] = review.get("model")
        event["review"] = {key: review.get(key) for key in ("flag", "severity", "note")}
        await log_cctv_event({"type": f"cctv.{event['kind']}", **event, "model": models})
        return {"discard": False, "event": event, "model": models}
