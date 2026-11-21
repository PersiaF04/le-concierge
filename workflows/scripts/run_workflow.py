"""Start one execution of a workflow and print the result.

    uv run python scripts/run_workflow.py visitor-arrival --input fixtures/visitor_input.json

This is the same call the Node API makes through
``POST /v1/workflows/{name}/execute``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "worker" / "src"))

from mistralai.client import Mistral  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workflow", help="visitor-arrival, parcel-arrival or nightly-digest")
    parser.add_argument("--input", default=None, help="path to a JSON input file")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()

    payload = {}
    if args.input:
        payload = json.loads(Path(args.input).read_text(encoding="utf-8"))

    api_key = os.environ.get("MISTRAL_API_KEY")
    if not api_key:
        print("MISTRAL_API_KEY is not set, so no execution can be started", file=sys.stderr)
        return 2

    client = Mistral(api_key=api_key)
    execution = client.workflows.execute_workflow(
        workflow_identifier=args.workflow,
        input=payload,
        wait_for_result=True,
        timeout_seconds=args.timeout,
    )
    print(execution.model_dump_json(indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
