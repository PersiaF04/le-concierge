import type { Resident } from "@le-concierge/ui";

const RESIDENT_KEY = "le-concierge:resident";

/** The resident lives on this device only; there is no account to log in to. */
export function loadResident(): Resident | null {
  try {
    const raw = localStorage.getItem(RESIDENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Resident>;
    if (!parsed || typeof parsed.flat !== "string" || parsed.flat.length === 0) return null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : `local_${parsed.flat}`,
      name: typeof parsed.name === "string" ? parsed.name : undefined,
      flat: parsed.flat,
      email: typeof parsed.email === "string" ? parsed.email : undefined,
      phone: typeof parsed.phone === "string" ? parsed.phone : undefined,
      whatsapp: typeof parsed.whatsapp === "string" ? parsed.whatsapp : undefined,
      anonymous: Boolean(parsed.anonymous),
    };
  } catch {
    return null;
  }
}

export function saveResident(resident: Resident | null): void {
  try {
    if (!resident) {
      localStorage.removeItem(RESIDENT_KEY);
      return;
    }
    localStorage.setItem(RESIDENT_KEY, JSON.stringify(resident));
  } catch {
    /* private mode: the session still works, it just forgets on reload */
  }
}
