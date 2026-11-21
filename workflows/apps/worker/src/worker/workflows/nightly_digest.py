"""The nightly-digest workflow, run on a schedule.

Pulls the day's events from the API, has Le Chonk write the digest, then posts
it to each flat. The schedule is registered with
``client.workflows.schedules.schedule_workflow`` - see scripts/register_schedules.py.
"""

from __future__ import annotations

import datetime as dt
from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from pydantic import BaseModel

from ..config import load_settings
from ..shared import api, mistral_ai


class NightlyDigestInput(BaseModel):
    day: str | None = None
    flat: str | None = None


@workflows.activity(start_to_close_timeout=timedelta(seconds=60), retry_policy_max_attempts=5)
async def fetch_day_events(day: str, flat: str | None) -> dict[str, Any]:
    return await api.list_events(load_settings(), flat, day)


@workflows.activity(start_to_close_timeout=timedelta(seconds=120), retry_policy_max_attempts=3)
async def write_digest(context: dict[str, Any]) -> str:
    instruction = (
        "Write a short end-of-day digest for one flat: who visited, what was "
        "approved or declined, parcels collected and still waiting. Plain text, "
        "max 900 characters, no emoji."
    )
    return await mistral_ai.chonk_write(load_settings(), instruction, context, "chonk_digest")


@workflows.activity(start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def send_digest(digest: dict[str, Any]) -> dict[str, Any]:
    return await api.notify_resident(load_settings(), digest)


@workflows.activity(name="digest_log_event", start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def log_event(event: dict[str, Any]) -> dict[str, Any]:
    return await api.log_event(load_settings(), event)


@workflows.workflow.define(
    name="nightly-digest",
    workflow_display_name="Nightly digest",
    workflow_description=(
        "Pulls the day's events from the API, has Le Chonk write the digest, "
        "then posts it to the resident. Scheduled every evening."
    ),
)
class NightlyDigestWorkflow:
    @workflows.workflow.entrypoint
    async def run(self, input: NightlyDigestInput) -> dict[str, Any]:
        day = input.day or (dt.date.today() - dt.timedelta(days=1)).isoformat()
        events = await fetch_day_events(day, input.flat)
        context = {"day": day, "flat": input.flat, "events": events}
        text = await write_digest(context)

        digest = {
            "flat": input.flat,
            "day": day,
            "title": f"Your day at Le Concierge, {day}",
            "body": text,
            "channels": "resident_choice",
            "anonymous_fallback": "in_app",
        }
        delivered = await send_digest(digest)

        result = {
            "day": day,
            "flat": input.flat,
            "digest": text,
            "event_count": len(events.get("events", [])) if isinstance(events, dict) else 0,
            "delivered": delivered,
        }
        await log_event({"type": "digest.sent", **result})
        return result
