# Demo Script — Le Concierge

**Duration**: 5 minutes
**Audience**: Hackathon judges, potential users, team members
**Mode**: Live demonstration with pre-recorded fallback

---

## Overview

This script demonstrates the core functionality of Le Concierge: smart visitor recognition and access control for residential buildings. The demo shows the complete user journey from visitor arrival to resident decision.

---

## Timeline

| Time | Duration | Section | Presenter | Notes |
|------|----------|---------|-----------|-------|
| 0:00 | 0:30 | **Introduction** | Persia | Set the context |
| 0:30 | 1:00 | **Architecture Overview** | Persia | Show the big picture |
| 1:30 | 1:30 | **Visitor Arrival** | Mistral | Live intercom demo |
| 3:00 | 1:00 | **Resident Notification** | Mistral | Real-time alert |
| 4:00 | 0:30 | **Decision & Access** | Persia | Show the outcome |
| 4:30 | 0:30 | **Q&A** | Both | Answer questions |
| 5:00 | - | **End** | - | - |

---

## Detailed Script

### 0:00 — Introduction (30 seconds)

**Persia:**

> "Welcome to Le Concierge! Imagine you live in a building where visitors arrive unexpectedly. Traditional intercoms are annoying — you have to rush to the door, you can't see who's there, and you can't let them in from your phone.
>
> Le Concierge solves this with AI-powered visitor recognition. Let me show you how it works."

**Visuals:**
- Show landing page on projector
- Title: "Le Concierge — Smart Intercom for Smart Buildings"

**Transition:**
- Click to architecture diagram

---

### 0:30 — Architecture Overview (60 seconds)

**Persia:**

> "Here's how it works. We have three main components:
>
> 1. **The Intercom** — at the building entrance with camera, microphone, and door release
> 2. **The Server** — in the middle, processing everything and making decisions
> 3. **The Resident App** — on your phone, showing you who's at the door
>
> When a visitor arrives, the intercom captures their photo and audio. MediaPipe does on-device face detection. If it doesn't recognize them, we use Mistral Vision for enhanced recognition. The server coordinates everything, and you get a notification on your phone.
>
> And the best part? **No sign-in required**, **no payments**, and **your face data is only stored after you explicitly confirm it's you**."

**Visuals:**
- Architecture diagram from README
- Animate the flow: Intercom → Server → Resident App
- Highlight: MediaPipe, Mistral Vision, Le Chonk (for decisions)

**Key Points:**
- ✅ On-device first (privacy)
- ✅ Cloud fallback (accuracy)
- ✅ No friction (no sign-in)

**Transition:**
- Switch to live demo screen

---

### 1:30 — Visitor Arrival (90 seconds)

**Mistral (running the demo):**

> "Let's see this in action. I'm going to simulate a visitor arriving at the building."

**Action:** Trigger visitor arrival on the intercom

**What happens:**
1. Motion detected at the intercom
2. Camera captures photo of "visitor" (pre-recorded or live)
3. Microphone captures audio: "Hi, I'm here to see John Smith in flat 201"
4. MediaPipe processes the photo on-device
5. Server receives the data

**Visuals on Screen:**
```
┌─────────────────────────────────────────────┐
│  INTERCOM VIEW                                │
│  ─────────────────────────────────────────  │
│                                             │
│       📷 [Visitor Photo Appears]             │
│                                             │
│       🎤 "Hi, I'm here to see John..."       │
│                                             │
│       ⏳ Processing...                         │
│                                             │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│  SERVER LOG                                   │
│  ─────────────────────────────────────────  │
│  [11:55:03] Motion detected                 │
│  [11:55:03] Photo captured                   │
│  [11:55:04] Audio captured                   │
│  [11:55:04] MediaPipe: face detected         │
│  [11:55:04] MediaPipe: no match              │
│  [11:55:05] Mistral Vision: processing...   │
│  [11:55:06] Mistral Vision: no match        │
│  [11:55:06] Creating new visit #12345        │
│  [11:55:06] Voxtral: processing audio...     │
│  [11:55:07] Voxtral: "visiting John Smith"   │
│  [11:55:07] Notifying resident: Flat 201     │
└─────────────────────────────────────────────┘
```

**Narration:**

> "The intercom detected motion and captured a photo. MediaPipe ran on the device and didn't find a match in its local cache. So it sent the photo to Mistral Vision for enhanced recognition — still no match, meaning this is a new visitor.
>
> Meanwhile, Voxtral processed the audio and determined the visitor is asking for John Smith in flat 201.
>
> The server created a new visit record and is now notifying all residents in flat 201."

**Key Points:**
- On-device processing first
- Cloud fallback for accuracy
- Voice understanding with Voxtral
- Real-time notification

**Transition:**
- Switch to resident app view

---

### 3:00 — Resident Notification (60 seconds)

**Mistral:**

> "Now let's see what John Smith sees on his phone."

**Visuals on Screen:**
```
┌─────────────────────────────────────────────┐
│  RESIDENT APP - John Smith                   │
│  ─────────────────────────────────────────  │
│                                             │
│  🔔 NEW VISITOR                              │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │                                    │  │  │
│  │      📷 [Visitor Photo]              │  │  │
│  │                                    │  │  │
│  │   Visiting: John Smith              │  │  │
│  │   Flat: 201                          │  │  │
│  │   Time: Just now                     │  │  │
│  │                                    │  │  │
│  │   ▶️ [Play Audio]                    │  │  │
│  │                                    │  │  │
│  └───────────────────────────────────────┘  │
│                                             │
│  ┌─────────────┐   ┌─────────────┐          │
│  │   ✅ APPROVE │   │   ❌ DENY   │          │
│  └─────────────┘   └─────────────┘          │
│                                             │
│  "That was me"                             │
│                                             │
└─────────────────────────────────────────────┘
```

**Action:** Click "Play Audio"

**What happens:**
- Audio plays: "Hi, I'm here to see John Smith in flat 201"

**Narration:**

> "John receives a push notification on his phone with the visitor's photo and a summary. He can play the live audio to hear what the visitor said. The audio confirms it's someone visiting him specifically.
>
> Now John has a decision to make. He can see it's a person at his door, hear what they're saying, and decide whether to let them in."

**Action:** Click "✅ APPROVE"

**What happens:**
- Decision sent to server
- Server processes decision
- Door release command sent to intercom
- Visit marked as "approved"

**Visuals on Screen:**
```
┌─────────────────────────────────────────────┐
│  RESIDENT APP - John Smith                   │
│  ─────────────────────────────────────────  │
│                                             │
│  ✅ Access Approved!                         │
│                                             │
│  The door has been released.                │
│  Visitor can now enter.                     │
│                                             │
│  ┌───────────────────────────────────────┐  │
│  │   Visit #12345                         │  │
│  │   Status: Approved                     │  │
│  │   Visitor: Unknown                     │  │
│  │   Time: Just now                       │  │
│  │   Decision: Approve                    │  │
│  └───────────────────────────────────────┘  │
│                                             │
└─────────────────────────────────────────────┘
```

**Transition:**
- Switch back to Persia

---

### 4:00 — Decision & Access (30 seconds)

**Persia:**

> "And that's it! John approved the visitor, the door released, and the visitor can enter the building. The entire process took less than 10 seconds from arrival to access.
>
> But here's where it gets smarter. If this same person visits again and John confirms "that was me", the system learns. Next time, it might recognize them automatically and even make a recommendation."

**Visuals:**
- Show the full flow animation again
- Highlight: Visit → Notification → Decision → Access

**Key Points:**
- Fast and seamless
- Learning over time
- Resident always in control

---

### 4:30 — Q&A (30 seconds)

**Persia:**

> "So to summarize: Le Concierge provides smart visitor recognition without compromising privacy. No sign-in, no payments, and your data stays yours.
>
> Questions?"

**Expected Questions & Answers:**

**Q: What if the visitor's face matches a resident but it's not them?**
> A: The resident always makes the final decision. We show them the photo and they can approve or deny. If they deny, we don't store that face for future matching.

**Q: What about privacy?**
> A: Faces are only stored after explicit "that was me" confirmation. We never share data with third parties. All processing happens on-device when possible.

**Q: Can this work without internet?**
> A: Yes, but with limited functionality. On-device face detection (MediaPipe) works offline. Cloud-based recognition (Mistral Vision) requires internet. Voice processing (Voxtral) also requires internet.

**Q: What's the tech stack?**
> A: Node.js 22, Express, WebSocket, MediaPipe, face-api.js, React, and Mistral AI models (Vision, Voxtral, Le Chonk).

**Q: Is this production-ready?**
> A: This is a hackathon project, so it's a proof of concept. The architecture is designed to be production-ready, but it would need additional hardening for real-world use.

**Transition:**
- Show final slide with repo link and contact info

---

## Final Slide

```
┌─────────────────────────────────────────────┐
│                     LE CONCIERGE              │
│  Smart Intercom Visitor Recognition System   │
│                                             │
│  ✅ No sign-in required                      │
│  ✅ No payments                               │
│  ✅ Privacy-first                             │
│  ✅ AI-powered                                │
│  ✅ Learning system                           │
│                                             │
│  GitHub: github.com/PersiaF04/le-concierge-vibe│
│  Contact: @persialewis123                     │
│  Event: Mistral Vibe Hackathon London        │
│                                             │
│  Thank you! 🙏                               │
└─────────────────────────────────────────────┘
```

---

## Technical Setup for Demo

### Prerequisites

- [ ] Node.js 22.0.0+
- [ ] GitHub CLI (`gh`)
- [ ] MISTRAL_API_KEY environment variable
- [ ] Two devices or browser tabs (intercom + resident app)

### Pre-Recorded Fallback

If live demo fails, have pre-recorded videos ready:
1. `demo/visitor-arrival.mp4` — Intercom capturing visitor
2. `demo/resident-notification.mp4` — Resident app receiving notification
3. `demo/decision-flow.mp4` — Full decision flow

### Backup Plan

If technical issues occur:
1. Switch to pre-recorded videos
2. Walk through the architecture diagram
3. Show static screenshots of the apps
4. Explain the flow verbally

---

## Demo Checklist

- [ ] Architecture diagram rendered
- [ ] Intercom device ready (or simulator)
- [ ] Resident app running
- [ ] Server running
- [ ] MISTRAL_API_KEY set
- [ ] Audio working
- [ ] Camera working (or pre-recorded images)
- [ ] Network connectivity
- [ ] Backup videos ready
- [ ] Presenter notes printed

---

## Notes for Presenters

### Persia (Human Lead)
- Focus on the vision and high-level concepts
- Explain the "why" behind decisions
- Handle Q&A
- Keep the narrative flowing

### Mistral (AI Agent)
- Run the live demo
- Show technical details
- Explain implementation choices
- Demonstrate the actual functionality

### Timing
- Practice the demo multiple times
- Have a timer visible
- Be prepared to skip sections if running long
- Prioritize: Visitor Arrival → Resident Notification → Decision

### Troubleshooting
- If live demo fails, switch to pre-recorded immediately
- If audio doesn't work, describe what should be happening
- If camera doesn't work, use pre-captured images
- Keep calm and confident — technical issues happen!

---

*Last updated: 2026-11-21*
*Version: 1.0.0*
