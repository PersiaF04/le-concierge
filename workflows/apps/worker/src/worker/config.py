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
    chonk_model: str
    chonk_reasoning_effort: str | None
    speech_model: str
    speech_voice_id: str
    speech_realtime: bool
    speech_target_peak_dbfs: float
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
        vision_model=os.getenv("VISION_MODEL", "mistral-small-latest"),
        transcription_model=os.getenv("TRANSCRIPTION_MODEL", "voxtral-mini-latest"),
        # The live door decision stays on Small: Large 4 reasons by default and
        # a visitor cannot wait for it. See docs/decisions.md, ADR-014.
        decision_model=os.getenv("DECISION_MODEL", "mistral-small-latest"),
        # Le Chonk (Mistral Large 4) for every step where nobody is waiting at
        # the door: the digest, the parcel notice and the CCTV review.
        chonk_model=os.getenv("CHONK_MODEL", "mistral-large-latest"),
        # Large 4 accepts low, medium or high (not none). Low keeps it quick;
        # an empty value leaves the model's own default (high).
        chonk_reasoning_effort=os.getenv("CHONK_REASONING_EFFORT", "low").strip() or None,
        # The door speaks through Voxtral's realtime endpoint, so the audio
        # arrives in deltas while the sentence is still being generated.
        speech_model=os.getenv("SPEECH_MODEL", "voxtral-mini-tts-3-0"),
        speech_voice_id=os.getenv("SPEECH_VOICE_ID", "gb_jane_neutral"),
        speech_realtime=_flag("SPEECH_REALTIME", "1"),
        # Voxtral hands back a wav peaking around -8 dBFS, which is quiet on an
        # intercom. The audio is peak-normalised to this ceiling before anyone
        # hears it; -1 leaves a decibel of headroom so nothing clips.
        speech_target_peak_dbfs=float(os.getenv("SPEECH_TARGET_PEAK_DBFS", "-1.0")),
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
