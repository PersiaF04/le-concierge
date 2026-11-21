import { useCallback, useEffect, useState } from "react";
import {
  apiMode,
  fetchCurrentVisit,
  fetchSnapshot,
  formatTime,
  openLive,
  recordedVisit,
  sendDecision,
  stampFor,
  type Decision,
  type Resident,
  type Snapshot,
  type Visit,
} from "@le-concierge/ui";

/** The stamp for a visit; a fallback went to the desk rather than "recorded". */
function stampOf(status: Visit["status"]): string {
  return status === "fallback" ? "with the desk" : stampFor(status);
}

/** The result, in a few words, once the visit is settled. */
const RESULT: Partial<Record<Visit["status"], string>> = {
  approved: "The door opened.",
  declined: "You left it shut.",
  expired: "No answer in time, so the door stayed shut.",
  fallback: "The desk is looking after this visitor.",
};

/**
 * One visitor, plainly: their photograph, what they said, and the two answers.
 * Nothing about how the building worked it out.
 */
export default function VisitScreen({ resident }: { resident: Resident }) {
  const [visit, setVisit] = useState<Visit | null>(null);
  /** False until the API has answered, so "nobody at the door" is never a guess. */
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [failed, setFailed] = useState(false);
  /** The last photograph either surface took, pushed over the socket. */
  const [remoteShot, setRemoteShot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchCurrentVisit(resident.flat).then((next: Visit | null) => {
      if (!alive) return;
      // Live, "nobody is waiting" means an empty doorstep, never the recorded
      // demo visit. A socket frame may have landed first; it is at least as fresh.
      const real = !next || (apiMode === "live" && next.id === recordedVisit.id) ? null : next;
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
    return () => {
      alive = false;
      link.close();
    };
  }, [resident.flat]);

  const waiting = visit?.status === "pending_decision";

  const decide = useCallback(
    async (decision: Decision) => {
      if (!visit) return;
      setPending(decision);
      setFailed(false);
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
      if (!sent && apiMode === "live") {
        // Put the buttons back so the resident can answer again.
        setFailed(true);
        setVisit((current) => (current?.id === visit.id ? { ...current, status: visit.status, decidedAt: null } : current));
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
          </article>
        ) : (
          <p className="mono small muted">reading the log…</p>
        )}
      </div>
    );
  }

  const snapshot = remoteShot?.dataUrl ?? visit.snapshot ?? null;
  const result = RESULT[visit.status];

  return (
    <div className="screen">
      <article className="entry" aria-labelledby="entry-title">
        <div className="entry-head">
          <time className="mono small muted" dateTime={visit.at}>
            {formatTime(visit.at)} · flat {visit.flat}
          </time>
          <span className="stamp" data-status={visit.status}>
            {stampOf(visit.status)}
          </span>
        </div>

        <h2 id="entry-title">
          {waiting || visit.status === "arriving" ? "Someone is at the door." : "Someone came to the door."}
        </h2>

        <figure className="intercom-shot">
          {snapshot ? (
            <img src={snapshot} alt={`The visitor at the door, ${formatTime(visit.at)}`} />
          ) : (
            <div className="shot-empty" aria-hidden="true">
              <span className="mono small">no photograph</span>
            </div>
          )}
        </figure>

        {visit.transcript ? <blockquote className="quote quote-short">“{visit.transcript}”</blockquote> : null}

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
        ) : result ? (
          <div className="resolved">
            <div className="stamp stamp-landed" data-status={visit.status}>
              {stampOf(visit.status)}
            </div>
            <p className="muted">{result}</p>
          </div>
        ) : null}

        {failed ? (
          <p className="small notice" role="status">
            Your answer did not reach the door. Try again.
          </p>
        ) : null}
      </article>
    </div>
  );
}
