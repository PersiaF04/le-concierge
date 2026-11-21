import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiMode,
  fetchPendingVisits,
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
    parcel: null,
    snapshot: null,
    speech: null,
    mode: "workflow",
  };
}

const waiting = (visit: Visit | null) => visit?.status === "arriving" || visit?.status === "pending_decision";

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
 */
export default function DoorScreen() {
  useTheme();
  const camera = useWebcam();
  const mic = useMicrophone();
  /** Live, the door starts empty and follows the workflow; offline it shows the recorded run. */
  const [visit, setVisit] = useState<Visit | null>(apiMode === "live" ? null : recordedVisit);
  /** What the door said: the execution's spoken text wins over the proposal. */
  const said = visit?.speech?.text ?? visit?.reply ?? "";
  const [ringing, setRinging] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  /** The photograph taken when the bell rang. */
  const [shot, setShot] = useState<string | null>(null);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const talkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** The wav the door last said, so a socket frame does not repeat it. */
  const spokenFor = useRef<string | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const samples = useRef(new Uint8Array(1024));

  /**
   * How loud the reply is right now, for the mouth. With Voxtral's wav it is
   * read from an AnalyserNode on the audio element; the browser voice gives no
   * samples, so the mouth gets a speech-like rhythm instead.
   */
  const level = useCallback(() => {
    const node = analyserRef.current;
    if (node) return loudness(node, samples.current);
    const t = performance.now() / 1000;
    return 0.25 + 0.55 * Math.abs(Math.sin(t * 8.5)) * Math.abs(Math.sin(t * 2.1 + 0.6));
  }, []);

  /**
   * Browsers only let audio through a Web Audio graph after a gesture, so the
   * context is made on the first tap or key press at the door.
   */
  useEffect(() => {
    const unlock = () => {
      if (!contextRef.current && typeof AudioContext !== "undefined") contextRef.current = new AudioContext();
      void contextRef.current?.resume();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, []);

  const stopSpeech = useCallback(() => {
    if (talkTimer.current) clearTimeout(talkTimer.current);
    talkTimer.current = null;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    analyserRef.current = null;
    setSpeaking(false);
  }, []);

  useEffect(
    () => () => {
      if (talkTimer.current) clearTimeout(talkTimer.current);
      window.speechSynthesis?.cancel();
      audioRef.current?.pause();
    },
    [],
  );

  /** The camera runs in the background, ready to photograph the doorstep. */
  const { start: startCamera } = camera;
  useEffect(() => {
    void startCamera();
  }, [startCamera]);

  /**
   * In live mode the door follows the building-wide feed (`/live?scope=door`):
   * every flat's visits arrive over one socket, and the flat is the one the
   * workflow decided, never one the door assumed.
   */
  useEffect(() => {
    if (apiMode !== "live") return;
    let open = true;
    void fetchPendingVisits().then((queue) => {
      if (open && queue[0]) setVisit((focused) => focused ?? queue[0]);
    });
    const socket = openLive({ scope: "door" }, (next) => {
      if (!open) return;
      // The visit on screen, or the one that just got an answer, because that
      // is the one the door must say. Another visitor does not steal the face.
      setVisit((focused) => {
        if (!focused) return { ...next, mode: "workflow" };
        const answered = Boolean(next.speech?.audioUrl);
        if (focused.id === next.id || answered || !waiting(focused)) return { ...next, mode: "workflow" };
        return focused;
      });
    });
    return () => {
      open = false;
      socket.close();
    };
  }, []);

  /** The browser's own voice, used only when there is no Voxtral wav to play. */
  const speakWithBrowser = useCallback(() => {
    analyserRef.current = null;
    const words = said.trim().split(/\s+/).length;
    const duration = Math.min(9000, Math.max(1700, words * 340));
    setSpeaking(true);
    talkTimer.current = setTimeout(() => setSpeaking(false), duration);
    if (typeof window.speechSynthesis === "undefined") return;

    const utterance = new SpeechSynthesisUtterance(said);
    utterance.lang = "en-GB";
    utterance.rate = 0.98;
    utterance.pitch = 0.95;
    const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.lang.startsWith("en-GB"));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => stopSpeech();
    window.speechSynthesis.speak(utterance);
  }, [said, stopSpeech]);

  /**
   * Say the reply. Voxtral's own wav comes first, routed through an analyser
   * so the mouth follows it; the browser voice stands in only when the API
   * kept no audio for this execution.
   */
  const speak = useCallback(() => {
    stopSpeech();
    if (!said) return;
    const source = speechAudioUrl(visit?.speech);
    if (!source) {
      speakWithBrowser();
      return;
    }
    const audio = new Audio();
    // The API allows any origin, so the analyser may read the samples.
    audio.crossOrigin = "anonymous";
    audio.src = source;
    audio.volume = 1;
    audioRef.current = audio;
    const context = contextRef.current;
    if (context?.state === "running") {
      try {
        const node = context.createAnalyser();
        node.fftSize = samples.current.length;
        context.createMediaElementSource(audio).connect(node);
        node.connect(context.destination);
        analyserRef.current = node;
      } catch {
        analyserRef.current = null;
      }
    }
    audio.onended = () => {
      audioRef.current = null;
      analyserRef.current = null;
      setSpeaking(false);
    };
    audio.onerror = () => {
      audioRef.current = null;
      speakWithBrowser();
    };
    setSpeaking(true);
    void audio.play().catch(() => {
      audioRef.current = null;
      speakWithBrowser();
    });
  }, [said, speakWithBrowser, stopSpeech, visit?.speech]);

  /**
   * Nobody presses a button at an intercom. When the workflow attaches audio to
   * the visit on screen, the door says it — once per wav.
   */
  useEffect(() => {
    const url = visit?.speech?.audioUrl;
    if (!url || spokenFor.current === url) return;
    spokenFor.current = url;
    speak();
  }, [speak, visit?.speech?.audioUrl]);

  /**
   * The doorbell: photograph the doorstep, listen for about six seconds, and
   * start the workflow with both. MediaPipe will ring it when it sees a face
   * (issue #3).
   */
  const ring = useCallback(async () => {
    setRinging(true);
    stopSpeech();
    const photo = camera.capture();
    if (photo) {
      setShot(photo);
      saveDoorShot(photo);
    }
    // What the visitor says is how the workflow finds the flat.
    const audio = await mic.record();
    const created = await startArrival({ flat: null, snapshot: photo, audio });
    setRinging(false);
    if (!created) return;
    spokenFor.current = null;
    const arrived = freshVisit(created.visitId, created.executionId);
    // A frame for this visit may already have arrived over the socket.
    setVisit((focused) => (focused?.id === arrived.id ? focused : arrived));
  }, [camera, mic, stopSpeech]);

  /**
   * One gesture for the desk: while listening it ends the recording; offline
   * it replays the recorded reply; otherwise it rings the bell.
   */
  const press = useCallback(() => {
    if (mic.state === "recording") mic.stop();
    else if (apiMode !== "live") speak();
    else if (!ringing) void ring();
  }, [mic, ring, ringing, speak]);

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

  /** Once the workflow has named a flat, that flat sees who is standing here. */
  const flat = visit?.flat;
  useEffect(() => {
    if (apiMode !== "live" || !flat || !shot) return;
    void publishSnapshot({ flat, dataUrl: shot, source: "door" });
  }, [flat, shot]);

  const mood: FaceMood = speaking
    ? "speaking"
    : mic.state === "recording"
      ? "listening"
      : ringing || (apiMode === "live" && waiting(visit))
        ? "thinking"
        : "idle";

  return (
    <div className="door" onPointerMove={(event) => setGaze(gazeFrom(event))}>
      <main className="door-stage">
        <div className="door-face" onClick={press}>
          <Face mood={mood} level={level} gaze={gaze} />
        </div>
        <p className="subtitle" data-show={speaking} aria-live="polite">
          {said}
        </p>
      </main>

      <div className="door-desk">
        <button type="button" className="btn-quiet small" onClick={press}>
          {mic.state === "recording" ? "Done speaking" : apiMode === "live" ? "A visitor is here" : "Say the reply"}
          <span className="mono small muted"> · space</span>
        </button>
      </div>
    </div>
  );
}
