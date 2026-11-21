import { apiBase, apiMode, registerResident, type Resident } from "@le-concierge/ui";

/** What a resident sees when their flat is someone else's. Never says whose. */
export const takenMessage = (flat: string) =>
  `Flat ${flat} is already registered. If that's you, ask the building to reset it.`;

/**
 * Is this flat registered to someone? `null` when nobody can say: the recorded
 * run, or an API that does not answer. Then the app does not block anyone.
 */
export async function isFlatTaken(flat: string): Promise<boolean | null> {
  if (apiMode !== "live" || !flat) return null;
  try {
    const response = await fetch(`${apiBase}/flats/${encodeURIComponent(flat)}`);
    if (!response.ok) return null;
    const body = (await response.json()) as { taken?: unknown };
    return typeof body.taken === "boolean" ? body.taken : null;
  } catch {
    return null;
  }
}

/**
 * Register, or re-register with our own id (an edit or a flat change, which
 * frees the old flat). `{ taken: true }` when the API says the flat is someone
 * else's; offline or recorded, it falls back to a record on this device.
 */
export async function saveResident(
  details: Omit<Resident, "id">,
  ownId?: string,
): Promise<{ resident: Resident } | { taken: true }> {
  if (apiMode === "live") {
    try {
      const response = await fetch(`${apiBase}/residents`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(ownId ? { ...details, id: ownId } : details),
      });
      if (response.status === 409) return { taken: true };
      if (response.ok) return { resident: (await response.json()) as Resident };
    } catch {
      /* unreachable API: keep the resident on this device, as before */
    }
  }
  return { resident: await registerResident(details) };
}
