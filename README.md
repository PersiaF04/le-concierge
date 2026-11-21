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

Residential buildings need a modern way to handle visitor access. Traditional intercoms require physical presence and manual verification. Residents miss deliveries and visitors wait unnecessarily. There's no intelligent system that learns resident preferences or handles common scenarios automatically.

## What It Does

Le Concierge is a smart intercom system that:

- **Recognizes visitors** using on-device face recognition (MediaPipe) and cloud-based vision models
- **Notifies residents** via a mobile/web app with visitor photos and live audio
- **Learns preferences** using Le Chonk (Mistral Large 4) to make intelligent decisions
- **Manages access** with voice interaction at the intercom (Voxtral)
- **Tracks presence** in real-time with WebSocket updates
- **Sends digests** nightly to keep residents informed

## Demo

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
| **CI/CD** | GitHub Actions |

## Run Locally

### Prerequisites

- Node.js 22.0.0+
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
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MISTRAL_API_KEY` | Yes | API key for Mistral AI services |
| `PORT` | No | Server port (default: 3000) |
| `NODE_ENV` | No | Environment (default: development) |

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
