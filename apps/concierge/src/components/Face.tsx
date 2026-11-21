import { useEffect, useRef, type PointerEvent } from "react";
import type { Look } from "../gaze";

export type FaceMood = "idle" | "listening" | "thinking" | "speaking";

const LABEL: Record<FaceMood, string> = {
  idle: "Le Concierge, smiling, waiting for a visitor",
  listening: "Le Concierge, listening to you",
  thinking: "Le Concierge, thinking",
  speaking: "Le Concierge, speaking",
};

/** How far the pupils travel, in viewBox units, at the edge of the frame. */
const REACH = { x: 7, y: 5 };
/** Each frame the eyes close this share of the distance to where they are looking. */
const EASE = 0.15;
/** A pointer counts as "someone there" for this long after it last moved. */
const POINTER_MS = 2500;

const between = (low: number, high: number) => low + Math.random() * (high - low);
const stillPortrait = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * Le Concierge's face: the whole door. Drawn in the ledger's ink, with a
 * heavier line so it reads across a lobby, and four states a visitor can tell
 * apart at a glance:
 *
 * - idle: a smile, a blink every few seconds (dimmed while resting, when nobody is talking);
 * - listening: brows up, eyes wide, sound arcs at both ears;
 * - thinking: eyes up and aside, a dotted thought rising;
 * - speaking: the mouth opens with the loudness of the reply (`level`, 0…1,
 *   read every animation frame so the page does not re-render per frame).
 *
 * The eyes look at the visitor the camera finds (`look`), else at the
 * pointer, else glance slowly around. The face breathes, and a soft halo
 * behind it carries the state. Under reduced motion it is a still portrait
 * that still looks at you.
 */
export default function Face({
  mood,
  level,
  gaze = { x: 0, y: 0 },
  look,
  resting = false,
}: {
  mood: FaceMood;
  /** Current loudness of the reply, 0…1. Only read while speaking. */
  level?: () => number;
  /** The pointer, in -1…1. */
  gaze?: { x: number; y: number };
  /** Where the visitor in front of the camera is, read every frame. */
  look?: () => Look;
  /** Nobody is talking to the door: calm, and a little dimmed. */
  resting?: boolean;
}) {
  const mouthRef = useRef<SVGPathElement | null>(null);
  const eyesRef = useRef<SVGGElement | null>(null);
  const haloRef = useRef<SVGCircleElement | null>(null);
  const moodRef = useRef(mood);
  moodRef.current = mood;
  const pointer = useRef({ at: 0, x: 0, y: 0 });

  useEffect(() => {
    pointer.current = { at: performance.now(), x: gaze.x, y: gaze.y };
  }, [gaze.x, gaze.y]);

  /** One loop for everything that moves per frame: the eyes, the mouth, the halo. */
  useEffect(() => {
    const still = stillPortrait();
    let frame = 0;
    let smooth = 0;
    const eyes = { x: 0, y: 0 };
    let glance = { x: 0, y: 0 };
    let nextGlance = performance.now() + between(1500, 3000);
    const tick = (now: number) => {
      const current = moodRef.current;
      const seen = look?.() ?? null;
      let target: { x: number; y: number };
      if (current === "thinking") target = { x: 0.8, y: -0.9 };
      else if (seen) target = seen;
      else if (now - pointer.current.at < POINTER_MS) target = pointer.current;
      else {
        // Nobody in view: a slow look around, coming back to the middle now and then.
        if (now > nextGlance && !still) {
          glance = Math.random() < 0.35 ? { x: 0, y: 0 } : { x: between(-0.75, 0.75), y: between(-0.45, 0.35) };
          nextGlance = now + between(2200, 4800);
        }
        target = glance;
      }
      const ease = seen ? EASE : EASE / 2.5;
      eyes.x += (target.x - eyes.x) * ease;
      eyes.y += (target.y - eyes.y) * ease;
      eyesRef.current?.setAttribute("transform", `translate(${(eyes.x * REACH.x).toFixed(2)} ${(eyes.y * REACH.y).toFixed(2)})`);

      if (current === "speaking") {
        const loud = Math.min(1, Math.max(0, level?.() ?? 0));
        // Open fast, close a little slower: it reads as speech, not flicker.
        smooth += (loud - smooth) * (loud > smooth ? 0.6 : 0.25);
        mouthRef.current?.setAttribute("d", openMouth(smooth));
        if (haloRef.current && !still) haloRef.current.style.opacity = (0.22 + smooth * 0.7).toFixed(3);
      } else {
        smooth = 0;
        if (haloRef.current?.style.opacity) haloRef.current.style.opacity = "";
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [level, look]);

  /** A blink every three to six seconds, never on a beat. */
  useEffect(() => {
    if (stillPortrait()) return;
    let timer: ReturnType<typeof setTimeout>;
    const blink = () => {
      eyesRef.current?.setAttribute("data-blink", "");
      timer = setTimeout(() => {
        eyesRef.current?.removeAttribute("data-blink");
        // Now and then, a double blink.
        const again = Math.random() < 0.15;
        timer = setTimeout(again ? blink : schedule, again ? 160 : 0);
      }, 130);
    };
    const schedule = () => {
      timer = setTimeout(blink, between(3000, 6000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  const brows = mood === "listening" ? -7 : mood === "thinking" ? -3 : 0;
  const eyeR = mood === "listening" ? 7.5 : 6.5;

  return (
    <svg className="face" data-mood={mood} data-resting={resting} viewBox="0 0 240 240" role="img" aria-label={LABEL[mood]}>
      <defs>
        <filter id="face-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
      </defs>

      {/* the state, as a soft halo behind the head */}
      <circle ref={haloRef} className="face-halo" cx="120" cy="120" r="96" filter="url(#face-glow)" aria-hidden="true" />

      <g className="face-body">
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

        <g ref={eyesRef} className="face-eyes">
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
      </g>
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
