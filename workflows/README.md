# Le Concierge workflows

The decision flows for Le Concierge, on **Mistral Workflows**. The Node API and
both web apps stay as they are: this worker is the brain behind them.

Three workflows:

| Workflow | Runs when | Activities, in order |
| --- | --- | --- |
| `visitor-arrival` | MediaPipe fires at the door | describe snapshot (vision) → match face (face-api.js descriptor) → transcribe intercom (Voxtral) → Le Chonk decides → post visit to the API → **wait for the `resident-decision` signal** (timeout declines) → speak the reply → log |
| `parcel-arrival` | A parcel reaches the desk | read the label (vision) → match the flat → Le Chonk writes the notice → notify the resident on their channel → log |
| `nightly-digest` | Scheduled, 19:00 daily | pull the day's events from the API → Le Chonk writes the digest → post it → log |

The vision model never identifies anyone. Recognition is face-api.js
descriptors on the concierge device, and only for residents who tapped
"that was me".

## Run the worker

Product requirements: Python 3.12+, `uv`, and a `MISTRAL_API_KEY`.

```bash
cd workflows
uv sync
cp .env.example .env          # then set MISTRAL_API_KEY
DEPLOYMENT_NAME=le-concierge uv run python -m worker.entrypoints.worker
```

With the Mistral CLI installed, `mistral dev` from this directory does the same
thing and adds a file-watching restart. The worker has to be running: an
execution only progresses while a worker is up.

## Start an execution

```bash
uv run python scripts/run_workflow.py visitor-arrival --input fixtures/visitor_input.json
uv run python scripts/run_workflow.py parcel-arrival  --input fixtures/parcel_input.json
uv run python scripts/run_workflow.py nightly-digest  --input fixtures/digest_input.json
```

The Node API uses the same call:

```bash
curl -X POST "$MISTRAL_API_URL/v1/workflows/visitor-arrival/execute" \
  -H "Authorization: Bearer $MISTRAL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"input": {"visit_id": "visit_0001", "snapshot_url": "https://…"}}'
```

## Answer the door from a running execution

`POST /visits/{id}/decision` on the Node API sends the signal. Under the hood:

```python
client.workflows.executions.signal_workflow_execution(
    execution_id=visit["execution_id"],
    name="resident-decision",
    input={"decision": "approve", "resident_id": "res_12_persia"},
)
```

`visitor-arrival` waits on that signal; if it does not arrive within
`VISITOR_DECISION_TIMEOUT_SECONDS`, the visit is declined automatically.

## Schedule the digest

```bash
uv run python scripts/register_schedules.py --timezone Europe/London
```

Schedules are created through the client rather than the deprecated
`schedules=` decorator argument, so changing the cron expression does not need
a worker restart.

## Offline: replay mode

```bash
WORKFLOWS_REPLAY=1 uv run python -m worker.entrypoints.worker
```

Every activity reads `fixtures/*.json` instead of calling the network, so the
demo works without wifi and tests need no API key. `WORKFLOWS_RECORD=1` saves
the results of real calls back into `fixtures/` so they can be replayed later.

## What the fixtures hold

Each file is one recorded activity result. Audio payloads are not committed: a
speech fixture keeps the text, the model, the voice and the size of the audio
(`audio_bytes`), but `audio_base64` is empty. That is why an execution output
names the model: it is what tells a real model call from a fixture.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `MISTRAL_API_KEY` | — | Model calls and the Studio connection. Never commit it. |
| `DEPLOYMENT_NAME` | — (required) | Stable name for this deployment, e.g. `le-concierge`. The worker refuses to start without it. |
| `LE_CONCIERGE_API_URL` | `http://localhost:3000` | Node API the activities call back into |
| `WORKFLOWS_REPLAY` | `0` | `1` runs every activity from the recorded fixtures |
| `WORKFLOWS_RECORD` | `0` | `1` writes real activity results into `fixtures/` |
| `WORKFLOWS_FIXTURES_DIR` | `./fixtures` | Where the recordings live |
| `VISION_MODEL` | `pixtral-large-latest` | Describes the door, reads parcel labels |
| `TRANSCRIPTION_MODEL` | `voxtral-mini-latest` | Intercom speech to text |
| `DECISION_MODEL` | `mistral-large-latest` | Le Chonk |
| `SPEECH_MODEL` | `voxtral-mini-tts-latest` | The reply spoken at the door |
| `VISITOR_DECISION_TIMEOUT_SECONDS` | `60` | How long the visitor flow waits |

## Tests

```bash
uv run pytest -q
```

The suite runs entirely in replay mode: it checks the three workflows register,
that every activity reads its fixture, that the label parser picks the flat off
the label, and that `visitor-arrival` declines on timeout and opens the door on
approval.

## Layout

```
workflows/
├── apps/worker/src/worker/
│   ├── config.py            settings, replay switch, API-key guard
│   ├── entrypoints/worker.py worker process, discovers the workflows
│   ├── shared/              fixtures, Node API client, model calls
│   └── workflows/           one module per workflow
├── fixtures/                recorded activity results
├── scripts/                 run a workflow, register the schedule
└── tests/
```
