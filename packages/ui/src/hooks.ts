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
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<CameraState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setState("idle");
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
        video: { width: { ideal: 1280 }, height: { ideal: 960 }, facingMode: "environment" },
        audio: false,
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setState("live");
    } catch (cause) {
      setState("denied");
      setError(cause instanceof Error ? cause.message : "Camera permission was refused");
    }
  }, []);

  const capture = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d")?.drawImage(video, 0, 0);
    const data = canvas.toDataURL("image/jpeg", 0.82);
    setShot(data);
    return data;
  }, []);

  useEffect(() => stop, [stop]);

  return { videoRef, state, error, shot, start, stop, capture, reset: () => setShot(null) };
}

/** Seconds left before the door stays shut. Counts down from the server's timeout. */
export function useCountdown(from: number, running: boolean): number {
  const [left, setLeft] = useState(from);
  useEffect(() => setLeft(from), [from]);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setLeft((value) => (value > 0 ? value - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [running]);
  return left;
}
