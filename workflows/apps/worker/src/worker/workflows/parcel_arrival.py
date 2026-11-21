"""The parcel-arrival workflow.

1. read the parcel label with the vision model;
2. match the flat named on the label;
3. let Le Chonk write the notice to the resident;
4. send it on the resident's chosen channel, then log it.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import mistralai.workflows as workflows
from pydantic import BaseModel, Field

from ..config import load_settings
from ..shared import api, mistral_ai


class ParcelArrivalInput(BaseModel):
    parcel_id: str
    snapshot_url: str
    flat: str | None = None
    label_text: str | None = Field(
        default=None,
        description="Set when the concierge already read the label by hand.",
    )
    resident_id: str | None = None


@workflows.activity(start_to_close_timeout=timedelta(seconds=90), retry_policy_max_attempts=3)
async def read_label(snapshot_url: str) -> dict[str, Any]:
    """Vision: read the label off the parcel. It does not identify people."""

    return await mistral_ai.describe_scene(load_settings(), snapshot_url, parcels_visible=True)


@workflows.activity(start_to_close_timeout=timedelta(seconds=15), retry_policy_max_attempts=1)
async def match_flat(label_text: str | None, fallback_flat: str | None) -> dict[str, Any]:
    """Pull the flat number out of the label, preferring what the label says."""

    candidate = (label_text or "").strip()
    flat = fallback_flat
    if candidate:
        # Labels look like "FLAT 12" or "Apt. 12B" or a bare number.
        tokens = [token.strip(" ,.;:#") for token in candidate.replace("FLAT", " ").replace("APT", " ").split()]
        tokens = [token for token in tokens if token]
        numbers = [token for token in tokens if any(char.isdigit() for char in token)]
        if numbers:
            flat = numbers[-1]
    return {"flat": flat, "source": "label" if candidate and flat != fallback_flat else "input"}


@workflows.activity(start_to_close_timeout=timedelta(seconds=120), retry_policy_max_attempts=3)
async def write_notice(context: dict[str, Any]) -> str:
    """Le Chonk: the one-line notice the resident reads."""

    instruction = (
        "Write one short, friendly notification (max 200 characters) telling a "
        "resident a parcel is waiting for them at the concierge desk. Mention "
        "the flat and the courier if known. No greetings longer than one word."
    )
    return await mistral_ai.chonk_write(load_settings(), instruction, context, "chonk_parcel")


@workflows.activity(start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def notify(notification: dict[str, Any]) -> dict[str, Any]:
    """The API fans out to the resident's channel: email or SMS plus in-app.

    Anonymous residents only ever get the in-app notification.
    """

    return await api.notify_resident(load_settings(), notification)


@workflows.activity(name="parcel_log_event", start_to_close_timeout=timedelta(seconds=30), retry_policy_max_attempts=5)
async def log_event(event: dict[str, Any]) -> dict[str, Any]:
    return await api.log_event(load_settings(), event)


@workflows.workflow.define(
    name="parcel-arrival",
    workflow_display_name="Parcel arrival",
    workflow_description=(
        "Reads the parcel label, matches the flat, has Le Chonk write the "
        "notice, then notifies the resident on their chosen channel."
    ),
)
class ParcelArrivalWorkflow:
    def __init__(self) -> None:
        self._ready = True

    @workflows.workflow.entrypoint
    async def run(self, input: ParcelArrivalInput) -> dict[str, Any]:
        scene = await read_label(input.snapshot_url)
        labels = scene.get("parcels") or []
        first_label = labels[0] if labels else {}
        label_text = input.label_text or first_label.get("label_text")

        flat = await match_flat(label_text, input.flat)
        context = {
            "parcel_id": input.parcel_id,
            "flat": flat,
            "label_text": label_text,
            "courier": first_label.get("courier"),
            "scene": scene.get("scene"),
        }
        message = await write_notice(context)

        notification = {
            "parcel_id": input.parcel_id,
            "resident_id": input.resident_id,
            "flat": flat["flat"],
            "title": "Parcel waiting",
            "body": message,
            "channels": "resident_choice",
            "anonymous_fallback": "in_app",
        }
        delivered = await notify(notification)

        result = {
            "parcel_id": input.parcel_id,
            "flat": flat["flat"],
            "parcel_source": flat["source"],
            "label_text": label_text,
            "courier": first_label.get("courier"),
            "message": message,
            "delivered": delivered,
            "resident_id": input.resident_id,
        }
        await log_event({"type": "parcel.arrival", **result})
        return result
