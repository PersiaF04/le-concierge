"""Recorded results for every activity.

The same fixtures serve three purposes:

* tests run with ``WORKFLOWS_REPLAY=1`` and never touch the network;
* the offline demo keeps working when the venue wifi does not;
* a recording of a real run can be replayed step by step while debugging.

Files are plain JSON, named after the activity's fixture key.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..config import Settings


class FixtureMissing(LookupError):
    """Raised when replay mode asks for a fixture that was never recorded."""


def load_fixture(settings: Settings, key: str) -> Any:
    path: Path = settings.fixtures_dir / f"{key}.json"
    if not path.is_file():
        raise FixtureMissing(
            f"No recorded fixture {key!r} at {path}. Record it with "
            f"WORKFLOWS_REPLAY=0, or add the file."
        )
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def save_fixture(settings: Settings, key: str, payload: Any) -> None:
    """Persist an activity result so the next replay can use it."""

    settings.fixtures_dir.mkdir(parents=True, exist_ok=True)
    path = settings.fixtures_dir / f"{key}.json"
    with path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
