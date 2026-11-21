import { useCallback, useEffect, useState } from "react";
import {
  apiMode,
  confidenceLabel,
  confirmThatWasMe,
  distanceLabel,
  fetchCurrentVisit,
  formatTime,
  openLive,
  secondsLabel,
  sendDecision,
  stampFor,
  useCountdown,
  useWebcam,
  type Decision,
  type Resident,
  type Visit,
} from "@le-concierge/ui";

export default function VisitScreen({ resident }: { resident: Resident }) {
  const [visit, setVisit] = useState<Visit | null>(null);
  const [pending, setPending] = useState<Decision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remote, setRemote] = useState<"ws" | "none">("none");
  const [remembered, setRemembered] = useState(false);
  const camera = useWebcam();

  useEffect(() => {
    let alive = true;
    void fetchCurrentVisit(resident.flat).then((next) => {
      if (alive) setVisit(next);
    });
    const link = openLive(resident.flat, (next) => setVisit(next));
    setRemote(link.transport);
    return () => {
      alive = false;
      link.close();
    };
  }, [resident.flat]);

  const waiting = visit?.status === "pending_decision";
  const left = useCountdown(visit?.timeoutSeconds ?? 0, Boolean(waiting));

  const decide = useCallback(
    async (decision: Decision) => {
      if (!visit) return;
      setPending(decision);
      setVisit((current) =>
        current
          ? {
              ...current,
              status: decision === "approve" ? "approved" : "declined",
              decidedAt: new Date().toISOString(),
            }
          : current,
      );
      const sent = await sendDecision(visit.id, decision);
      setPending(null);
      if (!sent) {
        setNotice(
          apiMode === "live"
            ? "The API did not take the answer. The stamp below is local."
            : "Recorded run: no API is configured, so the door did not actually open.",
        );
      }
    },
    [visit],
  );

  if (!visit) {
    return (
      <div className="screen">
        <p className="mono small muted">reading the log…</p>
      </div>
    );
  }

  const snapshot = camera.shot ?? visit.snapshot ?? null;

  async function remember() {
    if (!visit) return;
    const ok = await confirmThatWasMe(visit.residentId ?? resident.id);
    setRemembered(true);
    setNotice(
      ok
        ? "Saved to your face record. Next arrival should open with less of a wait."
        : "Saved on this device. The face record is not connected yet, so the next arrival still asks.",
    );
  }

  return (
    <div className="screen">
      <article className="entry" aria-labelledby="entry-title">
        <div className="entry-head">
          <time className="mono small muted" dateTime={visit.at}>
            {formatTime(visit.at)}
          </time>
          <span className="stamp" data-status={visit.status}>
            {stampFor(visit.status)}
          </span>
        </div>

        <h2 id="entry-title">{waiting ? "Someone is at the door." : "An entry in the log."}</h2>

        <blockquote className="quote">“{visit.transcript}”</blockquote>

        <div className="facts">
          <div className="record-line">
            <span>face</span>
            <b>{visit.faceDistance === null ? "no face on record" : distanceLabel(visit.faceDistance)}</b>
          </div>
          <div className="record-line">
            <span>sure it is your flat</span>
            <b>{confidenceLabel(visit.confidence)}</b>
          </div>
          {visit.parcel ? (
            <div className="record-line">
              <span>parcel</span>
              <b>
                {visit.parcel.courier} · {visit.parcel.label}
              </b>
            </div>
          ) : null}
          {visit.executionId ? (
            <div className="record-line">
              <span>run</span>
              <b className="truncate">{visit.executionId.slice(0, 12)}…</b>
            </div>
          ) : null}
        </div>

        {waiting ? (
          <div className="sign">
            <p className="mono small muted" aria-live="polite">
              {secondsLabel(left)} until the door stays shut
            </p>
            <div className="sign-line" aria-hidden="true" />
            <div className="sign-actions">
              <button type="button" className="btn" onClick={() => void decide("approve")} disabled={pending !== null}>
                Sign and open <span className="mono small">{secondsLabel(left)}</span>
              </button>
              <button
                type="button"
                className="btn-quiet"
                onClick={() => void decide("decline")}
                disabled={pending !== null}
              >
                Leave it shut
              </button>
            </div>
          </div>
        ) : (
          <div className="resolved">
            <div className="stamp stamp-landed" data-status={visit.status}>
              {stampFor(visit.status)}
            </div>
            <p className="muted">
              {visit.status === "approved"
                ? "The door opened. Your answer was stamped in the log."
                : visit.status === "declined"
                  ? "The door stayed shut. The visitor was told to try later."
                  : "No answer reached the intercom in time, so the door stayed shut."}
            </p>
            {visit.status === "approved" && !remembered ? (
              <button type="button" className="btn-quiet full" onClick={() => void remember()}>
                That was me — remember this visit
              </button>
            ) : null}
            {remembered ? <p className="small muted">Remembered.</p> : null}
          </div>
        )}

        {notice ? (
          <p className="small notice" role="status">
            {notice}
          </p>
        ) : null}

        <figure className="intercom-shot">
          {snapshot ? (
            <img src={snapshot} alt={`The intercom's view of the door at ${formatTime(visit.at)}`} />
          ) : (
            <div className="shot-empty" aria-hidden="true">
              <span className="mono small">no photograph on this run</span>
            </div>
          )}
          <figcaption className="record-line">
            <span>the door, {formatTime(visit.at)}</span>
            <span>{snapshot ? (camera.shot ? "this device" : "intercom") : "—"}</span>
          </figcaption>
        </figure>

        {!snapshot ? (
          camera.state === "live" ? (
            <button type="button" className="btn-quiet full" onClick={() => camera.capture()}>
              Take the photograph
            </button>
          ) : (
            <button type="button" className="btn-quiet full" onClick={() => void camera.start()}>
              {camera.state === "asking" ? "asking for the camera…" : "Use this laptop's camera instead"}
            </button>
          )
        ) : null}

        {camera.state === "live" ? (
          <video className="camera-preview" ref={camera.videoRef} muted playsInline />
        ) : null}

        {camera.state === "denied" || camera.state === "unsupported" ? (
          <p className="small muted">
            {camera.state === "denied"
              ? "Camera refused. The log still works; you will just not see who is standing there."
              : "This browser has no camera access. The log still works without a photograph."}
          </p>
        ) : null}
      </article>

      <p className="small muted remote-line">
        {remote === "ws" ? "connected to the door" : "not connected — this is the last recorded arrival"}
        {" · "}
        {apiMode === "live" ? "API" : "no API"}
      </p>
    </div>
  );
}
