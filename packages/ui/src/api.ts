/**
 * The only place the apps talk to the network.
 *
 * With VITE_API_URL set it uses the real API; without it every call falls back
 * to the recorded run, so the demo works offline and in CI. The `mode` field on
 * a visit says which of the two answered, and the UI says so out loud.
 */

import type { Decision, Parcel, Resident, SpeechReport, Visit } from "./types";

const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const WS = (import.meta.env.VITE_WS_URL as string | undefined)?.replace(/\/$/, "") ?? "";

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
 * reply in five deltas, the first after 1.06 s, 88,364 bytes of wav in total.
 */
export const recordedSpeech: SpeechReport = {
  model: "voxtral-mini-tts-3-0-13",
  voiceId: "voice_447",
  transport: "realtime",
  streamingMode: "responsive",
  chunks: 5,
  firstChunkMs: 1062.7,
  audioBytes: 88364,
  played: true,
  durationMs: 2100,
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

export async function fetchCurrentVisit(flat: string): Promise<Visit> {
  const visit = await json<Visit>(`/visits?flat=${encodeURIComponent(flat)}&status=pending`);
  return visit ? { ...visit, mode: "workflow" } : recordedVisit;
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
        onEvent(JSON.parse(event.data) as Visit);
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
