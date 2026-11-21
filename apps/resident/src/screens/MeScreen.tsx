import { useState } from "react";
import { confirmThatWasMe, useWebcam, type Resident } from "@le-concierge/ui";

export default function MeScreen({
  resident,
  onUpdate,
  onForget,
}: {
  resident: Resident;
  onUpdate: (resident: Resident) => void;
  onForget: () => void;
}) {
  const camera = useWebcam();
  const [status, setStatus] = useState<string | null>(null);
  const [name, setName] = useState(resident.name ?? "");
  const [whatsapp, setWhatsapp] = useState(resident.whatsapp ?? "");

  async function enrol() {
    const shot = camera.shot ?? camera.capture();
    if (!shot) {
      setStatus("No frame yet — start the camera and look at it first.");
      return;
    }
    const ok = await confirmThatWasMe(resident.id);
    setStatus(
      ok
        ? "Face saved. This is the portrait the door will match against."
        : "Held on this device only — the face record is not wired to the workflow yet.",
    );
    camera.stop();
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
          onSubmit={(event) => {
            event.preventDefault();
            onUpdate({
              ...resident,
              name: name.trim() || undefined,
              whatsapp: whatsapp.trim() || undefined,
              anonymous: !name.trim() && !whatsapp.trim() ? resident.anonymous : false,
            });
            setStatus("Saved on this device.");
          }}
        >
          <div className="field">
            <label htmlFor="me-name">Name</label>
            <input id="me-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="me-whatsapp">WhatsApp</label>
            <input id="me-whatsapp" value={whatsapp} onChange={(event) => setWhatsapp(event.target.value)} />
          </div>
          <button type="submit" className="btn-quiet full">
            Save
          </button>
        </form>
      </section>

      <section className="block">
        <h3>Face record</h3>
        <div className="portrait">
          {camera.shot ? (
            <img src={camera.shot} alt="The portrait you just took" />
          ) : camera.state === "live" ? (
            <video ref={camera.attach} muted playsInline />
          ) : (
            <div className="shot-empty" aria-hidden="true">
              <span className="mono small">portrait — none yet</span>
            </div>
          )}
        </div>
        <div className="sign-actions">
          {camera.state !== "live" ? (
            <button type="button" className="btn-quiet" onClick={() => void camera.start()}>
              {camera.state === "asking" ? "asking for the camera…" : "Use the camera"}
            </button>
          ) : null}
          {camera.state === "live" ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                camera.capture();
              }}
            >
              Take the portrait
            </button>
          ) : null}
          {camera.shot ? (
            <button type="button" className="btn-quiet" onClick={() => void enrol()}>
              Save this face
            </button>
          ) : null}
        </div>
        {camera.state === "denied" ? (
          <p className="small muted">Camera refused — you can still stay anonymous and answer at the door.</p>
        ) : null}
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
          onClick={() => {
            camera.stop();
            onForget();
          }}
        >
          Forget this device
        </button>
      </section>
    </div>
  );
}
