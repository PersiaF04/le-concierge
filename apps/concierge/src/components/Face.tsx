import { useEffect, useRef, type PointerEvent } from "react";

export type FaceMood = "idle" | "listening" | "thinking" | "speaking";

const LABEL: Record<FaceMood, string> = {
  idle: "Le Concierge, smiling, waiting for a visitor",
  listening: "Le Concierge, listening to you",
  thinking: "Le Concierge, thinking",
  speaking: "Le Concierge, speaking",
};

/**
 * Le Concierge's face: the whole door. Drawn in the ledger's ink, with a
 * heavier line so it reads across a lobby, and four states a visitor can tell
 * apart at a glance:
 *
 * - idle: a smile, a slow blink (dimmed while resting, when nobody is talking);
 * - listening: brows up, eyes wide, sound arcs at both ears;
 * - thinking: eyes up and aside, a dotted thought rising;
 * - speaking: the mouth opens with the loudness of the reply (`level`, 0…1,
 *   read every animation frame so the page does not re-render per frame).
 */
export default function Face({
  mood,
  level,
  gaze = { x: 0, y: 0 },
  resting = false,
}: {
  mood: FaceMood;
  /** Current loudness of the reply, 0…1. Only read while speaking. */
  level?: () => number;
  gaze?: { x: number; y: number };
  /** Nobody is talking to the door: calm, and a little dimmed. */
  resting?: boolean;
}) {
  const mouthRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    if (mood !== "speaking") return;
    let frame = 0;
    let smooth = 0;
    const tick = () => {
      const target = Math.min(1, Math.max(0, level?.() ?? 0));
      // Open fast, close a little slower: it reads as speech, not flicker.
      smooth += (target - smooth) * (target > smooth ? 0.6 : 0.25);
      const mouth = mouthRef.current;
      if (mouth) mouth.setAttribute("d", openMouth(smooth));
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [mood, level]);

  // Thinking looks up and aside; the other states follow the pointer.
  const look = mood === "thinking" ? { x: 0.8, y: -0.9 } : gaze;
  const shift = `translate(${(look.x * 4).toFixed(1)} ${(look.y * 3.5).toFixed(1)})`;
  const brows = mood === "listening" ? -7 : mood === "thinking" ? -3 : 0;
  const eyeR = mood === "listening" ? 7.5 : 6.5;

  return (
    <svg className="face" data-mood={mood} data-resting={resting} viewBox="0 0 240 240" role="img" aria-label={LABEL[mood]}>
      {/* sound arcs at the ears, only while listening */}
      <g className="face-ears" aria-hidden="true">
        <path d="M24 104 q-9 16 0 32" />
        <path d="M12 96 q-13 24 0 48" />
        <path d="M216 104 q9 16 0 32" />
        <path d="M228 96 q13 24 0 48" />
      </g>

      {/* a thought rising, only while thinking */}
      <g className="face-thought" aria-hidden="true">
        <circle cx="178" cy="40" r="5" />
        <circle cx="196" cy="24" r="7" />
        <circle cx="218" cy="10" r="9" />
      </g>

      <circle className="face-head" cx="120" cy="120" r="88" />

      <g className="face-brows" transform={`translate(0 ${brows})`}>
        <path className="face-line" d="M74 90 q15 -11 31 -4" />
        <path
          className="face-line"
          d={mood === "thinking" ? "M135 82 q16 -10 31 2" : "M135 86 q16 -7 31 4"}
        />
      </g>

      <g className="face-eyes" transform={shift}>
        <circle className="face-eye" cx="92" cy="112" r={eyeR} />
        <circle className="face-eye" cx="148" cy="112" r={eyeR} />
      </g>

      <circle className="face-cheek" cx="72" cy="140" r="9" />
      <circle className="face-cheek" cx="168" cy="140" r="9" />

      <path className="face-line" d="M118 120 q-6 15 4 19" />

      {mood === "speaking" ? (
        <path ref={mouthRef} className="face-mouth-open" d={openMouth(0)} />
      ) : mood === "thinking" ? (
        <path className="face-line" d="M110 166 q12 -3 24 1" />
      ) : mood === "listening" ? (
        <ellipse className="face-line" cx="120" cy="166" rx="8" ry="6" />
      ) : (
        <path className="face-line" d="M92 156 q28 28 56 0" />
      )}
    </svg>
  );
}

/** A smiling open mouth: a soft upper lip, and a jaw that drops with the level (0…1). */
function openMouth(level: number): string {
  const half = 22 - level * 4;
  const drop = 6 + level * 30;
  return `M${120 - half} 158 Q120 ${162 - level * 3} ${120 + half} 158 Q120 ${158 + drop} ${120 - half} 158 Z`;
}

/** Coordinates in -1…1 from the centre of whatever element the pointer is over. */
export function gazeFrom(event: PointerEvent<HTMLElement>): { x: number; y: number } {
  const box = event.currentTarget.getBoundingClientRect();
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  return {
    x: clamp(((event.clientX - box.left) / box.width - 0.5) * 2),
    y: clamp(((event.clientY - box.top) / box.height - 0.5) * 2),
  };
}
