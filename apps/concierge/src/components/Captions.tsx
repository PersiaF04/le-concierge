import { useEffect, useRef, useState } from "react";

/** Speech pace when the length of the audio is not known: about three words a second. */
export const WORD_MS = 330;

/**
 * The door's line, word by word in large type, paced with the speech. Every
 * word is laid out from the start and only fades in, so the face never moves
 * as the sentence grows. A line that grows while streaming keeps its words
 * already shown; a new line starts again from the first word.
 */
export default function Captions({
  text,
  show,
  hint = false,
  msPerWord = WORD_MS,
}: {
  text: string;
  show: boolean;
  /** A quiet instruction, shown whole rather than spoken. */
  hint?: boolean;
  msPerWord?: number;
}) {
  const [count, setCount] = useState(0);
  const started = useRef({ text: "", at: 0 });
  /** The last spoken line, kept while it fades out. */
  const last = useRef("");
  if (show && !hint && text) last.current = text;
  const shown = show || hint ? text : last.current;
  const words = shown.trim() ? shown.trim().split(/\s+/) : [];

  useEffect(() => {
    if (!show || hint || !text) return;
    const line = started.current;
    // A continuation of the line already on screen keeps its clock.
    if (!line.text || !text.startsWith(line.text)) {
      started.current = { text, at: performance.now() };
      setCount(0);
    } else {
      started.current.text = text;
    }
    const total = text.trim().split(/\s+/).length;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const step = () => {
      const due = Math.min(total, 1 + Math.floor((performance.now() - started.current.at) / msPerWord));
      setCount(due);
      if (due < total) timer = setTimeout(step, msPerWord - ((performance.now() - started.current.at) % msPerWord));
    };
    step();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [hint, msPerWord, show, text]);

  // Once the line has faded out, the next one starts fresh.
  useEffect(() => {
    if (!show) started.current = { text: "", at: 0 };
  }, [show]);

  return (
    <p className="subtitle" data-show={show} data-hint={hint} data-testid="door-line" aria-live="polite">
      {hint
        ? shown
        : words.map((word, i) => (
            <span key={i} className="word" data-on={i < count}>
              {word}{" "}
            </span>
          ))}
    </p>
  );
}
