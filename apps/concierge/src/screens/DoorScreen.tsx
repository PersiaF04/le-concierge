import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiMode,
  doorId,
  openLive,
  publishSnapshot,
  recordedVisit,
  speechAudioUrl,
  startArrival,
  useTheme,
  useWebcam,
  type Visit,
} from "@le-concierge/ui";
import Captions, { WORD_MS } from "../components/Captions";
import Face, { gazeFrom, type FaceMood } from "../components/Face";
import OutcomeStamp from "../components/OutcomeStamp";
import { useVisitorLook } from "../gaze";
import { saveDoorShot } from "../data";
import { useMicrophone } from "../mic";
import { openDoorVoice, type Decision } from "../voice";

/**
 * A visit the door has just rung for. Every field starts empty: the workflow
 * fills in the flat, the transcript and the reply, so nothing is carried over
 * from whoever was at the door before.
 */
function freshVisit(id: string, executionId: string | null): Visit {
  return {
    id,
    flat: "",
    residentId: null,
    status: "arriving",
    at: new Date().toISOString(),
    timeoutSeconds: 0,
    transcript: "",
    confidence: 0,
    faceDistance: null,
    reply: "",
    executionId,
    doorId,
    parcel: null,
    snapshot: null,
    speech: null,
    mode: "workflow",
  };
}

const waiting = (visit: Visit | null) => visit?.status === "arriving" || visit?.status === "pending_decision";

/** End the conversation after this long without anyone saying anything. */
const SILENCE_MS = 90_000;
/** After the agent hangs up or the resident answers, end this long after the last word. */
const WIND_DOWN_MS = 10_000;
/** The page's only text while nobody is talking to the door. */
const HINT = "Hold Space or press and hold to talk";

/** What the door says when the API refuses the flat (the API normally sends its own line). */
function refusalLine(reason: "no_such_flat" | "no_resident", flat: string): string {
  return reason === "no_such_flat"
    ? `I'm sorry, there is no flat ${flat} in this building. Could you check the number?`
    : `I'm sorry, there is nobody registered at flat ${flat}, so I can't reach them.`;
}

/** No progress for this long (no reply, a hung tool): the door says goodbye and hangs up. */
const STUCK_MS = 10_000;
const GOODBYE = "Thanks for stopping by, goodbye!";

/** A line reduced to its words, to spot the agent saying the same thing twice. */
const words = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);

/** The same line, or nearly: at least 85 % of the words shared. */
function nearlySame(a: string, b: string): boolean {
  const x = words(a);
  const y = words(b);
  if (!x.length || !y.length) return false;
  if (x.join(" ") === y.join(" ")) return true;
  const right = new Set(y);
  const shared = new Set(x.filter((word) => right.has(word))).size;
  return shared / new Set([...x, ...y]).size >= 0.85;
}

/**
 * Development only: `?mood=speaking` pins the face, and `?stamp=approved`
 * (or `declined`) lands a stamp, for screenshots. Stripped from the build.
 */
const preview = import.meta.env.DEV ? new URLSearchParams(window.location.search) : null;
const previewMood = (preview?.get("mood") ?? null) as FaceMood | null;
const previewStamp = (preview?.get("stamp") ?? null) as Visit["status"] | null;

/** If the agent has not started speaking this long after the resident answered, the door says it. */
const CONFIRM_AFTER_MS = 3000;
/** The door's own confirmation of the resident's answer. */
const CONFIRMATION: Record<Decision, string> = {
  approved: "Good news, the resident has accepted. Please come in.",
  declined: "Sorry, the resident has declined the visit.",
  expired: "Sorry, the resident didn't answer in time.",
};
const DECIDED = new Set<Visit["status"]>(["approved", "declined", "expired"]);

/** How long a line stays up after it was said. */
const CAPTION_HOLD_MS = 2500;

type VoiceSession = Awaited<ReturnType<typeof openDoorVoice>>;
type AgentState = "initializing" | "idle" | "listening" | "thinking" | "speaking";

/** Loudness of one analyser frame, 0…1. */
function loudness(node: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  node.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const value of buffer) {
    const sample = (value - 128) / 128;
    sum += sample * sample;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 3);
}

/**
 * The door is the concierge's face and nothing else. The camera (video only)
 * runs in the background; the microphone is closed until someone holds to talk.
 * Push-to-talk: hold Space, the face, or the control that appears when the
 * pointer reaches the bottom-left corner. The first hold rings the bell; the
 * mic is live only while held. Esc ends the conversation. The log lives on its
 * own page (#ledger).
 *
 * Live, the bell opens a Mistral Voice Agent conversation (see ../voice.ts). If
 * that cannot start, the door falls back to the recorded pipeline: record while
 * held, post the arrival on release, and play the workflow's Voxtral reply. Either
 * way there is one voice, the API's, and no browser speech.
 */
export default function DoorScreen() {
  useTheme();
  const camera = useWebcam();
  const mic = useMicrophone();
  /** Live, the door starts empty and follows only its own visits; offline it shows the recorded run. */
  const [visit, setVisit] = useState<Visit | null>(apiMode === "live" ? null : recordedVisit);
  const [ringing, setRinging] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** A line on screen with no audio behind it (no wav, or the browser refused to play). */
  const [captionOnly, setCaptionOnly] = useState(false);
  /** The photograph taken when the bell rang. */
  const [shot, setShot] = useState<string | null>(null);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  /** How long each word of the reply takes to say, from the audio when there is some. */
  const [pace, setPace] = useState(WORD_MS);
  /** A detached element on the background camera, for the face to find the visitor in. */
  const [cameraFeed, setCameraFeed] = useState<HTMLVideoElement | null>(null);
  const visitor = useVisitorLook(cameraFeed);
  const look = useCallback(() => visitor.current, [visitor]);
  /** The previewed stamp lands on a visit that was waiting a moment before, as a real one does. */
  const [previewStatus, setPreviewStatus] = useState<Visit["status"] | null>(previewStamp && "pending_decision");
  useEffect(() => {
    if (!previewStamp) return;
    const timer = setTimeout(() => setPreviewStatus(previewStamp), 400);
    return () => clearTimeout(timer);
  }, []);

  // The live conversation.
  const [inConversation, setInConversation] = useState(false);
  const [agentState, setAgentState] = useState<AgentState>("idle");
  /** Push-to-talk: the visitor is holding Space, the face or the desk control. */
  const [holding, setHolding] = useState(false);
  const held = useRef(false);
  /** Released, and the agent has not answered yet. */
  const [awaitingReply, setAwaitingReply] = useState(false);
  /** A line the door shows on its own: the fallback's flat refusal, or the stuck-loop goodbye. */
  const [notice, setNoticeText] = useState("");
  /** The conversation's microphone track, so it can be stopped whatever the SDK does. */
  const localTrack = useRef<MediaStreamTrack | null>(null);
  /** The agent hung up or the resident answered: a short silence ends it. */
  const windingDown = useRef(false);
  /** The stuck-loop clock, the agent's last finished line, and whether ask_resident is waiting. */
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastAgentLine = useRef("");
  const askingResident = useRef(false);
  /** Esc was pressed while the bell was still connecting: do not fall back to recording. */
  const cancelled = useRef(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [agentLine, setAgentLine] = useState("");
  const [lineHeld, setLineHeld] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const agentAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Playback of the fallback pipeline's wav.
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  /** Visits this page rang for through the fallback: the only ones whose wav it may play. */
  const ringedFor = useRef(new Set<string>());
  /** The wav the door last said, so a socket frame does not repeat it. */
  const spokenFor = useRef<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samples = useRef(new Uint8Array(1024));
  /** The agent's own audio, for the mouth while the door plays nothing of its own. */
  const agentAnalyserRef = useRef<AnalyserNode | null>(null);
  /** Runs once when the door's current line is over (played, captioned or cut off). */
  const speechDone = useRef<(() => void) | null>(null);

  // Confirming the resident's answer out loud.
  const visitRef = useRef(visit);
  visitRef.current = visit;
  /** The visit ask_resident rang for, and the wav the workflow attached to it. */
  const askedVisit = useRef<string | null>(null);
  const askedSpeech = useRef<Visit["speech"]>(null);
  /** When the agent last said anything (a transcript, or its speaking state). */
  const agentSpokeAt = useRef(0);
  const agentStateRef = useRef<AgentState>("idle");
  /** A confirmation is due or playing: the wind-down must not close the session yet. */
  const confirming = useRef(false);
  const [answerPending, setAnswerPending] = useState(false);
  const setConfirming = useCallback((pending: boolean) => {
    confirming.current = pending;
    setAnswerPending(pending);
  }, []);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Fallback visits whose answer the door has already confirmed. */
  const confirmedFor = useRef(new Set<string>());

  /** What the door says: the agent's line in a conversation, else the workflow's reply. */
  const said = notice || (inConversation ? agentLine : (visit?.speech?.text ?? visit?.reply ?? ""));

  const audio = useCallback(() => contextRef.current, []);

  /** How loud the door is right now, for the mouth. */
  const level = useCallback(() => {
    const node = analyserRef.current ?? agentAnalyserRef.current;
    if (node) return loudness(node, samples.current);
    const t = performance.now() / 1000;
    return 0.25 + 0.55 * Math.abs(Math.sin(t * 8.5)) * Math.abs(Math.sin(t * 2.1 + 0.6));
  }, []);

  /**
   * Browsers only let audio through a Web Audio graph after a gesture, so the
   * context is made, or resumed, on every tap or key press at the door.
   */
  const unlockAudio = useCallback(() => {
    if (!contextRef.current && typeof AudioContext !== "undefined") contextRef.current = new AudioContext();
    void contextRef.current?.resume();
    return contextRef.current;
  }, []);

  useEffect(() => {
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, [unlockAudio]);

  /** The door's line is over: run whatever was waiting for it, once. */
  const lineDone = useCallback(() => {
    const done = speechDone.current;
    speechDone.current = null;
    done?.();
  }, []);

  const stopSpeech = useCallback(() => {
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = null;
    try {
      sourceRef.current?.stop();
    } catch {
      /* already stopped */
    }
    sourceRef.current = null;
    analyserRef.current = null;
    setSpeaking(false);
    setCaptionOnly(false);
    lineDone();
  }, [lineDone]);

  /** No audio to play: the line stays on screen for about as long as it takes to read. */
  const showCaption = useCallback(
    (text: string) => {
      const words = text.trim().split(/\s+/).length;
      setCaptionOnly(true);
      if (captionTimer.current) clearTimeout(captionTimer.current);
      captionTimer.current = setTimeout(
        () => {
          captionTimer.current = null;
          setCaptionOnly(false);
          lineDone();
        },
        Math.min(9000, Math.max(2000, words * 380)),
      );
    },
    [lineDone],
  );

  /** Show a line with no audio behind it (a flat refusal, the goodbye), or clear it. */
  const setNotice = useCallback(
    (text: string) => {
      setNoticeText(text);
      if (text) showCaption(text);
    },
    [showCaption],
  );

  /** The camera (video only, no audio track) runs in the background, ready to photograph the doorstep. */
  const { start: startCamera, attach: attachCamera, state: cameraState } = camera;
  useEffect(() => {
    void startCamera();
  }, [startCamera]);

  /** Once the camera is live, the face watches the same stream (nothing is added to the page). */
  useEffect(() => {
    if (cameraState !== "live") return;
    const feed = document.createElement("video");
    feed.muted = true;
    feed.playsInline = true;
    attachCamera(feed);
    setCameraFeed(feed);
    return () => {
      feed.srcObject = null;
      setCameraFeed(null);
    };
  }, [attachCamera, cameraState]);

  /**
   * In live mode the door follows its own feed (`/live?scope=door&door=<id>`):
   * only visits this page started reach it, so another open door never speaks.
   */
  useEffect(() => {
    if (apiMode !== "live") return;
    let open = true;
    const socket = openLive({ scope: "door", door: doorId }, (next) => {
      if (!open || next.doorId !== doorId) return;
      if (next.id === askedVisit.current && next.speech) askedSpeech.current = next.speech;
      setVisit((focused) => (!focused || focused.id === next.id || !waiting(focused) ? { ...next, mode: "workflow" } : focused));
    });
    return () => {
      open = false;
      socket.close();
    };
  }, []);

  /**
   * Say a line. The wav is decoded and played through the AudioContext the
   * bell press unlocked, and its analyser, so autoplay rules do not apply, the
   * mouth moves and the voice is always Voxtral's. Without a wav, or if the
   * browser still refuses, the line is shown silently. `onDone` runs once the
   * line is over, however it ends.
   */
  const playLine = useCallback(
    async (text: string, source: string | null, onDone?: () => void) => {
      stopSpeech();
      speechDone.current = onDone ?? null;
      if (!text) {
        lineDone();
        return;
      }
      const context = contextRef.current;
      if (!source || !context) {
        showCaption(text);
        return;
      }
      try {
        await context.resume();
        const response = await fetch(source);
        if (!response.ok) throw new Error(`${response.status}`);
        const buffer = await context.decodeAudioData(await response.arrayBuffer());
        const node = context.createAnalyser();
        node.fftSize = samples.current.length;
        const player = context.createBufferSource();
        player.buffer = buffer;
        player.connect(node);
        node.connect(context.destination);
        player.onended = () => {
          if (sourceRef.current !== player) return;
          sourceRef.current = null;
          analyserRef.current = null;
          setSpeaking(false);
          lineDone();
        };
        sourceRef.current = player;
        analyserRef.current = node;
        const count = text.trim().split(/\s+/).length;
        setPace(Math.min(600, Math.max(220, (buffer.duration * 1000 * 0.92) / count)));
        setSpeaking(true);
        player.start();
      } catch (error) {
        console.warn("[door] could not play the line; showing it silently", error);
        showCaption(text);
      }
    },
    [lineDone, showCaption, stopSpeech],
  );

  /** Say the workflow's reply (the fallback pipeline). */
  const speak = useCallback(() => playLine(said, speechAudioUrl(visit?.speech)), [playLine, said, visit?.speech]);

  /**
   * When the workflow attaches audio to a visit this page rang for, the door
   * says it, once per wav. Never during a conversation (the agent speaks then),
   * and never for a visit the page did not ring for in this load.
   */
  useEffect(() => {
    const url = visit?.speech?.audioUrl;
    if (!url || !visit || spokenFor.current === url) return;
    if (inConversation || !ringedFor.current.has(visit.id)) return;
    spokenFor.current = url;
    void speak();
  }, [inConversation, speak, visit, visit?.speech?.audioUrl]);

  /**
   * The fallback always says the resident's answer: if no wav has played for
   * the visit 3 s after the answer landed, the door captions it.
   */
  const fallbackAnswer =
    !inConversation && visit && ringedFor.current.has(visit.id) && DECIDED.has(visit.status) ? visit.id : null;
  useEffect(() => {
    const decided = visitRef.current;
    if (!fallbackAnswer || decided?.id !== fallbackAnswer || confirmedFor.current.has(fallbackAnswer)) return;
    confirmedFor.current.add(fallbackAnswer);
    const sentence = CONFIRMATION[decided.status as Decision];
    setTimeout(() => {
      const now = visitRef.current;
      if (now?.id === fallbackAnswer && now.speech?.audioUrl && spokenFor.current === now.speech.audioUrl) return;
      console.info(`[door] no wav for "${decided.status}" yet; captioning the answer`);
      setNotice(sentence);
    }, CONFIRM_AFTER_MS);
  }, [fallbackAnswer, setNotice]);

  // ── the live conversation ─────────────────────────────────────────────────

  /**
   * Restart the auto-end clock: 90 s without anyone saying anything, or only
   * 10 s once the agent has hung up or the resident has answered.
   */
  const resetSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    const ms = windingDown.current ? WIND_DOWN_MS : SILENCE_MS;
    const close = () => {
      // Winding down, the answer's confirmation (the agent's or the door's) is heard to the end first.
      if (windingDown.current && (confirming.current || agentStateRef.current === "speaking")) {
        silenceTimer.current = setTimeout(close, 500);
        return;
      }
      console.info(`[door] ${ms / 1000} s with nothing said, ending the conversation`);
      void sessionRef.current?.close();
    };
    silenceTimer.current = setTimeout(close, ms);
  }, []);

  /** The conversation is over: everything is reset and the microphone is let go. */
  const endConversation = useCallback(() => {
    lastAgentLine.current = "";
    askingResident.current = false;
    for (const timer of [silenceTimer, holdTimer, stuckTimer]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    sessionRef.current = null;
    // The SDK stops its track on close; stopping it here too costs nothing.
    localTrack.current?.stop();
    localTrack.current = null;
    windingDown.current = false;
    const element = agentAudioRef.current;
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    agentAnalyserRef.current = null;
    agentStateRef.current = "idle";
    setInConversation(false);
    setAgentState("idle");
    setAwaitingReply(false);
    setToolBusy(false);
    setLineHeld(false);
    // The visit ask_resident started is over for this door; a late frame may bring it back.
    setVisit(null);
  }, []);

  /** Push-to-talk: the conversation's microphone is live only while the visitor holds. */
  const setMicLive = useCallback(async (live: boolean) => {
    const session = sessionRef.current;
    if (!session) return;
    try {
      await session.setInputEnabled(live);
    } catch {
      const track = session.localTrack ?? localTrack.current;
      if (track) track.enabled = live;
    }
  }, []);

  const clearStuck = useCallback(() => {
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    stuckTimer.current = null;
  }, []);

  /**
   * The conversation is going nowhere: say the goodbye and hang up. The SDK
   * cannot make the agent speak on demand (`update()` only applies at the next
   * turn, and there will be none), so the line is shown as the door's own
   * subtitle; the agent's instructions ask it to do the same in its voice.
   */
  const sayGoodbye = useCallback(
    (why: string) => {
      clearStuck();
      const session = sessionRef.current;
      if (!session) return;
      console.info(`[door] no progress (${why}): saying goodbye`);
      setNotice(GOODBYE);
      void session.close();
    },
    [clearStuck, setNotice],
  );

  /** Start the 10 s no-progress clock, unless ask_resident is still waiting for the resident. */
  const armStuck = useCallback(
    (why: string) => {
      clearStuck();
      if (askingResident.current) return;
      stuckTimer.current = setTimeout(() => sayGoodbye(why), STUCK_MS);
    },
    [clearStuck, sayGoodbye],
  );

  /** After the agent hangs up or the resident answers, a quiet door ends after 10 s. */
  const windDown = useCallback(() => {
    windingDown.current = true;
    resetSilence();
  }, [resetSilence]);

  /**
   * ask_resident has the answer. If the agent has not started speaking 3 s
   * later, the door says it: the workflow's wav for the visit when there is
   * one, else the sentence as a caption. It runs even if the session has ended
   * in the meantime, so the visitor always hears the answer.
   */
  const confirmDecision = useCallback(
    (decision: Decision) => {
      const decidedAt = performance.now();
      setConfirming(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => {
        confirmTimer.current = null;
        if (agentSpokeAt.current > decidedAt) {
          setConfirming(false);
          return;
        }
        console.info(`[door] the agent did not confirm "${decision}"; the door says it`);
        const sentence = CONFIRMATION[decision];
        setNoticeText(sentence);
        void playLine(sentence, speechAudioUrl(askedSpeech.current), () => {
          setConfirming(false);
          setNoticeText((current) => (current === sentence ? "" : current));
          if (sessionRef.current) resetSilence();
        });
      }, CONFIRM_AFTER_MS);
    },
    [playLine, resetSilence, setConfirming],
  );

  /** Open a Voice Agent session and wire its events to the face. Throws if it cannot start. */
  const startConversation = useCallback(async () => {
    const session = await openDoorVoice({
      snapshot: () => camera.capture(),
      onVisit: (id) => {
        askedVisit.current = id;
        askedSpeech.current = null;
        setVisit(freshVisit(id, null));
      },
      onDecision: (decision) => {
        confirmDecision(decision);
        windDown();
      },
    });
    sessionRef.current = session;

    session.on("audio_track", ({ track, source }) => {
      if (source === "local") {
        // Muted from the start unless the visitor is still holding.
        localTrack.current = track;
        track.enabled = held.current;
        return;
      }
      const stream = new MediaStream([track]);
      const element = agentAudioRef.current;
      const context = contextRef.current;
      if (context) {
        try {
          const node = context.createAnalyser();
          node.fftSize = samples.current.length;
          context.createMediaStreamSource(stream).connect(node);
          agentAnalyserRef.current = node;
        } catch {
          agentAnalyserRef.current = null;
        }
      }
      if (!element) return;
      element.srcObject = stream;
      void element
        .play()
        .then(() => {
          // The SDK also attaches the track to an element of its own; this one
          // is playing, so that one is muted to avoid an echo.
          const transport = (session as unknown as { _transport?: { _attachedElements?: HTMLMediaElement[] } })
            ._transport;
          for (const other of transport?._attachedElements ?? []) other.muted = true;
        })
        .catch((error) => console.warn("[door] <audio> refused to play; the SDK's element plays instead", error));
    });

    let previous: string = "idle";
    session.on("agent_state_changed", ({ state }) => {
      setAgentState(state as AgentState);
      agentStateRef.current = state as AgentState;
      if (state === "speaking") agentSpokeAt.current = performance.now();
      if (state === "speaking" || state === "thinking") clearStuck();
      if (state === "speaking") {
        setAwaitingReply(false);
        resetSilence();
      } else if (previous === "speaking" && (state === "listening" || state === "idle") && !held.current) {
        armStuck("no reply from the visitor");
      }
      previous = state;
    });

    session.on("transcript", ({ role, content, final }) => {
      if (role === "user") {
        // The visitor said more: the conversation is not over after all.
        windingDown.current = false;
        clearStuck();
        resetSilence();
        return;
      }
      agentSpokeAt.current = performance.now();
      if (final) {
        if (nearlySame(content, lastAgentLine.current)) {
          sayGoodbye("the agent repeated itself");
          return;
        }
        lastAgentLine.current = content;
      }
      resetSilence();
      setAwaitingReply(false);
      setAgentLine(content);
      setLineHeld(true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (final) holdTimer.current = setTimeout(() => setLineHeld(false), CAPTION_HOLD_MS);
    });

    session.on("tool_call_started", ({ name }) => {
      console.info(`[door] tool ${name} started`);
      setToolBusy(true);
      if (name === "hang_up") windDown();
      else if (name === "ask_resident") {
        // Waiting for the resident, with a "checking" filler, is not a loop.
        askingResident.current = true;
        clearStuck();
      } else armStuck(`tool ${name} hung`);
    });
    session.on("tool_call_ended", ({ name, status }) => {
      console.info(`[door] tool ${name} ${status}`);
      setToolBusy(false);
      if (name === "ask_resident") askingResident.current = false;
      else clearStuck();
      if (name === "hang_up") windDown();
      else resetSilence();
    });
    session.on("unhandled_tool", ({ name }) => console.warn(`[door] the agent asked for an unknown tool: ${name}`));
    session.on("error", (event) => console.warn("[door] voice agent error", event));
    session.on("disconnected", ({ reason }) => {
      console.info(`[door] conversation ended${reason ? ` (${reason})` : ""}`);
      endConversation();
    });

    setAgentLine("");
    setInConversation(true);
    try {
      await session.connect();
    } catch (error) {
      endConversation();
      void session.close().catch(() => {});
      throw error;
    }
    if (sessionRef.current !== session) return;
    await setMicLive(held.current);
    if (!held.current) setAwaitingReply(true);
    resetSilence();
    void session.wait().then(endConversation, endConversation);
  }, [armStuck, camera, clearStuck, confirmDecision, endConversation, resetSilence, sayGoodbye, setMicLive, windDown]);

  /**
   * The fallback doorbell: photograph the doorstep, record while the visitor
   * holds, and start the workflow with both when they let go. A flat the
   * building does not have, or one with nobody registered, is said on screen.
   */
  const ringRecorded = useCallback(
    async (photo: string | null) => {
      const audio = held.current ? await mic.record() : null;
      if (cancelled.current) return;
      const created = await startArrival({ flat: null, snapshot: photo, audio, doorId });
      if (!created) return;
      if ("refused" in created) {
        setNotice(created.reply || refusalLine(created.refused, created.flat));
        return;
      }
      setNotice("");
      spokenFor.current = null;
      ringedFor.current.add(created.visitId);
      const arrived = freshVisit(created.visitId, created.executionId);
      // A frame for this visit may already have arrived over the socket.
      setVisit((focused) => (focused?.id === arrived.id ? focused : arrived));
    },
    [mic],
  );

  const ring = useCallback(async () => {
    setRinging(true);
    setNotice("");
    cancelled.current = false;
    // A new visitor: the last one's pending confirmation is dropped.
    if (confirmTimer.current) clearTimeout(confirmTimer.current);
    confirmTimer.current = null;
    setConfirming(false);
    stopSpeech();
    const photo = camera.capture();
    if (photo) {
      setShot(photo);
      saveDoorShot(photo);
    }
    try {
      await startConversation();
      console.info("[door] path: Mistral Voice Agent");
    } catch (error) {
      if (!cancelled.current) {
        console.info("[door] path: record-and-reply fallback (voice agent unavailable)", error);
        await ringRecorded(photo);
      }
    } finally {
      setRinging(false);
    }
  }, [camera, ringRecorded, setConfirming, startConversation, stopSpeech]);

  /**
   * Press and hold (Space, the face, or the desk control): the first press
   * rings the bell and opens the conversation; in a conversation it opens the
   * microphone until the release. Offline it replays the recorded reply.
   */
  const hold = useCallback(() => {
    unlockAudio();
    if (apiMode !== "live") {
      void speak();
      return;
    }
    if (held.current) return;
    held.current = true;
    setHolding(true);
    if (sessionRef.current) {
      void setMicLive(true);
      clearStuck();
      if (silenceTimer.current) clearTimeout(silenceTimer.current);
      return;
    }
    if (!ringing && mic.state !== "recording") void ring();
  }, [clearStuck, mic.state, ring, ringing, setMicLive, speak, unlockAudio]);

  /** The release sends what was said: the mic goes quiet and the agent's turn begins. */
  const letGo = useCallback(() => {
    if (!held.current) return;
    held.current = false;
    setHolding(false);
    if (sessionRef.current) {
      void setMicLive(false);
      setAwaitingReply(true);
      resetSilence();
      // The agent should answer within 10 s; a hold with nothing said gets nothing back.
      armStuck("no reply after the release");
    }
    mic.stop();
  }, [armStuck, mic, resetSilence, setMicLive]);

  /** Esc, or the desk control: end the conversation (or drop the recording) and let go of the mic. */
  const end = useCallback(() => {
    cancelled.current = true;
    held.current = false;
    setHolding(false);
    mic.stop();
    if (sessionRef.current) void sessionRef.current.close();
  }, [mic]);

  useEffect(() => {
    const onDown = (event: KeyboardEvent) => {
      if (event.code === "Escape") {
        end();
        return;
      }
      if (event.code !== "Space" || event.repeat) return;
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      hold();
    };
    const onUp = (event: KeyboardEvent) => {
      if (event.code === "Space") letGo();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("pointerup", letGo);
    window.addEventListener("pointercancel", letGo);
    window.addEventListener("blur", letGo);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("pointerup", letGo);
      window.removeEventListener("pointercancel", letGo);
      window.removeEventListener("blur", letGo);
    };
  }, [end, hold, letGo]);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      stopSpeech();
      void sessionRef.current?.close();
    },
    [stopSpeech],
  );

  /** Once a flat is known, that flat sees who is standing here. */
  const flat = visit?.flat;
  useEffect(() => {
    if (apiMode !== "live" || !flat || !shot) return;
    void publishSnapshot({ flat, dataUrl: shot, source: "door", doorId });
  }, [flat, shot]);

  const agentSpeaking = inConversation && agentState === "speaking";
  const mood: FaceMood = inConversation
    ? speaking
      ? "speaking"
      : toolBusy
        ? "thinking"
        : agentSpeaking
          ? "speaking"
          : holding
            ? "listening"
            : awaitingReply || agentState === "thinking"
              ? "thinking"
              : "idle"
    : speaking
      ? "speaking"
      : mic.state === "recording" || (ringing && holding)
        ? "listening"
        : ringing || (apiMode === "live" && waiting(visit))
          ? "thinking"
          : "idle";

  /** Nobody is talking to the door: the face rests, dimmed, with the one hint. */
  const resting = (previewMood ?? mood) === "idle" && !inConversation && !captionOnly;
  const faceMood = previewMood ?? mood;
  const showLine = captionOnly || speaking || previewMood === "speaking" || (inConversation && (agentSpeaking || lineHeld));
  const line = showLine && said ? said : resting ? HINT : "";

  return (
    <div className="door" onPointerMove={(event) => setGaze(gazeFrom(event))}>
      <main className="door-stage">
        <div
          className="door-face"
          onPointerDown={(event) => {
            event.preventDefault();
            hold();
          }}
        >
          <Face mood={faceMood} level={level} gaze={gaze} look={look} resting={resting} />
        </div>
        <Captions
          text={line}
          show={Boolean(line)}
          hint={line === HINT}
          msPerWord={(inConversation && !speaking) || captionOnly ? WORD_MS : pace}
        />
        <audio ref={agentAudioRef} hidden />
      </main>

      <OutcomeStamp
        visitId={previewStatus ? "preview" : visit?.id}
        status={previewStatus ?? visit?.status}
        audio={audio}
        hold={answerPending}
      />

      <div className="door-desk">
        {inConversation ? (
          <button type="button" className="btn-quiet small" onClick={end}>
            End the conversation
            <span className="mono small muted"> · esc</span>
          </button>
        ) : (
          <button
            type="button"
            className="btn-quiet small"
            onPointerDown={(event) => {
              event.preventDefault();
              hold();
            }}
          >
            {apiMode === "live" ? (holding ? "Release to send" : "Hold to talk") : "Say the reply"}
            <span className="mono small muted"> · space</span>
          </button>
        )}
      </div>
    </div>
  );
}
