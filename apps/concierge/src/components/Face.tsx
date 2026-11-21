import type { PointerEvent } from "react";

/**
 * Le Concierge's face, drawn in the same ink and stroke weight as the ledger
 * rules. It is a portrait plate in the log, not a mascot: no gloss, no shadow,
 * no gradient — just lines that blink, look at you and move while speaking.
 */
export default function Face({
  speaking,
  gaze = { x: 0, y: 0 },
}: {
  speaking: boolean;
  gaze?: { x: number; y: number };
}) {
  const shift = `translate(${(gaze.x * 3).toFixed(1)} ${(gaze.y * 2.5).toFixed(1)})`;

  return (
    <svg
      className="face"
      viewBox="0 0 200 200"
      role="img"
      aria-label={
        speaking
          ? "Le Concierge, a line-drawn smiling face, speaking"
          : "Le Concierge, a line-drawn smiling face, listening"
      }
    >
      <circle className="face-head" cx="100" cy="100" r="74" />
      <path className="face-brow" d="M62 80 q13 -9 26 -3" />
      <path className="face-brow" d="M112 77 q13 -6 26 3" />
      <g className="face-eyes" transform={shift}>
        <circle className="face-eye" cx="76" cy="94" r="4.6" />
        <circle className="face-eye" cx="124" cy="94" r="4.6" />
      </g>
      <path className="face-nose" d="M99 102 q-5 13 3 16" />
      {speaking ? (
        <ellipse className="face-mouth-open" cx="100" cy="142" rx="20" ry="8" />
      ) : (
        <path className="face-mouth" d="M76 134 q24 24 48 0" />
      )}
    </svg>
  );
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
