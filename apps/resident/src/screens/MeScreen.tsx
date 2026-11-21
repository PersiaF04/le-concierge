import { useRef, useState } from "react";
import type { Resident } from "@le-concierge/ui";
import { isFlatTaken, saveResident, takenMessage } from "../flats";

export default function MeScreen({
  resident,
  onUpdate,
  onForget,
}: {
  resident: Resident;
  onUpdate: (resident: Resident) => void;
  onForget: () => void;
}) {
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState(resident.name ?? "");
  const [whatsapp, setWhatsapp] = useState(resident.whatsapp ?? "");
  const [flat, setFlat] = useState(resident.flat);
  const current = useRef(resident.flat);
  // A flat the API said is someone else's; saving waits for another one.
  const [taken, setTaken] = useState<string | null>(null);

  async function check(value: string) {
    const cleaned = value.trim();
    if (!cleaned || cleaned === resident.flat) return;
    if ((await isFlatTaken(cleaned)) && current.current.trim() === cleaned) setTaken(cleaned);
  }

  return (
    <div className="screen">
      <header className="screen-head">
        <h2>Your details</h2>
        <p className="muted small">
          {resident.anonymous
            ? "Anonymous. The door knows the flat, not you."
            : `Flat ${resident.flat} · known to the door`}
        </p>
      </header>

      <section className="block">
        <h3>How the door reaches you</h3>
        <div className="facts">
          <div className="record-line">
            <span>flat</span>
            <b>{resident.flat}</b>
          </div>
          <div className="record-line">
            <span>email</span>
            <b>{resident.email ?? "not given"}</b>
          </div>
          <div className="record-line">
            <span>phone</span>
            <b>{resident.phone ?? "not given"}</b>
          </div>
          <div className="record-line">
            <span>whatsapp</span>
            <b>{resident.whatsapp ?? "not given"}</b>
          </div>
        </div>
        <p className="small muted">
          A verified face opens the door on its own. Everything else — a parcel, a stranger — waits for
          your signature here.
        </p>
      </section>

      <section className="block">
        <h3>Add or correct a detail</h3>
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const next: Resident = {
              ...resident,
              name: name.trim() || undefined,
              whatsapp: whatsapp.trim() || undefined,
              anonymous: !name.trim() && !whatsapp.trim() ? resident.anonymous : false,
            };
            const newFlat = flat.trim();
            if (newFlat && newFlat !== resident.flat) {
              if (taken === newFlat) return;
              // Moving re-registers under our own id, which frees the old
              // flat; the visit screen then subscribes to the new one.
              const { id, ...details } = next;
              const saved = await saveResident(
                { ...details, flat: newFlat, anonymous: details.anonymous || !details.name },
                id,
              );
              if ("taken" in saved) {
                setTaken(newFlat);
                return;
              }
              onUpdate(saved.resident);
            } else {
              onUpdate(next);
            }
            setStatus("Saved on this device.");
          }}
        >
          <div className="field">
            <label htmlFor="me-flat">Flat</label>
            <input
              id="me-flat"
              value={flat}
              autoComplete="off"
              onChange={(event) => {
                setFlat(event.target.value);
                current.current = event.target.value;
                setTaken(null);
              }}
              onBlur={(event) => void check(event.target.value)}
              aria-invalid={taken ? true : undefined}
              aria-describedby={taken ? "me-flat-error" : undefined}
            />
          </div>
          {taken ? (
            <p className="small setup-error" id="me-flat-error" role="alert">
              {takenMessage(taken)}
            </p>
          ) : null}
          <div className="field">
            <label htmlFor="me-name">Name</label>
            <input id="me-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="me-whatsapp">WhatsApp</label>
            <input id="me-whatsapp" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} />
          </div>
          <button type="submit" className="btn-quiet full" disabled={taken !== null}>
            Save
          </button>
        </form>
      </section>

      {status ? (
        <p className="small notice" role="status">
          {status}
        </p>
      ) : null}

      <section className="block block-end">
        <h3>This device</h3>
        <p className="small muted">
          No account and no password: your details sit in this browser only. Forgetting removes them
          here; the door keeps its own log of visits for the building.
        </p>
        <button
          type="button"
          className="btn-ghost small danger"
          onClick={onForget}
        >
          Forget this device
        </button>
      </section>
    </div>
  );
}
