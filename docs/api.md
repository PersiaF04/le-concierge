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
| `WORKFLOW_DEPLOYMENT_NAME` | unset | Sent as `deployment_name` on execute, for when two deployments register the same workflow |
| `VISIT_TTL_SECONDS` | `300` | A visit still waiting this long is swept to `expired` |
| `MISTRAL_RETRY_BASE_MS` | `600` | First backoff when Mistral answers 429 or 5xx (4 attempts, doubling) |
| `FACE_MATCH_THRESHOLD` | `0.5` | Largest Euclidean distance that counts as a face match |
| `SEED_DEMO` | unset | `1` adds the demo resident `res_12_persia` at flat 12 |
| `VOICE_ID` | `gb_jane_neutral` | The door's voice in the Voice Agent; keep it equal to the worker's `SPEECH_VOICE_ID` so there is one voice everywhere |
| `VOICE_LLM_MODEL` | `mistral-small-latest` | The Voice Agent's model |
| `VOICE_STT_MODEL` | `voxtral-mini-transcribe-realtime-3-0` | The Voice Agent's transcription model |
| `VOICE_TTS_MODEL` | `voxtral-mini-tts-3-0` | The Voice Agent's speech model |
| `VOICE_LANGUAGE` | `en` | Transcription language (ISO 639-1) |
| `VOICE_MAX_SESSIONS` | `3` | Most voice sessions open at once |
| `VOICE_RATE_PER_MINUTE` | `6` | Most `POST /voice/session` calls per IP per minute |
| `VOICE_SESSION_TTL_SECONDS` | `600` | A session nobody closed stops counting as open after this |

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
  `Authorization: Bearer $MISTRAL_API_KEY` and body
  `{ "input": { ... }, "deployment_name": "<WORKFLOW_DEPLOYMENT_NAME, omitted when unset>" }`.
  The response's `execution_id` is stored on the visit. 429 and 5xx answers
  are retried with backoff.
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

`200 { status: "ok", timestamp, version, node, env, workflow, mode: "live"|"offline", key: "set"|"missing", visits, snapshots }`

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

The doorbell. Body: `{ flat, snapshot_url, face, audio_url?, visit_id?, door_id? }`.
`door_id` is the door page's own id (see `WS /live?scope=door&door=`); it is
stored on the visit as `doorId` and kept through the worker's later updates.
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

#### `GET /visits?flat=&status=` and `GET /visits?waiting=1&flat=`

`status=pending` returns the newest `arriving` or `pending_decision` Visit for
the flat, or `null`. `waiting=1` (or `status=pending&list=1`) returns the whole
queue of waiting visits as `Visit[]`; `flat` is optional. Any other `status`
(or none) returns `Visit[]`, newest first. Visits waiting longer than
`VISIT_TTL_SECONDS` are swept to `expired` first.

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

### Photographs

#### `POST /snapshots`

The phone or the door publishes the picture it just took. Body:
`{ flat, dataUrl, source?: "resident-phone"|"door", by? }`; `dataUrl` must be a
`data:image/` URL. The last one per flat is kept and pushed on `/live` as
`{ type: "snapshot", snapshot }` to that flat's sockets and to `scope=door` sockets.

`201 { stored: true, snapshot }` (without `dataUrl`), `400` on missing or bad fields.

#### `GET /snapshots?flat=`

`200 Snapshot` `{ flat, dataUrl, source, by, at, bytes }`, `404` when the flat has none yet.

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

### Voice (Mistral Voice Agents)

The door's live conversation. The API holds the key and creates the session
with `client.audio.sessions.create()` from `@mistralai/mistralai`; the door
joins it over WebRTC with `initSession` from
`@mistralai/mistralai/extra/voice-agents/browser` and runs the client-side
tools. Both routes are guarded, as Mistral's docs ask:

- only the door's origins: `https://le-concierge-door.vercel.app`, its Vercel
  previews (`https://le-concierge-door-*.vercel.app`), and `http://localhost:*`
  / `http://127.0.0.1:*`; anything else, or no `Origin`, gets `403`;
- `VOICE_RATE_PER_MINUTE` creates per IP per minute (`429`);
- at most `VOICE_MAX_SESSIONS` open at once (`429`).

#### `POST /voice/session`

Body: `{ door_id? }` (ignored by the session; it identifies the page). Creates
a session configured here, not by the page:

- instructions: Le Concierge, a warm, brief British front-desk concierge; greet,
  ask who they are visiting and their name, never reveal residents' details,
  use the tools; a welcome message;
- `llm.model` `VOICE_LLM_MODEL`, `stt` `{ model: VOICE_STT_MODEL, language: VOICE_LANGUAGE }`,
  `tts` `{ model: VOICE_TTS_MODEL, voiceId: VOICE_ID }`;
- tools: `ask_resident({ flat, visitor_name, reason? })` with the filler "Let
  me check with them, one moment." and a timeout of the decision timeout plus
  15 s; `log_event({ text })`; and `hang_up`.

`201` with the SDK's response: `{ id, participantToken, serverUrl, createdAt, expiresAt, functionTools? }`.
`403` wrong origin, `429` rate limit or too many open, `503` no `MISTRAL_API_KEY`,
`502` Mistral refused.

#### `DELETE /voice/session/:id`

Closes a session this API opened (`client.audio.sessions.close({ sessionId })`).
`204`, or `404` for an id it did not open. Same origin check.

The door's tools, in the browser (`apps/concierge/src/voice.ts`):

- `ask_resident` calls `POST /arrivals` with the flat, a camera snapshot and
  the page's `door_id`, which starts `visitor-arrival` and pushes the visit
  to the resident's phone; it then waits on its own
  `/live?scope=door&door=<id>` socket for that visit id to become `approved`,
  `declined` or `expired` (at most 70 s) and returns `{ decision }`.
- `log_event` calls `POST /events` with `{ type: "door.voice", text }`.

If the session cannot be created or connected, the door falls back to the
record-and-reply pipeline (six seconds of audio to `POST /arrivals`, then the
workflow's Voxtral wav). The console says which path ran.

### The demo stage

#### `GET /executions/:id/steps`

Used by the door app's `#stage` page (`server/stage.js`). Reads
`GET {MISTRAL_API_URL}/v1/workflows/executions/{id}/history` with
`MISTRAL_API_KEY` and answers one workflow step per activity:

```json
{
  "executionId": "…",
  "steps": [
    { "activity": "describe_snapshot", "status": "completed", "at": "…", "model": "mistral-small-latest" },
    { "activity": "post_visit", "status": "completed", "at": "…" }
  ],
  "waiting": true,
  "finished": false
}
```

`status` is `scheduled`, `started`, `completed` or `failed`. `model` is the
model an activity's result names, else the activity's default. `waiting` is
true while the run sits on the `resident-decision` wait (a `TIMER_STARTED`
with no signal or fired timer after it); `finished` once the execution has
completed, failed or been terminated. Answers are cached for about 700 ms per
execution, so a stage polling every second makes at most one Mistral call per
poll. `503` without a key, `400` for a malformed id, `404` when Mistral does
not know the execution, `502` for other Mistral errors.

The stage finds the latest visit and its `executionId` on `WS /live?scope=door`
and polls this route every second until `finished`.

### Live updates

#### `WS /live?flat=12`, `WS /live?scope=door&door=<id>` and `WS /live?scope=door`

A socket subscribes one of two ways, and closes with 1008 if it gives neither:

- `?flat=12`, for residents: on connect it receives the flat's newest visit,
  then a frame every time a visit or photograph for that flat changes, and
  never one for another flat.
- `?scope=door&door=<id>`, for a door page: one-to-one. Each door page makes
  its own id (`crypto.randomUUID()`, kept in sessionStorage for the tab) and
  sends it as `door_id` on `POST /arrivals`, `POST /snapshots` and
  `POST /voice/session`. The socket gets only frames for visits and snapshots
  carrying that id: status updates, the decision, and the speech or reply. On
  connect it receives that page's own newest visit, if any. So several open
  door pages never speak each other's visitors. The page plays a wav only for
  a visit it rang for in this load, so reloading never replays an old reply.
- `?scope=door` with no door id: the building-wide feed, for the #ledger log
  only (it never plays audio). On connect it receives the newest visit in the
  building, then every visit frame for every flat, including visits that have
  no flat yet, and every snapshot frame. If both `scope=door` and `flat` are
  given, `scope=door` wins.

Frames:

```json
{ "type": "visit", "visit": { "id": "visit_…", "flat": "12", "...": "a full Visit" } }
{ "type": "snapshot", "snapshot": { "flat": "12", "dataUrl": "data:image/…", "source": "door", "at": "…" } }
```

## Storage

Tables: `residents`, `faces`, `visits`, `decisions`, `events`, `parcels`,
`notifications`, `audio`, `snapshots`. The schema version is `PRAGMA user_version`; add
migrations to the end of `MIGRATIONS` in `server/db.js`, never edit an old one.
Face descriptors are stored only for confirmed residents and are deleted with
the resident.
