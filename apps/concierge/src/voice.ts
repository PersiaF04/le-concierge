/**
 * The door's live conversation: a Mistral Voice Agent over WebRTC.
 *
 * The API (`POST /voice/session`) creates the session with the key, the
 * concierge's instructions, the voice and the tool declarations. The browser
 * joins it here and runs the two client-side tools:
 *
 * - `ask_resident` starts the `visitor-arrival` Workflow (`POST /arrivals`),
 *   which pushes the visit to the resident's phone, then waits on the door's
 *   `/live` feed for approved, declined or expired;
 * - `log_event` writes a line to the timeline (`POST /events`).
 */

import { functionTool } from "@mistralai/mistralai/extra/voice-agents/tools";
import { initSession } from "@mistralai/mistralai/extra/voice-agents/browser";
import * as z from "zod/v4";
import { apiBase, doorId, logDoorEvent, openLive, startArrival, type Visit } from "@le-concierge/ui";

export type Decision = "approved" | "declined" | "expired";

/** A little longer than the API's 60 s decision timeout, so the API's "expired" usually wins. */
const DECISION_WAIT_MS = 70_000;

const DONE = new Set(["approved", "declined", "expired", "fallback"]);

/** Wait on this page's own `/live?scope=door&door=<id>` feed until the visit is answered, or the wait runs out. */
export function waitForDecision(visitId: string, ms = DECISION_WAIT_MS): Promise<Decision> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (decision: Decision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      live.close();
      resolve(decision);
    };
    const live = openLive({ scope: "door", door: doorId }, (visit: Visit) => {
      if (visit.id !== visitId || !DONE.has(visit.status)) return;
      finish(visit.status === "approved" ? "approved" : visit.status === "declined" ? "declined" : "expired");
    });
    const timer = setTimeout(() => finish("expired"), ms);
  });
}

/** `POST /voice/session`; throws on any failure so the door can fall back. */
async function requestSession() {
  if (!apiBase) throw new Error("no API configured");
  const response = await fetch(`${apiBase}/voice/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ door_id: doorId }),
  });
  if (!response.ok) throw new Error(`POST /voice/session -> ${response.status}`);
  return response.json();
}

async function closeSession(id: string): Promise<void> {
  if (!apiBase) return;
  try {
    await fetch(`${apiBase}/voice/session/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch {
    /* the session expires on Mistral's side anyway */
  }
}

export interface DoorVoiceHooks {
  /** A photograph of the doorstep for the resident, if the camera has one. */
  snapshot: () => string | null;
  /** The visit `ask_resident` started, so the door can follow it. */
  onVisit?: (visitId: string) => void;
}

/** Start (but do not connect) a voice session with the door's tools. */
export async function openDoorVoice(hooks: DoorVoiceHooks) {
  const askResident = functionTool({
    name: "ask_resident",
    description: "Ring the resident of a flat and wait for them to approve or decline the visitor.",
    parameters: z.object({
      flat: z.string(),
      visitor_name: z.string(),
      reason: z.string().optional(),
    }),
    handler: async ({ flat }) => {
      // The workflow takes the flat and the photograph; the name and the reason
      // stay in the conversation (and in log_event), not in the visit.
      const created = await startArrival({ flat, snapshot: hooks.snapshot(), audio: null, doorId });
      if (!created) return { decision: "expired", note: "the resident could not be reached" };
      hooks.onVisit?.(created.visitId);
      const decision = await waitForDecision(created.visitId);
      return { decision };
    },
  });

  const logEvent = functionTool({
    name: "log_event",
    description: "Write one line to the building's visitor log.",
    parameters: z.object({ text: z.string() }),
    handler: async ({ text }) => ({ logged: await logDoorEvent(text) }),
  });

  return initSession({
    // The API owns the declarations; the ones built here only carry the handlers.
    createSession: () => requestSession(),
    deleteSession: closeSession,
    tools: [askResident, logEvent],
  });
}
