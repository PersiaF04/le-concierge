import { useCallback, useRef, useState } from "react";

export type MicState = "idle" | "recording" | "denied" | "unsupported";

/** How long the door listens after the bell before it sends what it heard. */
export const LISTEN_MS = 6000;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The door's microphone. `record()` listens for up to LISTEN_MS (or until
 * `stop()` is pressed) and resolves with the speech as a data: URL, or null
 * when there is no microphone or nothing was heard.
 */
export function useMicrophone() {
  const [state, setState] = useState<MicState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);

  const stop = useCallback(() => {
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const record = useCallback(async (ms: number = LISTEN_MS): Promise<string | null> => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setState("unsupported");
      return null;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch {
      setState("denied");
      return null;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size) chunks.push(event.data);
    };
    const finished = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    setState("recording");
    const timer = setTimeout(() => {
      if (recorder.state === "recording") recorder.stop();
    }, ms);
    await finished;
    clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    recorderRef.current = null;
    setState("idle");
    if (!chunks.length) return null;
    const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
    try {
      return await toDataUrl(blob);
    } catch {
      return null;
    }
  }, []);

  return { state, record, stop };
}
