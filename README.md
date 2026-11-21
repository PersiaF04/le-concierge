# Le Concierge

<div align="center">

**Smart intercom visitor recognition for residential buildings**

[![CI](https://github.com/PersiaF04/le-concierge-vibe/actions/workflows/ci.yml/badge.svg)](https://github.com/PersiaF04/le-concierge-vibe/actions/workflows/ci.yml)
[![Mistral Vibe Hackathon London](https://img.shields.io/badge/event-Mistral_Vibe_Hackathon_London-blue)](https://mistral.ai)
[![Le Chonk](https://img.shields.io/badge/model-Le_Chonk_orange)](https://mistral.ai)
[![kind](https://img.shields.io/badge/kind-hack-ff69b4)](https://github.com/topics/hackathon)
[![Node 22](https://img.shields.io/badge/Node-22.0.0-green)](https://nodejs.org)

</div>

---

## Problem

Residential buildings need a cost effective solution for handling visitor access. Traditional intercoms require physical presence and manual verification. Residents miss deliveries and visitors wait unnecessarily. There's no intelligent system that learns resident preferences or handles common scenarios automatically.

## What It Does

Le Concierge is a smart intercom system that:

- **Recognizes visitors** using on-device face recognition (MediaPipe) and cloud-based vision models
- **Notifies residents** via a mobile/web app with visitor photos and live audio
- **Learns preferences** using Le Chonk (Mistral Large 4) to make intelligent decisions
- **Manages access** with voice interaction at the intercom (Voxtral)
- **Tracks presence** in real-time with WebSocket updates
- **Sends digests** nightly to keep residents informed

## Demo

Pitch deck: [docs/pitch/index.html](docs/pitch/index.html) (script in [docs/pitch/script.md](docs/pitch/script.md), PDF backup in [docs/pitch/pitch.pdf](docs/pitch/pitch.pdf)).
Short 2-minute deck with a scan-to-join QR code: [docs/pitch/short.html](docs/pitch/short.html).

The two web apps are deployed in recorded-run mode:

- the phone: https://le-concierge-resident.vercel.app
- the door and the log: https://le-concierge-concierge.vercel.app

See [docs/deploy.md](docs/deploy.md) for what is deployed, how it was deployed,
and why the API and the worker cannot live on Vercel next to them.


Watch a resident receive a visitor notification, see the live photo, hear the audio, and approve access — all from their phone. The system remembers "that was me" confirmations to improve future recognition.

## How It Works

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Intercom      │────▶│    Server        │◀───┤   Resident App  │
│   (Camera/Mic)  │     │    (API)         │     │   (Web/Mobile)  │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                       │
                                       ▼
                            ┌─────────────────┐
                            │   Mistral AI    │
                            │ (Vision/Voxtral)│
                            └─────────────────┘
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/residents` | Register a new resident |
| POST | `/residents/{id}/confirm` | Resident confirms "that was me" |
| GET | `/events?flat=` | Get events for a specific flat |
| POST | `/visits/{id}/decision` | Approve or decline a visit |
| GET | `/presence` | Get real-time presence status |
| WS | `/live` | WebSocket for live updates |

### Data Flow

1. **Visitor arrives** at intercom → Camera captures photo + audio
2. **Server processes** → MediaPipe face detection → Mistral vision model for recognition
3. **Resident notified** → Photo + audio streamed to resident app
4. **Resident decides** → Approve/Decline via app or voice (Voxtral at intercom)
5. **Access granted/denied** → Intercom opens gate or plays message
6. **Learning** → "That was me" confirmations improve future recognition

## Track

- **Category:** Smart Home / IoT
- **Target:** Residential buildings, apartment complexes
- **Innovation:** AI-powered visitor recognition without sign-in or payments

## Tech Stack

| Component | Technology |
|-----------|------------|
| **Device** | MediaPipe (face detection), Node.js 22 |
| **API** | Express.js, WebSocket |
| **AI Models** | Mistral Vision (snapshots), Voxtral (voice), Le Chonk (decisions) |
| **Resident App** | face-api.js (opted-in residents), React |
| **Concierge App** | React, Tailwind CSS |
| **Database** | SQLite (embedded) |
| **Testing** | Node.js Test Runner (`node --test`) |
| **Workflows** | Mistral Workflows (Python 3.12 worker, `mistralai-workflows`) |
| **CI/CD** | GitHub Actions |

## Where we use Mistral Workflows and Agents

The decision flows live in [`workflows/`](workflows/), a Python worker built on
Mistral Workflows. The Node API and both web apps stay where they are; the
workflows are the brains behind them, and every step survives a crash because
each one is recorded in the execution history.

| Workflow | Trigger | Activities, in order | Ends with |
| --- | --- | --- | --- |
| `visitor-arrival` | MediaPipe fires at the door, the API calls `POST /v1/workflows/visitor-arrival/execute` | describe the snapshot (Mistral vision) → match the face-api.js descriptor → transcribe the intercom (Voxtral) → Le Chonk decides who it is for and what to say → post the visit (pushed to the resident over `WS /live`) → speak the reply → log | **waits for the `resident-decision` signal** from `POST /visits/{id}/decision`; a timeout declines |
| `parcel-arrival` | Parcel photographed at the desk | read the label (Mistral vision) → match the flat → Le Chonk writes the notice → notify the resident on their channel → log | — |
| `nightly-digest` | Scheduled, `0 19 * * *` in `Europe/London` | pull the day's events from the API → Le Chonk writes the digest → post it → log | — |
| `cctv-event` | MediaPipe sees a person on a CCTV camera | describe the frames (Mistral vision) → label the people (a resident by description, else "Unknown person N" or "Delivery courier N") → write one past-tense log line → log it as `cctv.<kind>` | `discard: true` when the frames show nobody |
| **Mistral Vibe** + `le-concierge` MCP | The building manager asks Vibe in the terminal, e.g. "anything suspicious today?" | the `le-concierge` skill picks the read-only MCP tools ([`mcp/`](mcp/)) → they read presence, events, CCTV, visits and parcels from the live API → Vibe answers briefly, suspicious CCTV first | no contact details ever shown |

The door itself is a **Mistral Voice Agent**: press the bell and the visitor
talks to Le Concierge live, over WebRTC (`client.audio.sessions.create()` on
the API, `initSession` in the browser; `mistral-small-latest` with Voxtral
realtime transcription and Voxtral TTS in the `gb_jane_neutral` voice, the same
voice the workflow speaks in). It asks who they are visiting and their name,
then calls its `ask_resident` tool, which hands off to the `visitor-arrival`
Workflow: the visit goes to the resident's phone, and the agent tells the
visitor the resident's answer. A `log_event` tool writes to the timeline. If
the voice session cannot start, the door falls back to recording six seconds
and playing the workflow's Voxtral reply. See [docs/api.md](docs/api.md#voice-mistral-voice-agents).

### Which model runs which step

Le Chonk (Mistral Large 4, `CHONK_MODEL=mistral-large-latest`) runs every step
where nobody is waiting. The live door decision runs on Mistral Small
(`DECISION_MODEL=mistral-small-latest`), because a visitor is standing at the
intercom: Large 4 reasons by default and took 74 s, and even
`reasoning_effort: "low"` took 6.7 to 8.0 s. Large 4 does not accept `"none"`.

| Step | Workflow | Model |
| --- | --- | --- |
| `write_digest` | `nightly-digest` | **Le Chonk** (Large 4, `reasoning_effort: "low"`) |
| `write_notice` | `parcel-arrival` | **Le Chonk** (Large 4, `reasoning_effort: "low"`) |
| `chonk_review_event`: flags tailgating, loitering, unanswered rings | `cctv-event` | **Le Chonk** (Large 4, `reasoning_effort: "low"`) |
| The live door conversation (Mistral Voice Agent) | door | Mistral Small with Voxtral (latency at the door) |
| `decide_visit`: who the visitor is for, what the door says | `visitor-arrival` | Mistral Small (latency at the door) |
| `label_people`, `write_event` | `cctv-event` | Mistral Small |
| `describe_snapshot`, `read_label`, `describe_cctv_frames` | all | Mistral Small (vision) |
| transcription, speech | `visitor-arrival` | Voxtral |

Every Le Chonk step names its model in its output, so Studio shows
`mistral-large-latest` on those steps. ADR-014 in
[`docs/decisions.md`](docs/decisions.md) has the timings.

Agents: Le Chonk, inside the activities, runs on the **Mistral Agents SDK**
(durable agents are being deprecated), so the decision prompt, tools and model
stay versioned with the workflow that calls them.

The vision model never identifies anyone. Recognition is face-api.js
descriptors on the concierge device, only for residents who tapped
"that was me"; the vision model describes the scene and reads parcel labels.

### Run the workflows worker

```bash
cd workflows
uv sync
cp .env.example .env          # then set MISTRAL_API_KEY
uv run python -m worker.entrypoints.worker
```

With the Mistral CLI installed, `mistral dev` from `workflows/` does the same
and restarts on file changes. **The worker must be running**: an execution only
progresses while a worker is up.

Start an execution, the way the API does it:

```bash
uv run python scripts/run_workflow.py visitor-arrival --input fixtures/visitor_input.json
```

Then watch it in Studio: **Studio → Workflows → Executions**, where each run
shows its activities, the signal it is waiting on, and the result.

Offline, and in CI, everything runs from recorded activity results:

```bash
WORKFLOWS_REPLAY=1 uv run python -m worker.entrypoints.worker
```

## Talk to the building from Mistral Vibe

A building manager can ask [Mistral Vibe](https://docs.mistral.ai/vibe) about
the building from the terminal. Two pieces make that work:

- [`mcp/`](mcp/), a read-only stdio MCP server over the live API:
  `who_is_in` (`GET /presence`), `todays_events` (`GET /events`),
  `parcels` (`GET /parcels`), `current_visits` (`GET /visits?waiting=1`)
  and `cctv_log` (`cctv.*` events, suspicious ones such as tailgating
  flagged first). Each tool answers with a short summary plus the JSON, with
  residents' contact details removed.
- [`vibe-skill/le-concierge/SKILL.md`](vibe-skill/le-concierge/SKILL.md), the
  Vibe skill: act as the manager's assistant, answer briefly, suspicious CCTV
  first, never reveal contact details.

Setup:

```bash
git clone https://github.com/PersiaF04/le-concierge ~/le-concierge-mcp
cd ~/le-concierge-mcp/mcp && npm install && npm test
```

Then add both to `~/.vibe/config.toml` (use absolute paths):

```toml
skill_paths = ["/home/you/le-concierge-mcp/vibe-skill"]   # keep your existing entries

[[mcp_servers]]
name = "le-concierge"
transport = "stdio"
command = "node"
args = ["/home/you/le-concierge-mcp/mcp/index.js"]

[mcp_servers.env]
LE_CONCIERGE_API_URL = "https://harmony.tailb80b97.ts.net:10000"   # or http://localhost:3000
```

`LE_CONCIERGE_API_URL` defaults to the demo API. Example prompts:

```bash
vibe "Who's in the building right now?"
vibe "Anything suspicious on the cameras today?"
vibe -p "Any parcels for flat 7, and is anyone waiting at the door for them?"
```

## Run Locally

### Prerequisites

- Node.js 22.0.0+
- Python 3.12+ and [uv](https://docs.astral.sh/uv/) (for the workflows worker)
- Git
- GitHub CLI (`gh`)

### Setup

```bash
# Clone the repository
git clone https://github.com/PersiaF04/le-concierge-vibe.git
cd le-concierge-vibe

# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your MISTRAL_API_KEY

# Run the development server
npm run dev

# Run tests
npm test

# Run the workflows worker (in a second terminal)
cd workflows && uv sync && uv run python -m worker.entrypoints.worker
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MISTRAL_API_KEY` | Yes | API key for Mistral AI services and Studio. Never committed. |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (default: development) |
| `LE_CONCIERGE_API_URL` | No | Node API base URL used by the workflows worker (default: `http://localhost:3000`) |
| `WORKFLOWS_REPLAY` | No | `1` runs every workflow activity from recorded fixtures, offline |

## Privacy and Limitations

### Privacy

- **No sign-in required**: Residents can use the app anonymously
- **No payments**: Completely free, no payment processing
- **Face storage**: Faces are stored only after explicit "that was me" confirmation
- **Data locality**: All processing happens on-device when possible; cloud only for vision models
- **No tracking**: We don't track users across sessions

### Limitations

- **Opted-in only**: Face recognition only works for residents who have explicitly opted in
- **On-device first**: MediaPipe runs on the device; cloud is fallback only
- **Replay mode**: All external API calls are recorded for replay and auditing
- **No persistence**: Faces not confirmed as "that was me" are discarded after 24 hours

## Team

- **Persia Lewis** ([@persialewis123](https://github.com/persialewis123)) — Project Lead, Architecture
- **Mistral Vibe** — AI Agent, Development

## License

MIT License — see [LICENSE](LICENSE) for details.
