"""Worker entrypoint.

``mistral dev`` runs the same module; running it directly does the same thing
without the CLI:

    uv run python -m worker.entrypoints.worker

The worker only serves executions while it is up.
"""

from __future__ import annotations

import asyncio

import mistralai.workflows as workflows


async def main() -> None:
    workflow_classes = workflows.discover_all_workflows_in_package("worker.workflows")
    if not workflow_classes:
        raise SystemExit("No workflows found in worker.workflows")
    names = sorted(getattr(cls, "__name__", str(cls)) for cls in workflow_classes)
    print(f"Registering {len(names)} workflows: {', '.join(names)}")
    await workflows.run_worker(workflow_classes)


if __name__ == "__main__":
    asyncio.run(main())
