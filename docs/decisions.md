# Architecture Decision Records (ADRs)

This document captures all significant architecture decisions made for Le Concierge.

## Format

Each decision follows this template:

```markdown
## ADR-XX: Decision Title

**Status:** ✅ Accepted | ❌ Rejected | 🔄 Superseded by ADR-XX

**Context:** The problem or need that prompted this decision.

**Decision:** The chosen solution.

**Consequences:** Trade-offs, benefits, and drawbacks.

**Alternatives Considered:** Other options that were evaluated.

**Date:** YYYY-MM-DD

**Author:** @username
```

---

## ADR-001: No Sign-In Required

**Status:** ✅ Accepted

**Context:** 
Traditional smart home systems require sign-in with email/password or OAuth. This creates friction for residents and adds security complexity (password management, account recovery). Our goal is zero-friction adoption.

**Decision:** 
Implement anonymous usage with optional details. Residents can use the app without creating an account. For identification purposes, only `name` and `flat` are required. Email, phone, and WhatsApp are optional.

**Consequences:**
- ✅ Faster onboarding
- ✅ No password management
- ✅ Better privacy (no personal data collected by default)
- ⚠️ Cannot track residents across devices without opt-in
- ⚠️ Limited personalization without profile data
- ⚠️ No account recovery (but nothing to recover)

**Alternatives Considered:**
- Email/password sign-in
- OAuth (Google, Apple, etc.)
- Phone number verification
- Building-provided credentials

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-002: No Payments Processing

**Status:** ✅ Accepted

**Context:** 
The project is a hackathon demo. Adding payment processing would require PCI compliance, security audits, and significant complexity. The value proposition doesn't require payments.

**Decision:** 
No payment processing code, integrations, or logic. The system is completely free to use.

**Consequences:**
- ✅ Simplified architecture
- ✅ No PCI compliance requirements
- ✅ Faster development
- ⚠️ No monetization path (not a goal for this project)
- ⚠️ Cannot support premium features

**Alternatives Considered:**
- Stripe integration
- PayPal integration
- Building-provided payment system
- Subscription management

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-003: On-Device Face Detection First

**Status:** ✅ Accepted

**Context:** 
Face recognition can be done on-device (MediaPipe) or in the cloud (Mistral Vision). On-device is faster, preserves privacy, and works offline. Cloud offers better accuracy for challenging cases.

**Decision:** 
Use MediaPipe on-device for initial face detection and matching. Only use Mistral Vision as a fallback when on-device detection fails or confidence is low. For opted-in residents, store face encodings locally for matching.

**Consequences:**
- ✅ Privacy: No images leave the device unless explicitly sent for cloud processing
- ✅ Speed: Immediate feedback, no network latency
- ✅ Offline capability: Works without internet connection
- ✅ Cost: No cloud API calls for most cases
- ⚠️ Accuracy: On-device may be less accurate than cloud for some edge cases
- ⚠️ Resource usage: MediaPipe uses device CPU/GPU

**Alternatives Considered:**
- Cloud-only face recognition
- Always use both (on-device + cloud)
- Cloud-first with on-device fallback

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-004: Face Storage Only After Explicit Confirmation

**Status:** ✅ Accepted

**Context:** 
Face recognition requires storing face encodings or images. This is sensitive biometric data. Privacy regulations (GDPR, CCPA) require explicit consent. Ethical considerations demand transparency.

**Decision:** 
Only store face data after a resident explicitly confirms "that was me" for a visit. The face encoding is captured from the visit photo and stored in the database. Unconfirmed faces are discarded after 24 hours.

**Consequences:**
- ✅ Privacy-compliant by design
- ✅ Residents have full control over their biometric data
- ✅ Ethical and transparent
- ⚠️ Lower initial recognition accuracy (fewer faces in database)
- ⚠️ Requires explicit user action to improve recognition

**Alternatives Considered:**
- Always store faces (with opt-out)
- Store faces after first visit (implicit consent)
- Never store faces (no learning)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-005: Replay Mode for All External Calls

**Status:** ✅ Accepted

**Context:** 
External API calls (Mistral Vision, Voxtral, Le Chonk) are expensive and non-deterministic. Tests and debugging require reproducibility. We need to ensure we don't make accidental API calls in CI or development.

**Decision:** 
Implement replay mode that records all external API requests and responses. When enabled, the system uses recorded responses instead of making real calls. Recording is enabled via `REPLAY_MODE=record` or `REPLAY_MODE=replay`.

**Consequences:**
- ✅ Deterministic tests
- ✅ No accidental API costs
- ✅ Reproducible debugging
- ✅ Easy to share test scenarios
- ⚠️ Need to maintain recording files
- ⚠️ Recordings may need updates when API contracts change

**Alternatives Considered:**
- Mock all external calls (less realistic)
- Use actual APIs in tests (expensive, slow, non-deterministic)
- Recording library (like VCR)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-006: SQLite as Embedded Database

**Status:** ✅ Accepted

**Context:** 
We need a database for storing residents, visits, events, and decisions. Options include: PostgreSQL (hosted), MongoDB, SQLite (embedded), or Firebase.

**Decision:** 
Use SQLite as an embedded database. It's file-based, requires no separate server, and is perfect for this scale. The database file will be stored in `data/le-concierge.db`.

**Consequences:**
- ✅ Zero configuration
- ✅ No separate database server needed
- ✅ File-based: easy to backup, version, and deploy
- ✅ Good performance for this scale
- ⚠️ Not ideal for high-concurrency scenarios
- ⚠️ No built-in user management
- ⚠️ Limited scalability (but sufficient for hackathon demo)

**Alternatives Considered:**
- PostgreSQL (RDS or self-hosted)
- MongoDB (Atlas or self-hosted)
- Firebase Realtime Database
- In-memory database (no persistence)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-007: Node.js 22 with Native Test Runner

**Status:** ✅ Accepted

**Context:** 
We need a runtime for the server and intercom. Options include: Node.js, Python, Go, Rust. Node.js 22 is the latest LTS and has a stable native test runner (`node --test`).

**Decision:** 
Use Node.js 22.0.0+ with ESM modules (`"type": "module"`). Use the native `node --test` for testing instead of third-party frameworks like Jest or Mocha.

**Consequences:**
- ✅ Modern JavaScript features
- ✅ No test framework to configure
- ✅ Fast startup
- ✅ Standard library only
- ⚠️ Less mature than Jest for advanced features
- ⚠️ Fewer community resources

**Alternatives Considered:**
- Node.js 20 (LTS, but older)
- TypeScript with ts-node
- Python with FastAPI
- Go

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-008: WebSocket for Real-Time Updates

**Status:** ✅ Accepted

**Context:** 
The resident app needs real-time updates about visitor arrivals, presence changes, and other events. Options include: WebSocket, Server-Sent Events (SSE), polling, or GraphQL subscriptions.

**Decision:** 
Use WebSocket for bidirectional real-time communication. The server provides `WS /live` endpoint for broadcasting events to all connected clients. This supports visitor notifications, presence updates, and access decisions.

**Consequences:**
- ✅ Full-duplex communication
- ✅ Low latency
- ✅ Efficient (no repeated HTTP headers)
- ✅ Standard protocol with good browser support
- ⚠️ More complex to implement than polling
- ⚠️ Need to handle connection drops and reconnects
- ⚠️ Scaling requires connection management

**Alternatives Considered:**
- Server-Sent Events (simpler, unidirectional)
- Long polling (inefficient)
- GraphQL subscriptions (requires GraphQL server)
- Firebase Realtime Database (vendor lock-in)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-009: MediaPipe for On-Device Face Detection

**Status:** ✅ Accepted

**Context:** 
We need face detection and recognition on the intercom device. Options include: MediaPipe, face-api.js, TensorFlow.js, OpenCV, or cloud APIs.

**Decision:** 
Use MediaPipe for on-device face detection. It's optimized for real-time performance, supports face detection, face mesh, and face landmarks, and runs efficiently in the browser and Node.js.

**Consequences:**
- ✅ High performance (60+ FPS)
- ✅ Works on-device (no internet required)
- ✅ Privacy-preserving
- ✅ Well-documented and maintained
- ⚠️ Limited to face detection (not recognition out of the box)
- ⚠️ Need to implement matching logic

**Alternatives Considered:**
- face-api.js (used in resident app for opted-in residents)
- TensorFlow.js (more flexible, more complex)
- OpenCV (native, not browser-friendly)
- Cloud APIs (not on-device)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-010: Le Chonk for All Decisions

**Status:** ✅ Accepted

**Context:** 
We need AI to make intelligent decisions about access. Options include: custom heuristics, simple ML models, or large language models. Le Chonk (Mistral Large 4) is available and powerful.

**Decision:** 
Use Le Chonk (Mistral Large 4) for all decision-making. This includes: access approval recommendations, resident preference learning, and intelligent responses. The model will consider context like time of day, resident preferences, historical patterns, and building rules.

**Consequences:**
- ✅ High-quality decisions
- ✅ Flexible and adaptable
- ✅ Can handle complex scenarios
- ✅ Learning from patterns
- ⚠️ API costs
- ⚠️ Latency (network calls)
- ⚠️ Need for good prompts
- ⚠️ Replay mode required for testing

**Alternatives Considered:**
- Custom heuristics (fast, but inflexible)
- Simple ML model (less accurate)
- Rule-based engine (maintenance overhead)
- Other LLMs (may not be available)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-011: Voxtral for Voice Interaction at Intercom

**Status:** ✅ Accepted

**Context:** 
The intercom needs voice interaction capabilities to understand visitor requests and communicate with them. Options include: Web Speech API, Whisper, Voxtral, or custom speech-to-text.

**Decision:** 
Use Voxtral for voice interaction at the intercom. It provides high-quality speech-to-text for understanding visitor requests (e.g., "I'm here to see John in flat 42") and can also handle text-to-speech for responses.

**Consequences:**
- ✅ High accuracy for voice recognition
- ✅ Multilingual support
- ✅ Good for real-time interaction
- ✅ Mistral ecosystem integration
- ⚠️ API costs
- ⚠️ Requires internet connection
- ⚠️ Latency for cloud processing

**Alternatives Considered:**
- Web Speech API (browser-only, less accurate)
- Whisper (open-source, self-hosted)
- Custom speech-to-text (complex to implement)
- Button-based interaction only (no voice)

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-012: GitHub Actions for CI/CD

**Status:** ✅ Accepted

**Context:** 
We need CI/CD for automated testing and deployment. Options include: GitHub Actions, GitLab CI, CircleCI, Travis CI, or Jenkins.

**Decision:** 
Use GitHub Actions for CI/CD. The workflow will run on `ubuntu-latest` and include: dependency installation, linting, testing, and build steps. No `cache: npm` unless we commit a `package-lock.json`.

**Consequences:**
- ✅ Native GitHub integration
- ✅ Free for public repos
- ✅ Easy to configure
- ✅ Good marketplace for actions
- ⚠️ Vendor lock-in to GitHub
- ⚠️ Limited free minutes for private repos

**Alternatives Considered:**
- GitLab CI (if using GitLab)
- CircleCI
- Travis CI
- Self-hosted runners

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-013: Conventional Commits

**Status:** ✅ Accepted

**Context:** 
We need a consistent commit message format for better git history and automated changelog generation. Options include: Conventional Commits, custom format, or no format.

**Decision:** 
Use Conventional Commits with the following types: `feat`, `fix`, `docs`, `chore`, `test`, `refactor`, `style`, `build`, `ci`, `perf`. Commit messages follow the format: `<type>(<scope>): <description>`.

**Consequences:**
- ✅ Standardized format
- ✅ Easy to parse for changelog generation
- ✅ Better git history readability
- ✅ Industry standard
- ⚠️ Slight learning curve
- ⚠️ Need to enforce in PRs

**Alternatives Considered:**
- Custom commit format
- No enforced format
- Gitmoji

**Date:** 2026-11-21

**Author:** @persialewis123

---

## ADR-014: Le Chonk where latency does not matter, Small at the door

**Status:** ✅ Accepted

**Context:**
The main track is built around Le Chonk (Mistral Large 4). Large 4 reasons by
default, and the live door decision on it took 74 s, while a visitor waits at
the intercom. We measured on `mistral-large-latest` with JSON output and a
realistic door prompt:

| Setting | Result |
| --- | --- |
| default (`high`) | 74 s |
| `reasoning_effort: "none"` | HTTP 400: not supported; Large 4 allows only `low`, `medium`, `high` |
| `reasoning_effort: "low"` | 6.7 s and 8.0 s, about 600 reasoning tokens, valid JSON |

Under about 2 s would have been fast enough for the door. Low is not.

**Decision:**
- The live door decision (`decide_visit` in `visitor-arrival`) stays on
  `DECISION_MODEL=mistral-small-latest`.
- Le Chonk runs on `CHONK_MODEL=mistral-large-latest` with
  `CHONK_REASONING_EFFORT=low` for every step where nobody is waiting: the
  nightly digest (`write_digest`), the parcel notice (`write_notice`) and the
  new CCTV review (`chonk_review_event`), which flags tailgating, loitering and
  unanswered doorbell rings as `{flag, severity, note}`.
- Every Le Chonk step returns its model, so Studio shows `mistral-large-latest`.

**Consequences:**
- ✅ The door answers quickly; Le Chonk does the thinking that can wait
- ✅ Models are configurable without code changes
- ⚠️ The door decision is not made by Large 4. Revisit if a reasoning-off mode
  or a faster Large 4 appears.

**Alternatives Considered:**
- Large 4 at the door with `reasoning_effort: "low"` (6.7 to 8.0 s, too slow)
- Large 4 at the door with reasoning off (`"none"` is rejected)

**Date:** 2026-11-21
