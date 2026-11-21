import { useCallback, useEffect, useRef, useState } from "react";

export type MicState = "idle" | "recording" | "denied" | "unsupported";

/** The longest one held press may record, in case the release never arrives. */
export const MAX_HOLD_MS = 30_000;

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * The door's microphone for the recorded fallback, push-to-talk. It is closed
 * until someone holds to talk: `record()` opens it and records until `stop()`
 * (the release) or MAX_HOLD_MS, then stops every track and resolves with the
 * speech as a data: URL, or null when there is no microphone or nothing was
 * heard. A `stop()` that lands while the microphone is still opening ends the
 * recording as soon as it starts.
 */
export function useMicrophone() {
  const [state, setState] = useState<MicState>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopWanted = useRef(false);

  /** Let go of the microphone: every track stopped, so the browser's mic light goes out. */
  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  // Never leave a microphone open behind the page.
  useEffect(() => release, [release]);

  const stop = useCallback(() => {
    stopWanted.current = true;
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
  }, []);

  const record = useCallback(
    async (ms: number = MAX_HOLD_MS): Promise<string | null> => {
      stopWanted.current = false;
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
      streamRef.current = stream;
      if (stopWanted.current) {
        release();
        return null;
      }
      const chunks: Blob[] = [];
      let recorder: MediaRecorder;
      try {
        recorder = new MediaRecorder(stream);
      } catch {
        release();
        setState("unsupported");
        return null;
      }
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
      release();
      recorderRef.current = null;
      setState("idle");
      if (!chunks.length) return null;
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      try {
        return await toDataUrl(blob);
      } catch {
        return null;
      }
    },
    [release],
  );

  return { state, record, stop };
}
