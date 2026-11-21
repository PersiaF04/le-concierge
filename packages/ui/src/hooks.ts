/** Small hooks the three surfaces share. */

import { useCallback, useEffect, useRef, useState } from "react";

export type Theme = "light" | "dark";

const THEME_KEY = "le-concierge:theme";

export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(THEME_KEY) as Theme | null;
    if (stored === "light" || stored === "dark") return stored;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "light" ? "dark" : "light")), []);
  return { theme, toggle };
}

export type CameraState = "idle" | "asking" | "live" | "denied" | "unsupported";

export function useWebcam() {
  const streamRef = useRef<MediaStream | null>(null);
  /**
   * A hidden element that always holds the stream. Capture reads from here, so
   * a photograph never depends on which <video> happens to be mounted: the
   * visible ones only mount once the state is already "live".
   */
  const sinkRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CameraState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (sinkRef.current) {
      sinkRef.current.srcObject = null;
      sinkRef.current = null;
    }
    setState("idle");
  }, []);

  /**
   * A ref for the visible <video> elements. React calls it when one mounts —
   * which is after start() set the state — so this is where the stream lands.
   */
  const attach = useCallback((element: HTMLVideoElement | null) => {
    if (!element || !streamRef.current) return;
    if (element.srcObject !== streamRef.current) {
      element.srcObject = streamRef.current;
    }
    void element.play().catch(() => {});
  }, []);

  const start = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }
    setState("asking");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // "ideal", not "exact": a laptop has no rear camera, and an exact
        // constraint makes Chrome fail the whole request with "Requested
        // device not found" — which is what a phone-first demo never saw and a
        // laptop always did. On a phone the rear camera is still preferred.
        video: {
          width: { ideal: 1280 },
          height: { ideal: 960 },
          facingMode: { ideal: "environment" },
        },
        audio: false,
      });
      streamRef.current = stream;
      const sink = sinkRef.current ?? document.createElement("video");
      sink.muted = true;
      sink.playsInline = true;
      sink.srcObject = stream;
      sinkRef.current = sink;
      await sink.play().catch(() => {});
      // Wait for a decoded frame before calling it live: a capture pressed the
      // instant the button appears would otherwise draw a black rectangle.
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const withFrame = sink as HTMLVideoElement & {
          requestVideoFrameCallback?: (callback: () => void) => number;
        };
        if (typeof withFrame.requestVideoFrameCallback === "function") {
          withFrame.requestVideoFrameCallback(finish);
        } else if (sink.readyState >= 2) {
          finish();
        } else {
          sink.addEventListener("loadeddata", finish, { once: true });
        }
        // A camera that never delivers a frame must not hang the button.
        setTimeout(finish, 1500);
      });
      setState("live");
    } catch (cause) {
      setState("denied");
      setError(cause instanceof Error ? cause.message : "Camera permission was refused");
    }
  }, []);

  const capture = useCallback((): string | null => {
    const video = sinkRef.current;
    // readyState 2 is HAVE_CURRENT_DATA: without it the canvas would be black.
    if (!video || !video.videoWidth || video.readyState < 2) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const data = canvas.toDataURL("image/jpeg", 0.82);
    setShot(data);
    return data;
  }, []);

  useEffect(() => stop, [stop]);

  return { attach, state, error, shot, start, stop, capture, reset: () => setShot(null) };
}
