import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiMode,
  bytesLabel,
  confidenceLabel,
  distanceLabel,
  fetchPendingVisits,
  fetchSnapshot,
  formatTime,
  msLabel,
  openLive,
  publishSnapshot,
  recordedSpeech,
  recordedVisit,
  speechAudioUrl,
  startArrival,
  useTheme,
  useWebcam,
  type Snapshot,
  type Visit,
} from "@le-concierge/ui";
import Face, { gazeFrom } from "../components/Face";
import { loadDoorShot, saveDoorShot } from "../data";
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

/**
 * The door itself: a face that talks, the visitor's own words, and the camera
 * this laptop is using as a stand-in for the intercom.
 */
export default function DoorScreen({ onOpenLedger }: { onOpenLedger: () => void }) {
  const { theme, toggle } = useTheme();
  const camera = useWebcam();
  const mic = useMicrophone();
  /** Live, the door starts empty and follows the workflow; offline it shows the recorded run. */
  const [visit, setVisit] = useState<Visit | null>(apiMode === "live" ? null : recordedVisit);
  /** What the door said: the execution's spoken text wins over the proposal. */
  const said = visit?.speech?.text ?? visit?.reply ?? "";
  const [live, setLive] = useState<"off" | "connecting" | "on">(apiMode === "live" ? "connecting" : "off");
  const [starting, setStarting] = useState(false);
  /** The last photograph a resident's phone sent, pushed over the socket. */
  const [phoneShot, setPhoneShot] = useState<Snapshot | null>(null);
  /** Everyone waiting right now, newest first: the desk's queue. */
  const [queue, setQueue] = useState<Visit[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [spoken, setSpoken] = useState(false);
  const [shot, setShot] = useState<string | null>(() => loadDoorShot());
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const talkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** The wav the door last said, so a socket frame does not repeat it. */
  const spokenFor = useRef<string | null>(null);

  const stopSpeech = useCallback(() => {
    if (talkTimer.current) clearTimeout(talkTimer.current);
    talkTimer.current = null;
    window.speechSynthesis?.cancel();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
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

  /**
   * In live mode the door follows the building-wide feed (`/live?scope=door`):
   * every flat's visits arrive over one socket, and the flat on screen is the
   * one the workflow decided, never one the door assumed.
   */
  useEffect(() => {
    if (apiMode !== "live") return;
    let open = true;
    void fetchPendingVisits().then((waiting) => {
      if (!open) return;
      setQueue(waiting);
      if (waiting[0]) setVisit((focused) => focused ?? waiting[0]);
    });
    const socket = openLive(
      { scope: "door" },
      (next) => {
        if (!open) return;
        setLive("on");
        // Which visit the face is talking about: the one on screen, or the one
        // that just got an answer — because that is the one the door must say.
        // A different visitor waiting in the queue does not steal the screen.
        setVisit((focused) => {
          if (!focused) return { ...next, mode: "workflow" };
          const settled = focused.status !== "arriving" && focused.status !== "pending_decision";
          const answered = Boolean(next.speech?.audioUrl);
          if (focused.id === next.id || answered || settled) {
            setSpoken(false);
            return { ...next, mode: "workflow" };
          }
          return focused;
        });
        // One frame per change, so the queue is maintained rather than
        // re-fetched. A Map keeps it keyed by visit id: a frame that arrives
        // twice can never show up as two visitors.
        setQueue((waiting) => {
          const rows = new Map(waiting.map((entry) => [entry.id, entry]));
          const stillWaiting = next.status === "pending_decision" || next.status === "arriving";
          if (stillWaiting) rows.set(next.id, { ...next, mode: "workflow" as const });
          else rows.delete(next.id);
          return [...rows.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)));
        });
      },
      // A photograph from the phone lands here and stops: the door shows it
      // without taking one of its own.
      (snapshot) => {
        if (open) setPhoneShot(snapshot);
      },
    );
    if (socket.transport === "none") setLive("off");
    else setLive("on");
    return () => {
      open = false;
      socket.close();
    };
  }, []);

  /**
   * The doorbell. A button for now; MediaPipe will press it when it sees a
   * face (issue #3).
   */
  const startVisit = useCallback(async () => {
    setStarting(true);
    setNotice(null);
    // Listen first: what the visitor says is how the workflow finds the flat.
    const audio = await mic.record();
    const created = await startArrival({ flat: null, snapshot: shot, audio });
    setStarting(false);
    if (!created) {
      setNotice("The doorbell could not reach the API. Is it running on :3000?");
      return;
    }
    stopSpeech();
    spokenFor.current = null;
    setSpoken(false);
    const arrived = freshVisit(created.visitId, created.executionId);
    // A frame for this visit may already have arrived over the socket.
    setVisit((focused) => (focused?.id === arrived.id ? focused : arrived));
    setQueue((waiting) => {
      const rows = new Map(waiting.map((entry) => [entry.id, entry]));
      if (!rows.has(arrived.id)) rows.set(arrived.id, arrived);
      return [...rows.values()];
    });
    setNotice(
      audio
        ? "A visitor is here. The workflow is working out which flat; that flat decides on the phone."
        : "A visitor is here, but the microphone heard nothing, so the workflow has no speech to go on.",
    );
  }, [mic, shot, stopSpeech]);

  /**
   * The browser's own voice, used only when there is no Voxtral wav to play.
   * The notice names the stand-in rather than passing it off as the model, and
   * the face moves for as long as the sentence would take either way.
   */
  const speakWithBrowser = useCallback(() => {
    if (typeof window.speechSynthesis === "undefined") {
      setNotice("No speech voice in this browser, so the face mimes the sentence.");
      return;
    }
    const words = said.trim().split(/\s+/).length;
    const duration = Math.min(9000, Math.max(1700, words * 340));
    setSpeaking(true);
    talkTimer.current = setTimeout(() => {
      setSpeaking(false);
      setSpoken(true);
    }, duration);

    const utterance = new SpeechSynthesisUtterance(said);
    utterance.lang = "en-GB";
    utterance.rate = 0.98;
    utterance.pitch = 0.95;
    const voice = window.speechSynthesis.getVoices().find((candidate) => candidate.lang.startsWith("en-GB"));
    if (voice) utterance.voice = voice;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => {
      stopSpeech();
      setSpoken(true);
    };
    utterance.onerror = () => {
      setNotice("The voice stopped early, so the subtitles carry the reply.");
    };
    window.speechSynthesis.speak(utterance);
  }, [said, stopSpeech]);

  /**
   * Say the reply. Voxtral's own wav comes first: it is peak-normalised to
   * -1 dBFS by the worker and played at volume 1, so what the visitor hears is
   * the model, at the loudest level that does not clip. The browser voice is
   * only the stand-in when the API kept no audio for this execution.
   */
  const speak = useCallback(() => {
    stopSpeech();
    setNotice(null);
    const source = speechAudioUrl(visit?.speech);

    if (!source) {
      setNotice("No wav on this execution, so the browser voice reads the reply.");
      speakWithBrowser();
      return;
    }

    const audio = new Audio(source);
    audio.volume = 1;
    audioRef.current = audio;
    audio.onended = () => {
      audioRef.current = null;
      setSpeaking(false);
      setSpoken(true);
    };
    audio.onerror = () => {
      audioRef.current = null;
      setNotice("The wav did not load, so the browser voice reads the reply.");
      speakWithBrowser();
    };
    setSpeaking(true);
    void audio.play().catch(() => {
      audioRef.current = null;
      setNotice("The browser blocked playback, so it reads the reply itself.");
      speakWithBrowser();
    });
  }, [speakWithBrowser, stopSpeech, visit?.speech]);

  /**
   * Nobody presses a button at an intercom. When the workflow attaches audio to
   * the visit on screen, the door says it — once per wav, so a re-render or a
   * socket frame does not repeat the sentence.
   */
  useEffect(() => {
    const url = visit?.speech?.audioUrl;
    if (!url || spokenFor.current === url) return;
    spokenFor.current = url;
    speak();
  }, [speak, visit?.speech?.audioUrl]);

  function takePhoto() {
    const data = camera.capture();
    if (!data) {
      setNotice("No frame yet — the camera needs a second to open.");
      return;
    }
    setShot(data);
    saveDoorShot(data);
    // The same channel, the other way: once the workflow has named a flat,
    // that flat sees who is standing here. Before then the photograph goes
    // with the arrival itself.
    const flat = visit?.flat;
    if (!flat) return;
    void publishSnapshot({ flat, dataUrl: data, source: "door" }).then((stored) => {
      setNotice(stored ? `Sent to flat ${flat}'s phone.` : null);
    });
  }

  /** The phone's photograph only counts for the flat on screen. */
  useEffect(() => {
    const flat = visit?.flat;
    if (apiMode !== "live" || !flat) return;
    let open = true;
    void fetchSnapshot(flat).then((snapshot) => {
      if (open && snapshot) setPhoneShot(snapshot);
    });
    return () => {
      open = false;
    };
  }, [visit?.flat]);

  const speech = visit?.speech ?? (apiMode === "live" ? null : recordedSpeech);
  const flatShot = phoneShot && visit?.flat && phoneShot.flat === visit.flat ? phoneShot : null;
  const photo = flatShot?.dataUrl ?? shot;
  const photoBy = flatShot
    ? `flat ${flatShot.flat}'s phone · ${formatTime(flatShot.at)}`
    : shot
      ? "photographed just now"
      : null;
  const flatLabel = visit?.flat ? `flat ${visit.flat}` : visit ? "flat not decided yet" : "nobody at the door";

  return (
    <div className="kiosk" onPointerMove={(event) => setGaze(gazeFrom(event))}>
      <div className="door-head">
      <header className="bar">
        <div className="bar-id">
          <p className="mono small muted">the door · {flatLabel}</p>
          <p className="bar-name">Le Concierge</p>
        </div>
        <div className="bar-actions">
          <span className="mode-badge mono" data-mode={apiMode}>
            {apiMode === "live" ? "live" : "recorded run"}
          </span>
          <button
            type="button"
            className="btn-ghost mono small theme-toggle"
            onClick={toggle}
            aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
          >
            {theme === "light" ? "dark" : "light"}
          </button>
          <button type="button" className="btn-quiet small" onClick={onOpenLedger}>
            The log <span aria-hidden="true">→</span>
          </button>
        </div>
      </header>

      {apiMode === "live" ? (
        <div className="live-strip" data-live={live}>
          <p className="mono small">
            <span className="live-dot" data-live={live} aria-hidden="true" />
            {live === "on" ? "live · the door is waiting" : live === "connecting" ? "live · connecting" : "live · socket down"}
          </p>
          <p className="small muted">Pressed here, answered on the resident's phone.</p>
          {mic.state === "recording" ? (
            <button type="button" className="btn btn-small" onClick={mic.stop}>
              Listening… done speaking
            </button>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => void startVisit()} disabled={starting}>
              {starting ? "starting the workflow…" : "A visitor is here"}
            </button>
          )}
        </div>
      ) : null}
      </div>

      {queue.length ? (
        <ol className="queue" aria-label="Waiting at the door">
          <li className="queue-head">
            <span className="mono small muted">
              {queue.length === 1 ? "one visitor waiting" : `${queue.length} visitors waiting`}
            </span>
          </li>
          {queue.slice(0, 6).map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="queue-row"
                data-active={entry.id === visit?.id}
                onClick={() => {
                  stopSpeech();
                  spokenFor.current = null;
                  setSpoken(false);
                  setVisit(entry);
                }}
              >
                <span className="mono small">{formatTime(entry.at)}</span>
                <span className="queue-where">{entry.flat ? `flat ${entry.flat}` : "flat not decided yet"}</span>
                <span className="mono small muted">{entry.status === "arriving" ? "arriving" : "waiting"}</span>
                <span className="queue-say small">{entry.transcript || entry.reply || "still reading the doorstep"}</span>
                <span className="mono small">{confidenceLabel(entry.confidence)}</span>
              </button>
            </li>
          ))}
          {queue.length > 6 ? (
            <li className="queue-head">
              <span className="mono small muted">and {queue.length - 6} more</span>
            </li>
          ) : null}
        </ol>
      ) : null}

      <main className="kiosk-main">
        <div className="kiosk-face">
          <Face speaking={speaking} gaze={gaze} />
          <p className="mono small muted face-caption" aria-live="polite">
            {speaking ? "speaking" : mic.state === "recording" ? "listening" : spoken ? "finished" : "waiting"}
          </p>
        </div>

        {visit ? (
        <div className="kiosk-say">
          <div className="say-head">
            <span className="mono small muted">
              {formatTime(visit.at)} · {flatLabel}
              {visit.parcel?.courier ? ` · ${visit.parcel.courier}` : ""}
            </span>
            <span className="stamp" data-status={visit.status}>
              {spoken
                ? "answered"
                : visit.status === "approved"
                  ? "let in"
                  : visit.status === "declined"
                    ? "not let in"
                    : visit.status === "expired"
                      ? "no answer"
                      : visit.status === "arriving"
                        ? "arriving"
                        : "at the door"}
            </span>
          </div>
          {visit.transcript ? (
            <blockquote className="visitor">“{visit.transcript}”</blockquote>
          ) : (
            <p className="small muted">no intercom audio, so the workflow had nothing to transcribe</p>
          )}
          <p className="reply">{said}</p>
          <div className="say-actions">
            <button type="button" className="btn" onClick={speak}>
              {speaking ? "Speaking…" : spoken ? "Say it again" : "Speak the reply"}
            </button>
            <button type="button" className="btn-quiet" onClick={stopSpeech} disabled={!speaking}>
              Stop
            </button>
          </div>
          {notice ? (
            <p className="small notice" role="status">
              {notice}
            </p>
          ) : null}
        </div>
        ) : (
          <div className="kiosk-say">
            <p className="reply">Nobody is at the door.</p>
            {notice ? (
              <p className="small notice" role="status">
                {notice}
              </p>
            ) : null}
          </div>
        )}
      </main>

      <footer className="kiosk-foot">
        <figure className="door-plate">
          {photo ? (
            <img src={photo} alt="The visitor, as the building last saw them" />
          ) : camera.state === "live" ? (
            <video className="door-video" ref={camera.attach} muted playsInline />
          ) : (
            <div className="shot-empty">
              <span className="mono small">the door has no photograph yet</span>
            </div>
          )}
          <figcaption className="mono small muted">
            {photoBy ?? "this laptop's camera stands in for the intercom"}
          </figcaption>
        </figure>

        <div className="foot-cam">
          <div className="foot-cam-actions">
            {camera.state === "live" ? (
              <>
                <button type="button" className="btn-quiet" onClick={takePhoto}>
                  Take the photograph
                </button>
                <button type="button" className="btn-quiet" onClick={camera.stop}>
                  Close the camera
                </button>
              </>
            ) : (
              <button type="button" className="btn-quiet" onClick={() => void camera.start()}>
                {camera.state === "asking" ? "asking for the camera…" : "Open the camera"}
              </button>
            )}
            {camera.state === "live" ? <video className="camera-preview" ref={camera.attach} muted playsInline /> : null}
          </div>
          {camera.state === "denied" || camera.state === "unsupported" ? (
            <p className="small muted">
              {camera.state === "denied"
                ? `Camera refused${camera.error ? ` (${camera.error})` : ""}. The door still speaks; there is just no photograph.`
                : "No camera in this browser. The door still speaks."}
            </p>
          ) : null}
        </div>

        {visit ? (
        <div className="foot-record">
          <div className="record-line">
            <span>face distance</span>
            <b>{distanceLabel(visit.faceDistance)}</b>
          </div>
          <div className="record-line">
            <span>flat</span>
            <b>{visit.flat || "not decided yet"}</b>
          </div>
          <div className="record-line">
            <span>sure of the flat</span>
            <b>{confidenceLabel(visit.confidence)}</b>
          </div>
          <div className="record-line">
            <span>parcel</span>
            <b>{visit.parcel?.label ?? "none read"}</b>
          </div>
          <div className="record-line">
            <span>run</span>
            <b>{visit.executionId?.slice(0, 12)}…</b>
          </div>
        </div>

        ) : null}

        {speech ? (
        <div className="foot-record speech-record" aria-label="How the reply was spoken">
          <div className="record-line">
            <span>speak_reply</span>
            <b>{speech.transport}</b>
          </div>
          <div className="record-line">
            <span>model</span>
            <b>{speech.model}</b>
          </div>
          <div className="record-line">
            <span>voice</span>
            <b>{speech.voiceId}</b>
          </div>
          <div className="record-line">
            <span>audio</span>
            <b>
              {bytesLabel(speech.audioBytes)} · {speech.chunks} chunks
            </b>
          </div>
          <div className="record-line">
            <span>gain</span>
            <b>{speech.gainDb ? `${speech.gainDb > 0 ? "+" : ""}${speech.gainDb} dB` : "as received"}</b>
          </div>
          <div className="record-line">
            <span>first chunk</span>
            <b>{msLabel(speech.firstChunkMs)}</b>
          </div>
          <div className="record-line">
            <span>audio length</span>
            <b>{msLabel(speech.durationMs)}</b>
          </div>
        </div>
        ) : null}
      </footer>
    </div>
  );
}
