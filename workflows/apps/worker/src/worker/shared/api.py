"""HTTP client for the Le Concierge Node API.

Activities are the only place side effects happen, so all API traffic goes
through here. In replay mode the call is served from a recorded fixture.
"""

from __future__ import annotations

import os
from typing import Any

from ..config import Settings
from .replay import load_fixture, save_fixture


class ApiError(RuntimeError):
    """A non-2xx answer from the Le Concierge API."""


async def _request(
    settings: Settings,
    method: str,
    path: str,
    payload: dict[str, Any] | None,
    fixture_key: str,
    timeout: float = 15.0,
) -> Any:
    if settings.replay:
        return load_fixture(settings, fixture_key)

    # Imported lazily: workflow modules import this module, and the workflow
    # sandbox refuses non-deterministic imports such as httpx at import time.
    import httpx

    url = f"{settings.api_base_url}{path}"
    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await client.request(method, url, json=payload)

    if response.status_code >= 400:
        raise ApiError(f"{method} {url} -> {response.status_code}: {response.text[:500]}")

    body = response.json() if response.content else {}
    if os.getenv("WORKFLOWS_RECORD", "0") in {"1", "true", "yes", "on"}:
        save_fixture(settings, fixture_key, body)
    return body


async def post_visit(settings: Settings, visit: dict[str, Any]) -> Any:
    """POST /visits - the API stores it and pushes it to the resident over WS."""

    return await _request(settings, "POST", "/visits", visit, "api_post_visit")


async def log_event(settings: Settings, event: dict[str, Any]) -> Any:
    """POST /events - append to the visit timeline."""

    return await _request(settings, "POST", "/events", event, "api_log_event")


async def speak_at_intercom(settings: Settings, reply: dict[str, Any]) -> Any:
    """POST /intercom/speak - play the answer at the door."""

    return await _request(settings, "POST", "/intercom/speak", reply, "api_speak")


async def notify_resident(settings: Settings, notification: dict[str, Any]) -> Any:
    """POST /notifications - the API fans out to the resident's chosen channel."""

    return await _request(settings, "POST", "/notifications", notification, "api_notify")


async def list_events(settings: Settings, flat: str | None, day: str) -> Any:
    """GET /events - used by the nightly digest."""

    query = f"?day={day}" + (f"&flat={flat}" if flat else "")
    return await _request(settings, "GET", f"/events{query}", None, "api_list_events")


async def match_resident(settings: Settings, face: dict[str, Any]) -> Any:
    """POST /faces/match - the API owns the descriptor store."""

    return await _request(settings, "POST", "/faces/match", face, "api_match_face")
