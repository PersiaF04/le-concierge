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
import Face, { gazeFrom, type FaceMood } from "../components/Face";
import { saveDoorShot } from "../data";
import { useMicrophone } from "../mic";
import { openDoorVoice } from "../voice";

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
 * The door is the concierge's face and nothing else. The camera and the
 * microphone work in the background; the desk rings the bell with Space, a tap
 * on the face, or the control that appears when the pointer reaches the
 * bottom-left corner. The log lives on its own page (#ledger).
 *
 * Live, the bell opens a Mistral Voice Agent conversation (see ../voice.ts). If
 * that cannot start, the door falls back to the recorded pipeline: listen for
 * six seconds, post the arrival, and play the workflow's Voxtral reply. Either
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

  // The live conversation.
  const [inConversation, setInConversation] = useState(false);
  const [agentState, setAgentState] = useState<AgentState>("idle");
  const [visitorTalking, setVisitorTalking] = useState(false);
  const [toolBusy, setToolBusy] = useState(false);
  const [agentLine, setAgentLine] = useState("");
  const [lineHeld, setLineHeld] = useState(false);
  const sessionRef = useRef<VoiceSession | null>(null);
  const agentAudioRef = useRef<HTMLAudioElement | null>(null);
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const talkingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /** What the door says: the agent's line in a conversation, else the workflow's reply. */
  const said = inConversation ? agentLine : (visit?.speech?.text ?? visit?.reply ?? "");

  /** How loud the door is right now, for the mouth. */
  const level = useCallback(() => {
    const node = analyserRef.current;
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
  }, []);

  /** No audio to play: the line stays on screen for about as long as it takes to read. */
  const showCaption = useCallback((text: string) => {
    const words = text.trim().split(/\s+/).length;
    setCaptionOnly(true);
    if (captionTimer.current) clearTimeout(captionTimer.current);
    captionTimer.current = setTimeout(() => setCaptionOnly(false), Math.min(9000, Math.max(2000, words * 380)));
  }, []);

  /** The camera runs in the background, ready to photograph the doorstep. */
  const { start: startCamera } = camera;
  useEffect(() => {
    void startCamera();
  }, [startCamera]);

  /**
   * In live mode the door follows its own feed (`/live?scope=door&door=<id>`):
   * only visits this page started reach it, so another open door never speaks.
   */
  useEffect(() => {
    if (apiMode !== "live") return;
    let open = true;
    const socket = openLive({ scope: "door", door: doorId }, (next) => {
      if (!open || next.doorId !== doorId) return;
      setVisit((focused) => (!focused || focused.id === next.id || !waiting(focused) ? { ...next, mode: "workflow" } : focused));
    });
    return () => {
      open = false;
      socket.close();
    };
  }, []);

  /**
   * Say the workflow's reply (the fallback pipeline). The wav is decoded and
   * played through the AudioContext the bell press unlocked, so autoplay rules
   * do not apply and the voice is always Voxtral's. Without a wav, or if the
   * browser still refuses, the line is shown silently.
   */
  const speak = useCallback(async () => {
    stopSpeech();
    if (!said) return;
    const source = speechAudioUrl(visit?.speech);
    const context = contextRef.current;
    if (!source || !context) {
      showCaption(said);
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
      };
      sourceRef.current = player;
      analyserRef.current = node;
      setSpeaking(true);
      player.start();
    } catch (error) {
      console.warn("[door] could not play the reply; showing it silently", error);
      showCaption(said);
    }
  }, [said, showCaption, stopSpeech, visit?.speech]);

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

  // ── the live conversation ─────────────────────────────────────────────────

  const resetSilence = useCallback(() => {
    if (silenceTimer.current) clearTimeout(silenceTimer.current);
    silenceTimer.current = setTimeout(() => {
      console.info("[door] 90 s of silence, ending the conversation");
      void sessionRef.current?.close();
    }, SILENCE_MS);
  }, []);

  const endConversation = useCallback(() => {
    for (const timer of [silenceTimer, talkingTimer, holdTimer]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
    sessionRef.current = null;
    const element = agentAudioRef.current;
    if (element) {
      element.pause();
      element.srcObject = null;
    }
    analyserRef.current = null;
    setInConversation(false);
    setAgentState("idle");
    setVisitorTalking(false);
    setToolBusy(false);
    setLineHeld(false);
    // The visit ask_resident started is over for this door; a late frame may bring it back.
    setVisit(null);
  }, []);

  /** Open a Voice Agent session and wire its events to the face. Throws if it cannot start. */
  const startConversation = useCallback(async () => {
    const session = await openDoorVoice({
      snapshot: () => camera.capture(),
      onVisit: (id) => {
        setVisit(freshVisit(id, null));
      },
    });
    sessionRef.current = session;

    session.on("audio_track", ({ track, source }) => {
      if (source !== "remote") return;
      const stream = new MediaStream([track]);
      const element = agentAudioRef.current;
      const context = contextRef.current;
      if (context) {
        try {
          const node = context.createAnalyser();
          node.fftSize = samples.current.length;
          context.createMediaStreamSource(stream).connect(node);
          analyserRef.current = node;
        } catch {
          analyserRef.current = null;
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

    session.on("agent_state_changed", ({ state }) => setAgentState(state as AgentState));

    session.on("transcript", ({ role, content, final }) => {
      resetSilence();
      if (role === "user") {
        setVisitorTalking(!final);
        if (talkingTimer.current) clearTimeout(talkingTimer.current);
        talkingTimer.current = setTimeout(() => setVisitorTalking(false), 1500);
        return;
      }
      setAgentLine(content);
      setLineHeld(true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
      if (final) holdTimer.current = setTimeout(() => setLineHeld(false), CAPTION_HOLD_MS);
    });

    session.on("tool_call_started", ({ name }) => {
      console.info(`[door] tool ${name} started`);
      setToolBusy(true);
    });
    session.on("tool_call_ended", ({ name, status }) => {
      console.info(`[door] tool ${name} ${status}`);
      setToolBusy(false);
      resetSilence();
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
    resetSilence();
    void session.wait().then(endConversation, endConversation);
  }, [camera, endConversation, resetSilence]);

  /**
   * The fallback doorbell: photograph the doorstep, listen for about six
   * seconds, and start the workflow with both.
   */
  const ringRecorded = useCallback(async (photo: string | null) => {
    const audio = await mic.record();
    const created = await startArrival({ flat: null, snapshot: photo, audio, doorId });
    if (!created) return;
    spokenFor.current = null;
    ringedFor.current.add(created.visitId);
    const arrived = freshVisit(created.visitId, created.executionId);
    // A frame for this visit may already have arrived over the socket.
    setVisit((focused) => (focused?.id === arrived.id ? focused : arrived));
  }, [mic]);

  const ring = useCallback(async () => {
    setRinging(true);
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
      console.info("[door] path: record-and-reply fallback (voice agent unavailable)", error);
      await ringRecorded(photo);
    } finally {
      setRinging(false);
    }
  }, [camera, ringRecorded, startConversation, stopSpeech]);

  /**
   * One gesture for the desk: in a conversation it hangs up; while recording
   * it ends the recording; offline it replays the recorded reply; otherwise it
   * rings the bell. The gesture also unlocks the audio.
   */
  const press = useCallback(() => {
    unlockAudio();
    if (sessionRef.current) void sessionRef.current.close();
    else if (mic.state === "recording") mic.stop();
    else if (apiMode !== "live") void speak();
    else if (!ringing) void ring();
  }, [mic, ring, ringing, speak, unlockAudio]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      press();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [press]);

  useEffect(
    () => () => {
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
    ? toolBusy
      ? "thinking"
      : agentSpeaking
        ? "speaking"
        : visitorTalking
          ? "listening"
          : agentState === "thinking"
            ? "thinking"
            : "idle"
    : speaking
      ? "speaking"
      : mic.state === "recording"
        ? "listening"
        : ringing || (apiMode === "live" && waiting(visit))
          ? "thinking"
          : "idle";

  const showLine = inConversation ? agentSpeaking || lineHeld : speaking || captionOnly;

  return (
    <div className="door" onPointerMove={(event) => setGaze(gazeFrom(event))}>
      <main className="door-stage">
        <div className="door-face" onClick={press}>
          <Face mood={mood} level={level} gaze={gaze} />
        </div>
        <p className="subtitle" data-show={showLine && Boolean(said)} aria-live="polite">
          {said}
        </p>
        <audio ref={agentAudioRef} hidden />
      </main>

      <div className="door-desk">
        <button type="button" className="btn-quiet small" onClick={press}>
          {inConversation
            ? "End the conversation"
            : mic.state === "recording"
              ? "Done speaking"
              : apiMode === "live"
                ? "A visitor is here"
                : "Say the reply"}
          <span className="mono small muted"> · space</span>
        </button>
      </div>
    </div>
  );
}
