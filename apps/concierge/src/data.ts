/**
 * Today's log, drawn from the runs that actually happened in Mistral Studio.
 * Timings and distances are the measured ones, not placeholders.
 */
import type { VisitStatus } from "@le-concierge/ui";

export interface LedgerRow {
  id: string;
  at: string;
  flat: string;
  who: string;
  status: VisitStatus;
  /** Seconds the workflow waited for the resident, or 0 when it never had to. */
  waitSeconds: number;
  transcript: string;
  reply: string;
  confidence: number;
  faceDistance: number | null;
  parcel?: string;
  executionId?: string;
  note?: string;
}

export const LEDGER_ROWS: LedgerRow[] = [
  {
    id: "visit_demo_0001",
    at: "14:32",
    flat: "12",
    who: "Courier, DPD",
    status: "pending_decision",
    waitSeconds: 0,
    transcript: "Hello, it's the delivery for flat twelve, I have a parcel for Persia.",
    reply: "Come in, 12. The door is open.",
    confidence: 0.86,
    faceDistance: 0.31,
    parcel: "DPD · FLAT 12 - HANDLE WITH CARE",
    executionId: "ebfce486…fc2f08",
    note: "Parcel read from the label, then the face — the label decided the flat.",
  },
  {
    id: "visit_demo_0002",
    at: "10:14",
    flat: "4",
    who: "Courier, Royal Mail",
    status: "approved",
    waitSeconds: 11,
    transcript: "Morning, signed for delivery for number four, I need a signature.",
    reply: "Come up, 4. Take the lift, second floor.",
    confidence: 0.79,
    faceDistance: 0.44,
    parcel: "Royal Mail · SIGNED FOR · FLAT 4",
    executionId: "703c9ac2…b1e4d7",
    note: "Known courier, unknown face. The resident signed in 11 seconds.",
  },
  {
    id: "visit_demo_0003",
    at: "09:02",
    flat: "12",
    who: "Unmatched",
    status: "expired",
    waitSeconds: 60,
    transcript: "Hello? I'm here for the viewing, they said to ring flat twelve.",
    reply: "Nobody answered in this flat. Please try again, or ring the front desk.",
    confidence: 0.41,
    faceDistance: null,
    note: "No face on record and nobody answered, so the door stayed shut.",
  },
  {
    id: "visit_demo_0004",
    at: "08:07",
    flat: "12",
    who: "Persia, flat 12",
    status: "approved",
    waitSeconds: 0,
    transcript: "It's me, I forgot my keys again.",
    reply: "Come in, 12.",
    confidence: 0.93,
    faceDistance: 0.21,
    note: "Face opened it on its own. The log keeps the entry anyway.",
  },
];

export type Filter = "all" | "pending" | "answered";

export function matchesFilter(row: LedgerRow, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "pending") return row.status === "pending_decision";
  return row.status !== "pending_decision";
}

/** The door's photograph, kept in this browser so both surfaces can show it. */
const SHOT_KEY = "le-concierge:door-shot";

export function loadDoorShot(): string | null {
  try {
    return localStorage.getItem(SHOT_KEY);
  } catch {
    return null;
  }
}

export function saveDoorShot(data: string | null): void {
  try {
    if (data) localStorage.setItem(SHOT_KEY, data);
    else localStorage.removeItem(SHOT_KEY);
  } catch {
    /* a full quota should not break the door */
  }
}
