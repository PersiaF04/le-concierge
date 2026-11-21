import { useEffect, useRef } from "react";

/** Where the visitor is, in -1…1 from the centre of the face's point of view, or null when nobody is in view. */
export type Look = { x: number; y: number } | null;

const VISION = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm";
const MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
/** About ten detections a second keeps the CPU low and still feels alive. */
const EVERY_MS = 100;

const clamp = (value: number) => Math.max(-1, Math.min(1, value));

/**
 * Follow the visitor with MediaPipe's face detector on the door's background
 * camera. The largest face's centre is returned as a gaze target, mirrored so
 * the face looks back at the person: step to your right and its eyes follow
 * you. Read the ref every frame; it never re-renders the page. If the
 * detector cannot load (offline, no WebGL) the ref stays null and the face
 * glances around on its own.
 */
export function useVisitorLook(video: HTMLVideoElement | null) {
  const look = useRef<Look>(null);

  useEffect(() => {
    if (!video) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let detector: { detectForVideo: (v: HTMLVideoElement, t: number) => { detections: Detection[] }; close: () => void } | null =
      null;

    void (async () => {
      try {
        const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks(VISION);
        const made = await FaceDetector.createFromOptions(files, {
          baseOptions: { modelAssetPath: MODEL, delegate: "GPU" },
          runningMode: "VIDEO",
          minDetectionConfidence: 0.5,
        });
        if (stopped) {
          made.close();
          return;
        }
        detector = made;
      } catch (error) {
        console.info("[door] face tracking unavailable; the face glances on its own", error);
        return;
      }
      let last = -1;
      timer = setInterval(() => {
        if (!detector || video.readyState < 2 || !video.videoWidth) return;
        const now = performance.now();
        if (now <= last) return;
        last = now;
        try {
          const { detections } = detector.detectForVideo(video, now);
          look.current = largest(detections, video.videoWidth, video.videoHeight);
        } catch {
          look.current = null;
        }
      }, EVERY_MS);
    })();

    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      detector?.close();
      look.current = null;
    };
  }, [video]);

  return look;
}

type Detection = { boundingBox?: { originX: number; originY: number; width: number; height: number } };

/** The biggest face is the person standing closest: its centre, mirrored, in -1…1. */
function largest(detections: Detection[], width: number, height: number): Look {
  let best: Detection["boundingBox"] | undefined;
  for (const { boundingBox: box } of detections) {
    if (box && (!best || box.width * box.height > best.width * best.height)) best = box;
  }
  if (!best) return null;
  const cx = (best.originX + best.width / 2) / width;
  const cy = (best.originY + best.height / 2) / height;
  // The camera sees the visitor un-mirrored: their right is the frame's left.
  return { x: clamp((0.5 - cx) * 2.4), y: clamp((cy - 0.45) * 2.4) };
}
