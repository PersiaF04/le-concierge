"""Register the nightly-digest schedule and start a test execution.

Run it once, from the project root, with the worker already up:

    uv run python scripts/register_schedules.py --timezone Europe/London

The decorator-based ``schedules=`` argument on ``@workflow.define`` is
deprecated, so the schedule is created through the client instead: changes do
not need a worker restart and multiple workers cannot conflict.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "worker" / "src"))

from mistralai.client import Mistral  # noqa: E402
from mistralai.client.models import ScheduleDefinition, SchedulePolicy  # noqa: E402

DIGEST_CRON = "0 19 * * *"  # 19:00, every day
# Temporal overlap policies are plain integers on this API: 1=SKIP, 2=BUFFER_ONE,
# 3=BUFFER_ALL, 4=CANCEL_OTHER, 5=TERMINATE_OTHER, 6=ALLOW_ALL.
OVERLAP_SKIP = 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timezone", default="Europe/London")
    parser.add_argument("--cron", default=DIGEST_CRON)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    definition = ScheduleDefinition(
        input={"day": None, "flat": None},
        cron_expressions=[args.cron],
        time_zone_name=args.timezone,
        policy=SchedulePolicy(
            catchup_window_seconds=3600,
            overlap=OVERLAP_SKIP,
        ),
    )
    print(f"nightly-digest schedule: {args.cron} ({args.timezone})")
    if args.dry_run:
        print("dry run, nothing sent")
        return 0

    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        print("MISTRAL_API_KEY is not set", file=sys.stderr)
        return 2

    client = Mistral(api_key=api_key)
    response = client.workflows.schedules.schedule_workflow(
        schedule=definition,
        workflow_identifier="nightly-digest",
    )
    print(response.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
