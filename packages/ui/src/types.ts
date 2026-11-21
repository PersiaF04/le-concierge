/** Types shared by the resident, door and admin surfaces. */

export type VisitStatus =
  | "arriving"
  | "pending_decision"
  | "approved"
  | "declined"
  | "expired"
  | "fallback";

export type Decision = "approve" | "decline";

export interface Visit {
  id: string;
  flat: string;
  residentId: string | null;
  status: VisitStatus;
  /** ISO timestamp of the first activity. */
  at: string;
  /** Seconds the workflow will wait before the door stays shut. */
  timeoutSeconds: number;
  transcript: string;
  /** Le Chonk's confidence that this is the right flat. */
  confidence: number;
  /** face-api.js descriptor distance; null when nobody was matched. */
  faceDistance: number | null;
  reply: string;
  executionId?: string | null;
  parcel?: { courier: string; label: string } | null;
  snapshot?: string | null;
  decidedAt?: string | null;
  /** What the door said, attached by the API from the speak_reply activity. */
  speech?: VisitSpeech | null;
  mode: "workflow" | "mock";
}

export interface VisitSpeech {
  text: string;
  model: string | null;
  voiceId: string | null;
  transport: string | null;
  streamingMode?: string | null;
  chunks: number | null;
  firstChunkMs: number | null;
  audioBytes: number | null;
  played: boolean;
  durationMs: number | null;
  at?: string;
}

export interface Parcel {
  id: string;
  flat: string;
  courier: string;
  label: string;
  at: string;
  status: "at_desk" | "collected";
}

export interface Resident {
  id: string;
  name?: string;
  flat: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  anonymous: boolean;
}

/**
 * What the `speak_reply` activity returns, as Mistral Studio shows it.
 *
 * `transport` says whether the audio arrived as realtime deltas over the
 * websocket or as one batch file, so the door never claims more than happened.
 */
export interface SpeechReport {
  model: string;
  voiceId: string;
  transport: "realtime" | "batch";
  streamingMode?: string;
  chunks: number;
  firstChunkMs: number | null;
  audioBytes: number;
  played: boolean;
  durationMs: number;
}
