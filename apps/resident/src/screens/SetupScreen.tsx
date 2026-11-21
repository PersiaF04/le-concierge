import { useRef, useState } from "react";
import type { Resident } from "@le-concierge/ui";
import { isFlatTaken, saveResident, takenMessage } from "../flats";

/**
 * No sign-in: a flat number is the only thing the intercom ever needs, and the
 * rest is optional because it is what the workflow would use to reach you.
 */
export default function SetupScreen({ onDone }: { onDone: (resident: Resident) => void }) {
  const [flat, setFlat] = useState("");
  const current = useRef("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The flat the API said is someone else's; saving waits for another one.
  const [taken, setTaken] = useState<string | null>(null);

  async function check(value: string) {
    const cleaned = value.trim();
    // An answer for a flat the resident has since changed is ignored.
    if (cleaned && (await isFlatTaken(cleaned)) && current.current.trim() === cleaned) {
      setTaken(cleaned);
      setError(takenMessage(cleaned));
    }
  }

  async function submit(anonymous: boolean) {
    const cleaned = flat.trim();
    if (!cleaned) {
      setError("A flat number is what the door matches on.");
      return;
    }
    if (taken === cleaned) return;
    setBusy(true);
    const saved = await saveResident({
      flat: cleaned,
      name: anonymous ? undefined : name.trim() || undefined,
      email: anonymous ? undefined : email.trim() || undefined,
      phone: anonymous ? undefined : phone.trim() || undefined,
      whatsapp: anonymous ? undefined : whatsapp.trim() || undefined,
      anonymous,
    });
    setBusy(false);
    if ("taken" in saved) {
      setTaken(cleaned);
      setError(takenMessage(cleaned));
      return;
    }
    onDone(saved.resident);
  }

  return (
    <div className="setup">
      <div className="setup-lede">
        <h1>Your door, answered from your pocket.</h1>
        <p className="muted">
          The intercom describes who is downstairs, reads their parcel, and waits for your signature
          before it opens. Nothing here is an account — this stays on this device.
        </p>
      </div>

      <form
        className="setup-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(false);
        }}
      >
        <div className="field">
          <label htmlFor="flat">Flat</label>
          <input
            id="flat"
            name="flat"
            inputMode="numeric"
            autoComplete="off"
            placeholder="your flat"
            value={flat}
            onChange={(event) => {
              setFlat(event.target.value);
              current.current = event.target.value;
              setError(null);
              setTaken(null);
            }}
            onBlur={(event) => void check(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "flat-error" : undefined}
            required
          />
        </div>
        {error ? (
          <p className="small setup-error" id="flat-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="field">
          <label htmlFor="name">Name (optional)</label>
          <input id="name" autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>

        <div className="setup-pair">
          <div className="field">
            <label htmlFor="email">Email (optional)</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="phone">Phone (optional)</label>
            <input
              id="phone"
              type="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="whatsapp">WhatsApp (optional)</label>
          <input id="whatsapp" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} />
        </div>

        <div className="setup-actions">
          <button type="submit" className="btn" disabled={busy || taken !== null}>
            Continue <span className="mono small">→</span>
          </button>
          <button type="button" className="btn-quiet" disabled={busy || taken !== null} onClick={() => void submit(true)}>
            Continue anonymously
          </button>
        </div>

        <p className="small muted setup-note">
          Anonymous means the intercom still works: it will match the flat, not you, and it will not
          keep a name.
        </p>
      </form>
    </div>
  );
}
