import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiMode,
  bytesLabel,
  confidenceLabel,
  distanceLabel,
  formatTime,
  msLabel,
  recordedSpeech,
  recordedVisit,
  useTheme,
  useWebcam,
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
  const [visit] = useState(recordedVisit);
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
   * The face moves for as long as the sentence would take, whether or not this
   * browser has a voice: a silent laptop should still look like it is talking,
   * and the notice says which of the two just happened.
   */
  const speak = useCallback(() => {
    stopSpeech();
    setNotice(null);
    const words = visit.reply.trim().split(/s+/).length;
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

    const utterance = new SpeechSynthesisUtterance(visit.reply);
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
  }, [stopSpeech, visit.reply]);

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

  return (
    <div className="kiosk" onPointerMove={(event) => setGaze(gazeFrom(event))}>
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
            <span className="stamp" data-status="pending_decision">
              {spoken ? "answered" : "at the door"}
            </span>
          </div>
          <blockquote className="visitor">“{visit.transcript}”</blockquote>
          <p className="reply">{visit.reply}</p>
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
            <b>{recordedSpeech.transport}</b>
          </div>
          <div className="record-line">
            <span>model</span>
            <b>{recordedSpeech.model}</b>
          </div>
          <div className="record-line">
            <span>voice</span>
            <b>{recordedSpeech.voiceId}</b>
          </div>
          <div className="record-line">
            <span>audio</span>
            <b>
              {bytesLabel(recordedSpeech.audioBytes)} · {recordedSpeech.chunks} chunks
            </b>
          </div>
          <div className="record-line">
            <span>first chunk</span>
            <b>{msLabel(recordedSpeech.firstChunkMs)}</b>
          </div>
          <div className="record-line">
            <span>played at the door</span>
            <b>{msLabel(recordedSpeech.durationMs)}</b>
          </div>
        </div>
      </footer>
    </div>
  );
}
