"""Settings for the Le Concierge workflows worker.

Everything is read from the environment so that no secret ever lives in the
repository. ``WORKFLOWS_REPLAY=1`` is the switch that keeps the demo working
without a network or an API key.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

TRUTHY = {"1", "true", "yes", "on"}

# Default timeout for the resident's decision, in seconds. A module constant so
# workflow code never has to read the environment to get a default.
DEFAULT_DECISION_TIMEOUT_SECONDS = 60.0


def default_fixtures_dir() -> Path:
    """Where the recorded activity results live.

    Resolved inside the function, not at import time: the workflow sandbox bans
    ``Path.resolve`` while importing workflow modules.
    """

    # config.py -> worker -> src -> worker -> apps -> workflows
    return Path(__file__).parents[4] / "fixtures"


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    mistral_api_key: str | None
    vision_model: str
    transcription_model: str
    decision_model: str
    speech_model: str
    speech_voice_id: str
    decision_timeout_seconds: float
    replay: bool
    fixtures_dir: Path


def _flag(name: str, default: str = "0") -> bool:
    return os.getenv(name, default).strip().lower() in TRUTHY


def load_settings() -> Settings:
    """Read settings fresh from the environment on every call.

    Reading on every call keeps activities independent: the worker picks up a
    changed value without a restart, and tests can flip ``WORKFLOWS_REPLAY``
    between cases.
    """

    fixtures = os.getenv("WORKFLOWS_FIXTURES_DIR") or str(default_fixtures_dir())
    return Settings(
        api_base_url=os.getenv("LE_CONCIERGE_API_URL", "http://localhost:3000").rstrip("/"),
        mistral_api_key=os.getenv("MISTRAL_API_KEY") or None,
        vision_model=os.getenv("VISION_MODEL", "pixtral-large-latest"),
        transcription_model=os.getenv("TRANSCRIPTION_MODEL", "voxtral-mini-latest"),
        decision_model=os.getenv("DECISION_MODEL", "mistral-large-latest"),
        speech_model=os.getenv("SPEECH_MODEL", "voxtral-mini-tts-latest"),
        speech_voice_id=os.getenv("SPEECH_VOICE_ID", "gb_jane_neutral"),
        decision_timeout_seconds=float(
            os.getenv("VISITOR_DECISION_TIMEOUT_SECONDS", str(DEFAULT_DECISION_TIMEOUT_SECONDS))
        ),
        replay=_flag("WORKFLOWS_REPLAY"),
        fixtures_dir=Path(fixtures),
    )


class ConfigurationError(RuntimeError):
    """Raised when a real (non-replay) call cannot be made."""


def require_api_key(settings: Settings) -> str:
    if not settings.mistral_api_key:
        raise ConfigurationError(
            "MISTRAL_API_KEY is not set. Export it, or run with WORKFLOWS_REPLAY=1 "
            "to use the recorded fixtures."
        )
    return settings.mistral_api_key
