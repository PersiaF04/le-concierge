import { useEffect, useRef, useState } from "react";
import type { VisitStatus } from "@le-concierge/ui";

type Outcome = "admitted" | "refused";

const OUTCOME: Partial<Record<VisitStatus, Outcome>> = {
  approved: "admitted",
  declined: "refused",
  expired: "refused",
};

/** How long a stamp stays on the door before it fades. */
const HOLD_MS = 2500;

/** A soft two-note chime, made on the spot: no audio file to ship. */
function chime(context: AudioContext | null) {
  if (!context) return;
  try {
    void context.resume();
    const start = context.currentTime + 0.02;
    const out = context.createGain();
    out.gain.value = 0.16;
    out.connect(context.destination);
    for (const [i, hz] of [659.25, 987.77].entries()) {
      const at = start + i * 0.13;
      const osc = context.createOscillator();
      const env = context.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(1, at + 0.012);
      env.gain.exponentialRampToValueAtTime(0.001, at + 1.1);
      osc.connect(env).connect(out);
      osc.start(at);
      osc.stop(at + 1.2);
    }
  } catch {
    /* no audio: the stamp still lands */
  }
}

/**
 * The visit's outcome, stamped across the door in ink: ADMITTED when the
 * resident opens (with a chime and the door's line parting), a quieter NOT
 * TODAY when they decline or nobody answers. It lands once per visit, when the
 * status the door already follows turns final, then fades. It sits over the
 * page and takes no space, so nothing moves.
 */
export default function OutcomeStamp({
  visitId,
  status,
  audio,
}: {
  visitId: string | null | undefined;
  status: VisitStatus | null | undefined;
  /** The door's unlocked AudioContext, for the chime. */
  audio: () => AudioContext | null;
}) {
  const [shown, setShown] = useState<{ key: string; outcome: Outcome } | null>(null);
  /** Visits seen still waiting: only those can stamp, so a page load never replays an old outcome. */
  const open = useRef(new Set<string>());
  const stamped = useRef(new Set<string>());

  useEffect(() => {
    if (!visitId || !status) return;
    const outcome = OUTCOME[status];
    if (!outcome) {
      open.current.add(visitId);
      return;
    }
    if (!open.current.has(visitId) || stamped.current.has(visitId)) return;
    stamped.current.add(visitId);
    setShown({ key: `${visitId}:${status}`, outcome });
    if (outcome === "admitted") chime(audio());
  }, [audio, status, visitId]);

  useEffect(() => {
    if (!shown) return;
    const timer = setTimeout(() => setShown(null), HOLD_MS + 700);
    return () => clearTimeout(timer);
  }, [shown]);

  if (!shown) return null;
  return (
    <div className="outcome" data-outcome={shown.outcome} key={shown.key} role="status">
      <svg className="outcome-defs" aria-hidden="true" width="0" height="0">
        <filter id="lc-ink" x="-5%" y="-10%" width="110%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="warp" />
          <feDisplacementMap in="SourceGraphic" in2="warp" scale="5" result="rough" />
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="grain" />
          <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -2.2 1.95" result="speckle" />
          <feComposite in="rough" in2="speckle" operator="in" />
        </filter>
      </svg>
      <div className="outcome-stamp">{shown.outcome === "admitted" ? "Admitted" : "Not today"}</div>
      {shown.outcome === "admitted" && (
        <div className="outcome-door" aria-hidden="true">
          <span />
          <span />
        </div>
      )}
    </div>
  );
}
