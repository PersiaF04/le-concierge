import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiMode,
  bytesLabel,
  confidenceLabel,
  distanceLabel,
  fetchCurrentVisit,
  formatTime,
  msLabel,
  openLive,
  recordedSpeech,
  recordedVisit,
  startArrival,
  useTheme,
  useWebcam,
  type Visit,
} from "@le-concierge/ui";
import Face, { gazeFrom } from "../components/Face";
import { loadDoorShot, saveDoorShot } from "../data";

/**
 * The door itself: a face that talks, the visitor's own words, and the camera
 * this laptop is using as a stand-in for the intercom.
 */
export default function DoorScreen({ onOpenLedger }: { onOpenLedger: () => void }) {
  const { theme, toggle } = useTheme();
  const camera = useWebcam();
  const [visit, setVisit] = useState<Visit>(recordedVisit);
  /** What the door said: the execution's spoken text wins over the proposal. */
  const said = visit.speech?.text ?? visit.reply;
  const [live, setLive] = useState<"off" | "connecting" | "on">(apiMode === "live" ? "connecting" : "off");
  const [starting, setStarting] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [spoken, setSpoken] = useState(false);
  const [shot, setShot] = useState<string | null>(() => loadDoorShot());
  const [gaze, setGaze] = useState({ x: 0, y: 0 });
  const [notice, setNotice] = useState<string | null>(null);
  const talkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopSpeech = useCallback(() => {
    if (talkTimer.current) clearTimeout(talkTimer.current);
    talkTimer.current = null;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  useEffect(
    () => () => {
      if (talkTimer.current) clearTimeout(talkTimer.current);
      window.speechSynthesis?.cancel();
    },
    [],
  );

  /**
   * In live mode the door follows whatever the workflow posts for flat 12:
   * the API broadcasts each visit change over the socket, so the door needs no
   * polling loop of its own.
   */
  useEffect(() => {
    if (apiMode !== "live") return;
    let open = true;
    void fetchCurrentVisit("12").then((current) => {
      if (!open || current.id === recordedVisit.id) return;
      setVisit(current);
    });
    const socket = openLive("12", (next) => {
      if (!open) return;
      setLive("on");
      setSpoken(false);
      setVisit({ ...next, mode: "workflow" });
    });
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
    const created = await startArrival({
      flat: "12",
      snapshot: shot,
      face: { resident_id: "res_12_persia", distance: 0.31 },
    });
    setStarting(false);
    if (!created) {
      setNotice("The doorbell could not reach the API. Is it running on :3000?");
      return;
    }
    setSpoken(false);
    setVisit((previous) => ({
      ...previous,
      id: created.visitId,
      executionId: created.executionId,
      status: "arriving",
      mode: "workflow",
    }));
    setNotice("A visitor is here. The workflow is running; flat 12 decides on the phone.");
  }, [shot]);

  /**
   * The face moves for as long as the sentence would take, whether or not this
   * browser has a voice: a silent laptop should still look like it is talking,
   * and the notice says which of the two just happened.
   */
  const speak = useCallback(() => {
    stopSpeech();
    setNotice(null);
    const words = said.trim().split(/\s+/).length;
    const duration = Math.min(9000, Math.max(1700, words * 340));
    setSpeaking(true);
    talkTimer.current = setTimeout(() => {
      setSpeaking(false);
      setSpoken(true);
    }, duration);

    if (typeof window.speechSynthesis === "undefined") {
      setNotice("No speech voice in this browser, so the face mimes the sentence.");
      return;
    }

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

  function takePhoto() {
    const data = camera.capture();
    if (!data) {
      setNotice("No frame yet — the camera needs a second to open.");
      return;
    }
    setShot(data);
    saveDoorShot(data);
    setNotice(null);
  }

  const speech = visit.speech ?? recordedSpeech;

  return (
    <div className="kiosk" onPointerMove={(event) => setGaze(gazeFrom(event))}>
      <div className="door-head">
      <header className="bar">
        <div className="bar-id">
          <p className="mono small muted">the door · flat 12</p>
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
          <button type="button" className="btn btn-small" onClick={() => void startVisit()} disabled={starting}>
            {starting ? "starting the workflow…" : "A visitor is here"}
          </button>
        </div>
      ) : null}
      </div>

      <main className="kiosk-main">
        <div className="kiosk-face">
          <Face speaking={speaking} gaze={gaze} />
          <p className="mono small muted face-caption" aria-live="polite">
            {speaking ? "speaking" : spoken ? "finished" : "listening"}
          </p>
        </div>

        <div className="kiosk-say">
          <div className="say-head">
            <span className="mono small muted">{formatTime(visit.at)} · DPD</span>
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
      </main>

      <footer className="kiosk-foot">
        <figure className="door-plate">
          {shot ? (
            <img src={shot} alt="The visitor as this camera sees them" />
          ) : camera.state === "live" ? (
            <video className="door-video" ref={camera.videoRef} muted playsInline />
          ) : (
            <div className="shot-empty">
              <span className="mono small">the door has no photograph yet</span>
            </div>
          )}
          <figcaption className="mono small muted">
            {shot ? "photographed just now" : "this laptop's camera stands in for the intercom"}
          </figcaption>
        </figure>

        <div className="foot-cam">
          <div className="foot-cam-actions">
            {camera.state === "live" ? (
              <button type="button" className="btn-quiet" onClick={takePhoto}>
                Take the photograph
              </button>
            ) : (
              <button type="button" className="btn-quiet" onClick={() => void camera.start()}>
                {camera.state === "asking" ? "asking for the camera…" : "Open the camera"}
              </button>
            )}
            {camera.state === "live" ? <video className="camera-preview" ref={camera.videoRef} muted playsInline /> : null}
          </div>
          {camera.state === "denied" || camera.state === "unsupported" ? (
            <p className="small muted">
              {camera.state === "denied"
                ? "Camera refused. The door still speaks; there is just no photograph."
                : "No camera in this browser. The door still speaks."}
            </p>
          ) : null}
        </div>

        <div className="foot-record">
          <div className="record-line">
            <span>face distance</span>
            <b>{distanceLabel(visit.faceDistance)}</b>
          </div>
          <div className="record-line">
            <span>sure it is flat 12</span>
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
            <span>first chunk</span>
            <b>{msLabel(speech.firstChunkMs)}</b>
          </div>
          <div className="record-line">
            <span>audio length</span>
            <b>{msLabel(speech.durationMs)}</b>
          </div>
        </div>
      </footer>
    </div>
  );
}
