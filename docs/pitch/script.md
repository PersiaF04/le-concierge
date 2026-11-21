# Le Concierge: five-minute pitch script

Mistral Vibe Hackathon London, 21 November 2026. The deck is
[`index.html`](index.html): open it in a browser, press `F` for full screen,
then use the arrow keys or Space. `D` switches to the dark variant if the
projector washes out the paper. [`pitch.pdf`](pitch.pdf) is the same deck as a
backup, one slide per page.

Total: **5:00**, of which about two minutes are the live demo.

| Slide | Time | Length |
| --- | --- | --- |
| 1. Title | 0:00 | 0:15 |
| 2. The problem | 0:15 | 0:30 |
| 3. Live demo | 0:45 | 2:00 |
| 4. How it works | 2:45 | 0:40 |
| 5. Where we use Mistral | 3:25 | 0:40 |
| 6. Privacy by design | 4:05 | 0:20 |
| 7. What's next | 4:25 | 0:20 |
| 8. Team and links | 4:45 | 0:15 |

---

## Before you go on (5 minutes before)

1. `https://harmony.tailb80b97.ts.net:10000/health` returns `"status":"ok"`
   and `"mode":"live"`.
2. The workflows worker is running, and **Studio → Workflows → Executions** is
   open in a tab.
3. Laptop, tab 1: the deck. Tab 2: `https://le-concierge-door.vercel.app`.
   Load it once and allow the microphone and camera, so no permission prompt
   appears on stage.
4. Phone: `https://le-concierge-resident.vercel.app`, already set up as
   **flat 12** (name optional). Screen brightness up, auto-lock off. If the
   phone is mirrored, check the mirror now.
5. A terminal with Vibe open and the `le-concierge` MCP server and skill
   configured (see the README section "Talk to the building from Mistral
   Vibe"). Ask it one warm-up question so the tools are already loaded.
6. Laptop volume up, and the room's mic close to the laptop speaker.
7. The demo video, ready to play, in case the network goes.

---

## 1. Title (0:00, 15 s)

> This is Le Concierge. Every building gets a front desk: a face at the door
> you can just talk to, and a resident who answers from their pocket. It's
> built on Mistral end to end: a Voice Agent, Workflows, Le Chonk, Voxtral and
> Vibe.

## 2. The problem (0:15, 30 s)

> It's 7:42 in the evening. A courier buzzes flat 12 with a parcel. The
> resident is upstairs in the shower; the handset rings once. Nobody answers,
> so the courier either leaves, and you get a "sorry we missed you" card, or
> tailgates the next resident in, and now there's a stranger in the lobby and
> no record of either.
>
> Big buildings fix this with a 24-hour concierge desk. Most buildings can't
> pay for one. So we built the desk.

## 3. Live demo (0:45, 2:00)

Say the slide in one breath, then switch to the door tab.

> Here's what you'll see: I ring the door, talk to it, and the resident answers
> from the phone.

**Click path:**

1. **Door tab** (`le-concierge-door.vercel.app`), full screen. Press **Space**
   to ring the bell. The face wakes up and greets you.
   > This is the door. It's a Mistral Voice Agent: Voxtral hears me, Voxtral
   > speaks back, and each door gets its own live session.
2. **Talk to it.** Say: *"Hi, I'm Sam, I'm here to see Persia in flat 12."*
   Interrupt it once while it's talking, to show barge-in.
   > I can interrupt it, like a person.
3. It says "Let me check with them, one moment." That's the `ask_resident`
   tool firing.
   > That tool just started a Mistral Workflow, `visitor-arrival`. It describes
   > my snapshot, transcribes me, decides who it's for, and now it's waiting.
4. **Phone.** Hold it up (or show the mirror). The visit for flat 12 appears
   with the photo and what was said. Tap **Sign and open**.
   > The resident sees who's there and what they said, and signs the entry.
5. **Door.** The face says the answer out loud.
   > The approve tap is a signal, `resident-decision`. The workflow was paused
   > on it, and it just resumed.
6. **Studio tab.** Studio → Workflows → Executions → the newest
   `visitor-arrival` run. Point at the activity list and at the signal.
   > Every step, recorded and durable. If the worker crashes mid-visit, the
   > run carries on where it stopped.
7. **Vibe terminal.** Type:
   *"Who's in the building, and is there anything odd on CCTV?"*
   > And the building manager just asks Vibe. It goes through our
   > `le-concierge` MCP server and skill: `who_is_in`, and `cctv_log`, which
   > puts anything suspicious first.

   If time is short, skip step 7: slide 5 covers it.

If anything stalls for more than 10 seconds: say *"Let me show you the
recording"*, play the demo video, and keep talking over it.

## 4. How it works (2:45, 40 s)

> On the left, the door: a Mistral Voice Agent, mistral-small for the live
> turns, Voxtral in and out. Its tools hand off to Mistral Workflows, running
> in Studio. `visitor-arrival` posts the visit to the phone and waits for the
> approve-or-decline signal. `parcel-arrival` reads a parcel label and tells
> the flat. `nightly-digest` runs at seven every evening. `cctv-event` turns
> camera clips into log lines, like "Unknown person 4 tailgates into the
> building". The building manager talks to all of it from Vibe through MCP.

## 5. Where we use Mistral (3:25, 40 s)

This is the slide for the Agents and Workflows bonus: say it plainly.

> Where we use Mistral, exactly. The door **is** a Voice Agent, with three
> tools. Four **Workflows** in Studio, one waiting on a signal, one on a
> schedule. **Le Chonk** does the thinking jobs that can wait: the digest,
> parcel notices, and flagging suspicious CCTV. We tried it at the door: at
> full reasoning it took 74 seconds, and nobody waits 74 seconds on a doorstep,
> so Small keeps the door live. **Voxtral** hears and speaks, inside the agent
> and inside the workflow, in the same voice. And **Vibe**, with our MCP
> server, is the manager's way in.

## 6. Privacy by design (4:05, 20 s)

> A concierge remembers residents, not strangers. Faces are matched on the
> device. A face is stored only after the resident taps "that was me".
> Visitors are never enrolled; the vision model describes a scene, it never
> identifies anyone. And there's no account or password: the phone app works
> anonymously.

## 7. What's next (4:25, 20 s)

> Next: every camera, with multi-camera CCTV and lift tracking in one log.
> Every phone line, with the same voice agent on a phone number. And every
> building: one concierge per building, one face per door.

## 8. Team and links (4:45, 15 s)

> That's Le Concierge. The door and the phone are live at these links: come and
> ring the door. Thank you.

---

## Likely questions

- **Why not Le Chonk at the door?** Measured: full reasoning took 74 s for the
  door decision. A visitor will not wait that long, so the door runs on Small
  and Le Chonk takes the jobs where a minute doesn't matter.
- **What if the resident doesn't answer?** `visitor-arrival` waits on the
  signal with a timeout (60 s by default); on timeout it declines and the door
  says so.
- **What if the voice session can't start?** The door falls back to recording
  six seconds and playing the workflow's Voxtral reply.
- **Can two doors talk over each other?** No. Each door page has its own id and
  its own socket, so a door only hears its own visitors.
- **Does the vision model recognise people?** No. It describes the scene and
  reads labels. Recognition is face-api.js on the device, and only for
  residents who opted in.
