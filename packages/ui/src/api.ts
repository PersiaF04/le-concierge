/**
 * The only place the apps talk to the network.
 *
 * With VITE_API_URL set it uses the real API; without it every call falls back
 * to the recorded run, so the demo works offline and in CI. The `mode` field on
 * a visit says which of the two answered, and the UI says so out loud.
 */

import type { Decision, Parcel, Resident, Snapshot, SpeechReport, Visit } from "./types";

/**
 * Where the API is, in order of who gets the last word:
 *
 * 1. `?api=https://…` on the URL — so a deployed build can be pointed at a
 *    tunnel or a VPS without being rebuilt (the badge says "live" immediately);
 * 2. `le-concierge:api` in localStorage — the same choice, remembered;
 * 3. `VITE_API_URL` at build time — what the dev servers and CI use.
 */
const STORED_API_KEY = "le-concierge:api";

function resolveApi(): string {
  const configured = (import.meta.env.VITE_API_URL as string | undefined) ?? "";
  try {
    const fromQuery = new URLSearchParams(window.location.search).get("api");
    if (fromQuery) {
      window.localStorage.setItem(STORED_API_KEY, fromQuery);
      return fromQuery;
    }
    return window.localStorage.getItem(STORED_API_KEY) ?? configured;
  } catch {
    return configured;
  }
}

const API = resolveApi().replace(/\/$/, "");
/** Without an explicit socket URL, the API's own origin carries the socket. */
const WS =
  (import.meta.env.VITE_WS_URL as string | undefined)?.replace(/\/$/, "") ||
  (API ? API.replace(/^http/, "ws") : "");

export const apiMode: "live" | "recorded" = API ? "live" : "recorded";

/** Values from execution ebfce486…fc2f08, so the copy is true rather than invented. */
export const recordedVisit: Visit = {
  id: "visit_demo_0001",
  flat: "12",
  residentId: "res_12_persia",
  status: "pending_decision",
  at: new Date().toISOString(),
  timeoutSeconds: 60,
  transcript: "Hello, it's the delivery for flat twelve, I have a parcel for Persia.",
  confidence: 0.86,
  faceDistance: 0.31,
  reply: "Come in, 12. The door is open.",
  executionId: "ebfce486bcbe592d9a6d45b577da748845aace902e8d5b58baa8a0010afc2f08",
  parcel: { courier: "DPD", label: "FLAT 12 - HANDLE WITH CARE" },
  snapshot: null,
  mode: "mock",
};

/**
 * What `speak_reply` returned on the realtime endpoint: Voxtral streamed the
 * reply in five deltas, the first after 1.0 s, 96,044 bytes of wav in total.
 * The wav arrived peaking at -7.1 dBFS and the worker raised it to -1.0, which
 * is the +6.1 dB the door's record line quotes.
 */
export const recordedSpeech: SpeechReport = {
  model: "voxtral-mini-tts-3-0-13",
  voiceId: "voice_447",
  transport: "realtime",
  streamingMode: "responsive",
  chunks: 5,
  firstChunkMs: 1004.0,
  audioBytes: 96044,
  gainDb: 6.1,
  peakDbfs: -1.0,
  played: true,
  durationMs: 2001,
};

export const recordedParcels: Parcel[] = [
  {
    id: "parcel_demo_0001",
    flat: "12",
    courier: "DPD",
    label: "FLAT 12 - HANDLE WITH CARE",
    at: "2026-11-21T10:14:00Z",
    status: "at_desk",
  },
];

async function json<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!API) return null;
  try {
    const response = await fetch(`${API}${path}`, {
      headers: { "content-type": "application/json" },
      ...init,
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Absolute URL for a visit's wav, or null when the API kept no audio. */
export function speechAudioUrl(speech: { audioUrl?: string | null } | null | undefined): string | null {
  if (!speech?.audioUrl) return null;
  return speech.audioUrl.startsWith("http") ? speech.audioUrl : `${API ?? ""}${speech.audioUrl}`;
}

export async function fetchCurrentVisit(flat: string): Promise<Visit> {
  const visit = await json<Visit>(`/visits?flat=${encodeURIComponent(flat)}&status=pending`);
  return visit ? { ...visit, mode: "workflow" } : recordedVisit;
}

/**
 * Ask the API to start a visitor-arrival execution. This is the doorbell: the
 * button the door presses when MediaPipe sees someone (issue #3 will own it).
 */
/** Everyone waiting at any door, newest first. */
export async function fetchPendingVisits(flat?: string): Promise<Visit[]> {
  const query = flat ? `&flat=${encodeURIComponent(flat)}` : "";
  const list = await json<Visit[]>(`/visits?waiting=1${query}`);
  return (list ?? []).map((visit) => ({ ...visit, mode: "workflow" as const }));
}

export async function startArrival(input: {
  flat?: string | null;
  snapshot?: string | null;
  face?: Record<string, unknown>;
}): Promise<{ visitId: string; executionId: string | null } | null> {
  const created = await json<{ visit_id: string; execution_id: string | null }>("/arrivals", {
    method: "POST",
    body: JSON.stringify({
      flat: input.flat ?? null,
      snapshot_url: input.snapshot ?? null,
      face: input.face ?? {},
    }),
  });
  return created ? { visitId: created.visit_id, executionId: created.execution_id } : null;
}

/**
 * Send a photograph to the building. The API pushes it to the other surface
 * over /live, so the door shows what the phone just took, and vice versa.
 */
export async function publishSnapshot(input: {
  flat: string;
  dataUrl: string;
  source?: "resident-phone" | "door";
  by?: string | null;
}): Promise<boolean> {
  const response = await json<{ stored: boolean }>("/snapshots", {
    method: "POST",
    body: JSON.stringify({
      flat: input.flat,
      dataUrl: input.dataUrl,
      source: input.source ?? "resident-phone",
      by: input.by ?? null,
    }),
  });
  return Boolean(response?.stored);
}

export async function fetchSnapshot(flat: string): Promise<Snapshot | null> {
  return json<Snapshot>(`/snapshots?flat=${encodeURIComponent(flat)}`);
}

export async function sendDecision(visitId: string, decision: Decision): Promise<boolean> {
  const response = await json<{ ok: boolean }>(`/visits/${visitId}/decision`, {
    method: "POST",
    body: JSON.stringify({ decision }),
  });
  return Boolean(response?.ok);
}

export async function fetchParcels(flat: string): Promise<Parcel[]> {
  const parcels = await json<Parcel[]>(`/parcels?flat=${encodeURIComponent(flat)}`);
  return parcels ?? recordedParcels;
}

export async function registerResident(resident: Omit<Resident, "id">): Promise<Resident> {
  const created = await json<Resident>("/residents", {
    method: "POST",
    body: JSON.stringify(resident),
  });
  return created ?? { ...resident, id: `local_${resident.flat}` };
}

export async function confirmThatWasMe(residentId: string): Promise<boolean> {
  const response = await json<{ ok: boolean }>(`/residents/${residentId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ thatWasMe: true }),
  });
  return Boolean(response?.ok);
}

/** Live updates. Without a socket URL this is a no-op that reports itself as offline. */
export function openLive(
  flat: string,
  onEvent: (visit: Visit) => void,
  onSnapshot?: (snapshot: Snapshot) => void,
): { close: () => void; transport: "ws" | "none" } {
  if (!WS) return { close: () => {}, transport: "none" };
  let socket: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const connect = () => {
    if (closed) return;
    socket = new WebSocket(`${WS}/live?flat=${encodeURIComponent(flat)}`);
    socket.onmessage = (event) => {
      try {
        // The API frames every push as { type, visit | snapshot }; a bare visit
        // is still accepted so the two can change shape independently.
        const frame = JSON.parse(event.data) as {
          type?: string;
          visit?: Visit;
          snapshot?: Snapshot;
        };
        if (frame.type === "snapshot" || frame.snapshot) {
          if (frame.snapshot?.dataUrl) onSnapshot?.(frame.snapshot);
          return;
        }
        const visit = frame.visit ?? (frame as unknown as Visit);
        if (!visit?.id) return;
        onEvent(visit);
      } catch {
        /* a malformed frame is not worth dropping the socket for */
      }
    };
    socket.onclose = () => {
      if (!closed) retry = setTimeout(connect, 1500);
    };
  };
  connect();

  return {
    close: () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    },
    transport: "ws",
  };
}
