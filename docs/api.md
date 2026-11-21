# Le Concierge API

The Node API in `server/` sits between the two web apps and the Mistral
Workflows worker. It stores everything in SQLite (`node:sqlite`, Node 22) and
pushes visit changes to the apps over `WS /live`.

- Code: `server/app.js` (routes), `server/db.js` (schema and migrations),
  `server/index.js` (entry point).
- Tests: `test/server.test.js`, run with `npm test`.
- Callers: the apps through `packages/ui/src/api.ts`, the worker through
  `workflows/apps/worker/src/worker/shared/api.py`. Request and response
  shapes below match both, and the worker's recorded answers in
  `workflows/fixtures/api_*.json`.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000, ws://localhost:3000/live?flat=12
```

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | HTTP and WebSocket port |
| `DATABASE_PATH` | `data/le-concierge.db` | SQLite file; created with its schema on first start |
| `MISTRAL_API_KEY` | unset | Starts and signals workflow executions. Unset means offline |
| `WORKFLOWS_REPLAY` | `0` | `1` forces offline mode even with a key (`REPLAY_MODE=replay` also works) |
| `MISTRAL_API_URL` | `https://api.mistral.ai` | Base URL for the Workflows REST API |
| `VISITOR_WORKFLOW` | `visitor-arrival` | Workflow started by `POST /arrivals` |
| `PARCEL_WORKFLOW` | `parcel-arrival` | Workflow started by `POST /parcels` |
| `VISITOR_DECISION_TIMEOUT_SECONDS` | `60` | Passed to the workflow and shown as `timeoutSeconds` |
| `FACE_MATCH_THRESHOLD` | `0.5` | Largest Euclidean distance that counts as a face match |
| `SEED_DEMO` | unset | `1` adds the demo resident `res_12_persia` at flat 12 |

How the other parts find the API:

| Who | Variable | Example |
| --- | --- | --- |
| Apps | `VITE_API_URL` | `http://localhost:3000` |
| Apps | `VITE_WS_URL` | `ws://localhost:3000` (the apps add `/live?flat=`) |
| Worker | `LE_CONCIERGE_API_URL` | `http://localhost:3000` |

### Offline mode

With `WORKFLOWS_REPLAY=1`, or with no `MISTRAL_API_KEY`, the API never calls
Mistral. `POST /arrivals` creates the visit locally with `execution_id: null`
and status `pending_decision`; `POST /parcels` creates the parcel locally; a
decision only updates the visit. `GET /health` reports `mode: "offline"`.

### Live mode: Mistral Workflows

The same REST calls the Python SDK (`mistralai` 3.8) makes:

- Start: `POST {MISTRAL_API_URL}/v1/workflows/{name}/execute` with
  `Authorization: Bearer $MISTRAL_API_KEY` and body `{ "input": { ... } }`.
  The response's `execution_id` is stored on the visit.
- Signal: `POST {MISTRAL_API_URL}/v1/workflows/executions/{execution_id}/signals`
  with body `{ "name": "resident-decision", "input": { "decision", "resident_id", "note" } }`.

## Shapes

`Visit`, `VisitSpeech`, `Parcel` and `Resident` are the types in
`packages/ui/src/types.ts`. A Visit is always served with every field:

```json
{
  "id": "visit_…", "flat": "12", "residentId": null,
  "status": "pending_decision", "at": "2026-11-21T10:14:00.000Z",
  "timeoutSeconds": 60, "transcript": "", "confidence": null,
  "faceDistance": null, "reply": "", "executionId": null, "parcel": null,
  "snapshot": null, "decidedAt": null, "speech": null, "mode": "workflow"
}
```

`status` is one of `arriving`, `pending_decision`, `approved`, `declined`,
`expired`, `fallback`. Errors are `{ "error": "message" }` with status 400
(invalid input), 404 (unknown id), 409 (conflict) or 502 (Mistral failed).

## Routes

### `GET /health`

`200 { status: "ok", timestamp, version, node, env, workflow, mode: "live"|"offline", key: "set"|"missing", visits }`

### Residents and faces

#### `POST /residents`

Body: `{ flat, name?, email?, phone?, whatsapp?, anonymous }`. `flat` is always
required; `name` is required unless `anonymous` is true. An anonymous resident
keeps no contact details, even if some were sent.

`201 Resident`: `{ id, flat, anonymous, name?, email?, phone?, whatsapp? }`. `400` on missing fields.

#### `POST /residents/:id/confirm`

The resident tapped "that was me". Body is ignored (the app sends `{ thatWasMe: true }`).
`200 { ok: true }`, `404` for an unknown resident.

#### `POST /residents/:id/face`

Store a face-api.js descriptor for a resident. Body: `{ descriptor: number[], model? }`.
Only a resident who has confirmed can be enrolled; visitors never are.

`201 { ok: true, resident_id }`, `409` before the resident has confirmed, `400`
for a bad descriptor, `404` for an unknown resident.

#### `POST /faces/match`

Called by the worker's `match_face` activity. Body: `{ descriptor: number[], ... }`.
Compares against stored descriptors of confirmed residents by Euclidean
distance; the nearest one under `FACE_MATCH_THRESHOLD` wins.

`200 { matched: true, resident_id, distance, threshold }`, or
`{ matched: false, resident_id: null, distance: null, threshold }`.

### Visits

#### `POST /arrivals`

The doorbell. Body: `{ flat, snapshot_url, face, audio_url?, visit_id? }`.
Creates the visit, pushes it on `/live`, and starts `visitor-arrival` with input
`{ visit_id, snapshot_url, flat, audio_url, face, decision_timeout_seconds }`.

`201 { visit_id, execution_id }` (`execution_id` is null offline).
`502 { visit_id, execution_id: null, error }` if Mistral refused; the visit is marked `fallback`.

#### `POST /visits`

Called by the worker's `post_visit` activity. Creates or updates a visit.
Body: `{ visit_id, execution_id?, flat?, resident_id?, transcript? (string or {text}),
confidence?, face_distance?, proposed_reply?, parcel?, recognition?, status? }`.
A visit that was already decided keeps its decision.

`201 { stored: true, visit_id, execution_id, status, notified_over: "ws:/live", visit: Visit }`, `400` without `visit_id`.

#### `GET /visits?flat=&status=`

`status=pending` returns the newest `arriving` or `pending_decision` Visit for
the flat, or `null`. Any other `status` (or none) returns `Visit[]`, newest first.

#### `GET /visits/:id`

`200 Visit`, `404` for an unknown visit.

#### `POST /visits/:id/decision`

Body: `{ decision: "approve"|"decline", resident_id?, note? }`. Sets the visit to
`approved` or `declined`, records it in `decisions`, pushes it on `/live`, and
in live mode sends the `resident-decision` signal to the visit's execution.

`200 { ok: true, signalled }`, `400` for another decision, `404` for an unknown
visit, `409` when the visit is no longer pending, `502 { ok: false, error }` if the signal failed.

### The intercom

#### `POST /intercom/speak`

Called by the worker's `speak_reply` activity with the Voxtral result:
`{ visit_id, text, model, voice_id, transport?, streaming_mode?, chunks?,
first_chunk_ms?, audio_bytes, gain_db?, peak_dbfs?, audio_base64?, duration_ms? }`.
Stores it on the visit as `speech` (a `VisitSpeech`), sets `reply` to the text,
keeps the wav, and pushes the visit on `/live`.

`200 { played: true, duration_ms, attached }`. `duration_ms` is derived from
`audio_bytes` (24 kHz 16-bit mono) when not given.

#### `GET /intercom/audio/:visit_id.wav`

The wav kept for a visit; this is `visit.speech.audioUrl`. `200 audio/wav`, `404` when none was kept.

### Parcels

#### `POST /parcels`

The desk photographs a parcel. Body: `{ snapshot_url, flat?, label_text?, courier?, resident_id?, parcel_id? }`
(`snapshot_url` or `label_text` is required). Stores the parcel `at_desk` and starts
`parcel-arrival` with `{ parcel_id, snapshot_url, flat, label_text, resident_id }`.

`201 { parcel_id, execution_id, parcel }`, `400`, or `502` if Mistral refused.

#### `GET /parcels?flat=`

`200 Parcel[]`, newest first: `{ id, flat, courier, label, at, status: "at_desk"|"collected" }`.
The workflow's closing `parcel.arrival` event fills in the courier and label it read.

### Events and notifications

#### `POST /events`

Called by every workflow's `log_event` activity. Body: `{ type, ...anything }`;
`flat` is taken from the visit when only `visit_id` is given.

- `visit.decision` closes the visit: `approved`, `declined`, or `expired` when `automatic` is true.
- `parcel.arrival` updates the parcel with `courier`, `label_text` and `flat`.
- `resident.arrival` and `resident.departure` (with `resident_id`) drive `GET /presence`.

`201 { stored: true, event_id, event }`, `400` without `type`.

#### `GET /events?flat=&day=`

Used by the nightly digest. `day` is `YYYY-MM-DD` (UTC).
`200 { day, flat, events: [...] }`, oldest first. `400` for a malformed day.

#### `POST /notifications`

Called by `parcel-arrival` and `nightly-digest`. Body: `{ resident_id?, flat?, title, body, ... }`
(one of `resident_id` or `flat` is required). The notification is stored for the
app to show (in-app). Email, SMS and WhatsApp are listed in `preferred` when a
non-anonymous resident gave those details, but no provider is configured, so
nothing is sent on them. Anonymous residents only ever get in-app.

`201 { delivered: true, notification_id, channels: ["in_app"], preferred, anonymous_fallback: "in_app", recipients }`.

#### `GET /notifications?flat=` or `?resident_id=`

`200` the stored notifications, newest first.

### Presence

#### `GET /presence`

Who is in: residents whose latest `resident.arrival` / `resident.departure`
event today (UTC) is an arrival.

`200 { day, in: [{ residentId, name, flat, since }], residents, visits, sockets }`.

### Live updates

#### `WS /live?flat=12`

`flat` is required (the socket closes with 1008 without it). On connect the
socket receives the flat's newest visit, then a frame every time a visit for
that flat changes, and never one for another flat:

```json
{ "type": "visit", "visit": { "id": "visit_…", "flat": "12", "...": "a full Visit" } }
```

## Storage

Tables: `residents`, `faces`, `visits`, `decisions`, `events`, `parcels`,
`notifications`, `audio`. The schema version is `PRAGMA user_version`; add
migrations to the end of `MIGRATIONS` in `server/db.js`, never edit an old one.
Face descriptors are stored only for confirmed residents and are deleted with
the resident.
