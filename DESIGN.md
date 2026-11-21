# Le Concierge — design brief and art direction

## 1. Brief

**What.** A building intercom that recognises visitors and asks the right resident, in one tap. Three
surfaces over one API: the resident's phone, the door itself, and the concierge's log.

**Who.**

- *Resident*, standing in a corridor or at their desk, phone in one hand, 60 seconds to answer a stranger at
  the door. Nothing installed, no account, no password.
- *Visitor*, standing at the door, one metre away, not necessarily knowing what the device is.
- *Concierge*, at a desk in the lobby, reading the day back and stepping in when the system is not sure.

**The one action.** Resident: **Sign and open** (open the door). Second: **Leave it shut**.
Concierge: **open the door** on a visit the resident could not settle.

**The proof on the first screen.** The visitor: what they said
(`"it's the delivery for flat twelve"`), which flat it resolved to, the face distance, the 60 seconds before
the door stays shut, and the signature line waiting for an answer. That is the whole product, on one screen.

**Real material** (all of it produced by this repo, not invented):

| Material | Value | Source |
|---|---|---|
| Transcript | "Hello, it's the delivery for flat twelve, I have a parcel for Persia." | `workflows/fixtures/transcribe.json` |
| Decision | flat `12`, confidence `0.86`, action `ask`, reply "Come in, 12. The door is open." | `workflows/fixtures/chonk_visitor.json` |
| Face result | matched `res_12_persia`, distance `0.31`, model `face-api.js/ssd_mobilenetv1` | `fixtures/api_match_face.json` |
| Parcel label | `FLAT 12 - HANDLE WITH CARE`, courier `DPD` | `fixtures/vision_parcel.json` |
| Speech | `voxtral-mini-tts-3-0-13`, voice `voice_447`, realtime / responsive, 5 deltas, first at `1062.7 ms`, `88364` bytes wav | `workflows/fixtures/speech.json` |
| Measured activity latency | `match_face 257ms`, `transcribe 281ms`, `decide 290ms`, `post_visit 257ms`, `speak_reply 260ms`, `log 270ms` | Studio execution `ebfce486…fc2f08` |
| Models in play | `pixtral-large-latest`, `voxtral-mini-latest`, `mistral-large-latest`, `voxtral-mini-tts-3-0` | `workflows/.env.example` |

**Imagery.** No stock photographs. The doors' own camera is the imagery: the apps call `getUserMedia` and
photograph the visitor (door) or the resident's face (phone), and label the frame as "this laptop's camera
stands in for the intercom" until the device exists (#3). When the camera is refused the screens say so
instead of showing a placeholder portrait.

**Site type.** App UI, not a marketing page. The working surface is the first screen; no hero, no feature
grid, no sign-in.

**Anti-reference.** The smart-home dashboard: purple-to-blue gradient, glass cards floating over a dark
canvas, glowing rings, "Seamless access, powered by AI". Also refused: the "tasteful AI" look (cream ground,
serif display, mono eyebrows, terracotta) and near-black plus neon glow.

## 2. Creative brief — one paragraph with a point of view

A resident's real question is not "how does the recognition work", it is **"should I open my door to this
person, and do I have time to think?"** The product's answer is a single, legible fact: who is out there, what
they said, which flat they want. So **these surfaces behave like the building's logbook, because a visitor is
an entry that needs a signature before the door opens.** The material that makes that credible is the
recorded run: the visitor's words, the flat it resolved to, the 0.86 confidence, the 60-second budget
draining, the measured milliseconds and the audio bytes each model produced. The one bold move: **answering
stamps the entry, in ink, at an angle, over the signature line** — not a toast, not a green tick. Everything
else stays quiet: two typefaces, one accent, rules instead of shadows, no cards. It refuses a dashboard grid
of tiles, because at the door there is exactly one decision, and it refuses a glossy mascot, because trust
here comes from showing the visitor and the transcript.

## 3. Direction: B — Logbook (chosen)

Three directions were built and rendered at `.web-design/directions/{threshold,logbook,switchboard}/index.html`
and checked with the skill's divergence script (`RESULT: PASS`, sheet at `.web-design/directions/sheet.jpg`).
**B** was picked: ink on paper, ruled ledger, signature line, rubber stamps. Threshold was too architectural
to answer in one tap; Switchboard explained the workflow better than it served the resident.

**One building, three surfaces:**

| Surface | Route | What it is |
|---|---|---|
| Resident phone | `apps/resident` | The ledger entry for your flat, and the signature line |
| The door | `apps/concierge` `#door` | Le Concierge's face, the visitor's words, the reply, the camera |
| The log | `apps/concierge` `#ledger` | Today's entries as a ruled table, filters, detail pane |

**The avatar is a portrait plate, not a mascot.** Le Concierge is drawn as one line-drawn face in exactly the
same ink and stroke weight as the ledger rules (2.4 on a 200 viewBox, round caps). It looks at the pointer,
blinks on a 5.4 s loop, and its mouth moves while the reply is spoken — the same mouth that is drawn as a
smile line when it is listening. No gloss, no gradient, no glow, no 3D. Under `prefers-reduced-motion` the
face is a still portrait. The reply is voiced with `SpeechSynthesis` (en-GB) and, when a browser has no
voice, the face mimes the sentence for its spoken length and a notice says so.

## 4. Tokens (`packages/ui/src/styles.css`)

| Role | Light | Dark |
|---|---|---|
| paper | `oklch(0.962 0.004 250)` | `oklch(0.245 0.012 250)` |
| paper-2 (fields, plates) | `oklch(0.988 0.003 250)` | `oklch(0.295 0.012 250)` |
| ink | `oklch(0.24 0.014 250)` | `oklch(0.955 0.004 250)` |
| ink-2 (recorded voice) | `oklch(0.5 0.012 250)` | `oklch(0.73 0.008 250)` |
| rule | `oklch(0.87 0.008 250)` | `oklch(0.36 0.01 250)` |
| stamp (pending) | `oklch(0.45 0.09 255)` | `oklch(0.76 0.09 255)` |
| approve | `oklch(0.42 0.09 155)` | `oklch(0.78 0.11 155)` |
| alert (declined, no answer) | `oklch(0.5 0.13 40)` | `oklch(0.78 0.12 45)` |

- **Type does two jobs.** Instrument Sans speaks (headings, replies, prose). IBM Plex Mono records
  (timestamps, distances, model names, ids). Nothing else uses either.
- **Radii.** `0` everywhere a rule exists; `2rem` only for the phone shell. No shadows at all.
- **Spacing.** One 4 px grid, `--s1`…`--s8`.
- **Motion.** `--press 140ms`, `--move 180ms`, `--stamp-in 220ms` (a stamp lands rotated −3° with a 1.35→1
  scale). All of it collapses under `prefers-reduced-motion`.
- Both themes are designed, not inverted: stamps and approval green are lifted in dark so contrast holds.

## 5. What the screens say out loud

- `recorded run` when `VITE_API_URL` is unset, `live` when it is. The apps never pretend to be connected.
- The door's camera is labelled as this laptop's camera, and a refused camera is stated, not hidden.
- The speech block on the door shows exactly what `speak_reply` returns: model, voice, transport
  (`realtime` / `batch`), audio bytes, chunk count, time to first delta, playback length.
- The resident is told a decision did not reach the API ("the door did not actually open") rather than being
  shown a green stamp that means nothing.
- No account, no password, no payment anywhere. Details live in `localStorage` and can be forgotten.

## 6. Evidence

- Slop check (`node …/slop-check.mjs`): `RESULT: PASS` on the resident app, the door and the log, with the
  standard gates green (contrast AA, reflow at 320 px, target sizes, reduced motion, no AI copy tells).
- Screenshots: `.web-design/shots/` (both viewports from the checker) and `.web-design/app-shots/` (light and
  dark, door speaking, answered entry, parcels, me, the log, mobile). Both folders are git-ignored.

## 7. Still open

1. A real intercom photograph and the device itself (#3); until then the laptop camera stands in.
2. `voxtral-mini-realtime-*` is transcription only — speech goes over `audio/speech/realtime` with
   `voxtral-mini-tts-3-0`. If we want a duplex door (interrupt the visitor), that is an audio session, not a
   model swap.
3. Face memory is held by the API in the intention, not yet wired: "that was me" writes locally today.
