import { useCallback, useEffect, useState } from "react";
import {
  apiMode,
  confirmThatWasMe,
  distanceLabel,
  fetchCurrentVisit,
  fetchPendingVisits,
  fetchSnapshot,
  formatTime,
  openLive,
  publishSnapshot,
  recordedVisit,
  sendDecision,
  stampFor,
  useWebcam,
  type Decision,
  type Resident,
  type Snapshot,
  type Visit,
} from "@le-concierge/ui";

/** The stamp for a visit; a fallback went to the desk rather than "recorded". */
function stampOf(status: Visit["status"]): string {
  return status === "fallback" ? "with the desk" : stampFor(status);
}

export default function VisitScreen({ resident }: { resident: Resident }) {
  const [visit, setVisit] = useState<Visit | null>(null);
  /** False until the API has answered, so "nobody at the door" is never a guess. */
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [remote, setRemote] = useState<"ws" | "none">("none");
  const [remembered, setRemembered] = useState(false);
  /** The last photograph either surface took, pushed over the socket. */
  const [remoteShot, setRemoteShot] = useState<Snapshot | null>(null);
  /** How many other people are at the door right now. */
  const [others, setOthers] = useState(0);
  const camera = useWebcam();

  useEffect(() => {
    let alive = true;
    void fetchCurrentVisit(resident.flat).then((next) => {
      if (!alive) return;
      // Live, the API saying "nobody is waiting" means an empty doorstep, not
      // the recorded demo visit. A socket frame may have landed first; it is
      // at least as fresh.
      const real = apiMode === "live" && next.id === recordedVisit.id ? null : next;
      setVisit((current) => current ?? real);
      setLoaded(true);
    });
    void fetchSnapshot(resident.flat).then((shot) => {
      if (alive && shot) setRemoteShot(shot);
    });
    const link = openLive(
      resident.flat,
      (next) => {
        setVisit(next);
        setLoaded(true);
      },
      (shot) => setRemoteShot(shot),
    );
    setRemote(link.transport);
    return () => {
      alive = false;
      link.close();
    };
  }, [resident.flat]);

  useEffect(() => {
    let alive = true;
    void fetchPendingVisits(resident.flat).then((queue) => {
      if (alive) setOthers(queue.filter((entry) => entry.id !== visit?.id).length);
    });
    return () => {
      alive = false;
    };
  }, [resident.flat, visit?.id]);

  const waiting = visit?.status === "pending_decision";

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
        {loaded ? (
          <article className="entry" aria-labelledby="entry-title">
            <h2 id="entry-title">Nobody is at the door.</h2>
            <p className="muted">When someone rings for flat {resident.flat}, they will appear here.</p>
          </article>
        ) : (
          <p className="mono small muted">reading the log…</p>
        )}
      </div>
    );
  }

  const snapshot = camera.shot ?? remoteShot?.dataUrl ?? visit.snapshot ?? null;
  const shotBy = camera.shot
    ? "taken on this phone"
    : remoteShot?.source === "door"
      ? "taken at the doorstep"
      : remoteShot?.source === "resident-phone"
        ? "taken on this phone"
        : visit.snapshot
          ? "the intercom"
          : "—";

  /**
   * The photograph, both ways: it stays here, and it goes to the API, which
   * pushes it to the door over the same socket that carries the visit. That is
   * why the concierge shows it the moment this button is pressed.
   */
  async function takePhoto() {
    const data = camera.capture();
    if (!data) {
      setNotice("No frame yet — the camera needs a second to open.");
      return;
    }
    // The photograph freezes in the same frame the camera was showing.
    camera.stop();
    const stored = await publishSnapshot({
      flat: resident.flat,
      dataUrl: data,
      source: "resident-phone",
      by: resident.name,
    });
    setNotice(
      stored
        ? "Sent to the door. The concierge is looking at it now."
        : "Kept on this phone only: the API did not take the photograph.",
    );
  }

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
            {stampOf(visit.status)}
          </span>
        </div>

        <h2 id="entry-title">{waiting ? "Someone is at the door." : "An entry in the log."}</h2>
        {others > 0 ? (
          <p className="small muted queue-count">
            {others === 1 ? "one more person is waiting" : `${others} more people are waiting`}
          </p>
        ) : null}

        {visit.transcript ? (
          <blockquote className="quote">“{visit.transcript}”</blockquote>
        ) : null}

        <div className="facts">
          <div className="record-line">
            <span>face</span>
            <b>{visit.faceDistance === null ? "no face on record" : distanceLabel(visit.faceDistance)}</b>
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
            <div className="sign-line" aria-hidden="true" />
            <div className="sign-actions">
              <button type="button" className="btn" onClick={() => void decide("approve")} disabled={pending !== null}>
                Sign and open
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
              {stampOf(visit.status)}
            </div>
            <p className="muted">
              {visit.status === "approved"
                ? "The door opened. Your answer was stamped in the log."
                : visit.status === "declined"
                  ? "You left it shut. The visitor was told to try later."
                  : visit.status === "arriving"
                    ? "Someone just rang. The concierge is listening to them and will ask you here if it is for you."
                    : visit.status === "fallback"
                      ? "The concierge could not start on this visit, so the desk is looking after it."
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
          {camera.state === "live" ? (
            <video ref={camera.attach} muted playsInline aria-label="This phone's camera" />
          ) : snapshot ? (
            <img src={snapshot} alt={`The intercom's view of the door at ${formatTime(visit.at)}`} />
          ) : (
            <div className="shot-empty" aria-hidden="true">
              <span className="mono small">no photograph on this run</span>
            </div>
          )}
          <figcaption className="record-line">
            <span>the door, {formatTime(visit.at)}</span>
            <span>{shotBy}</span>
          </figcaption>
        </figure>

        {camera.state === "live" ? (
          <div className="sign-actions">
            <button type="button" className="btn-quiet" onClick={() => void takePhoto()}>
              {snapshot ? "Take another photograph" : "Take the photograph"}
            </button>
            {/* One camera, one app: let go of the device rather than hold it. */}
            <button type="button" className="btn-quiet" onClick={camera.stop}>
              Close the camera
            </button>
          </div>
        ) : (
          <button type="button" className="btn-quiet full" onClick={() => void camera.start()}>
            {camera.state === "asking"
              ? "asking for the camera…"
              : snapshot
                ? "Use this phone's camera again"
                : "Use this laptop's camera instead"}
          </button>
        )}

        {camera.state === "denied" || camera.state === "unsupported" ? (
          <p className="small muted">
            {camera.state === "denied"
              ? `Camera refused${camera.error ? ` (${camera.error})` : ""}. The log still works; you will just not see who is standing there.`
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
